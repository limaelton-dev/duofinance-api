import { Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { ExternalLiabilitySettlementRepository } from '../../../application/ports/private/external-liability-settlement.ports.js';
import type { SettleExternalLiabilityCommand } from '../../../application/models/external-liability-settlement.js';
import type {
    FinancialCommitment,
    ExpenseVersion,
} from '../../../domain/shared-expense/financial-commitment.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import {
    FinancialCommitmentOrmEntity,
    FinancialExternalLiabilityOrmEntity,
} from '../entities/shared-expense.orm-entity.js';
import { FinancialExternalLiabilitySettlementOrmEntity } from '../entities/external-liability-settlement.orm-entity.js';
@Injectable()
export class TypeOrmExternalLiabilitySettlementRepository implements ExternalLiabilitySettlementRepository {
    constructor(private readonly provider: EntityManagerProvider) {}
    async findHolder(
        spaceId: string,
        commitmentId: string,
        externalLiabilityId: string,
    ) {
        const rows: {
            holderMemberId: string | null;
            holderPersonId: string | null;
            personalOwnerPersonId: string | null;
        }[] = await this.provider
            .get()
            .query(
                `SELECT f.holder_member_id AS "holderMemberId", f.holder_person_id AS "holderPersonId", c.personal_owner_person_id AS "personalOwnerPersonId" FROM financial_external_liabilities f JOIN financial_commitments c ON c.space_id=f.space_id AND c.id=f.commitment_id WHERE f.space_id=$1 AND f.commitment_id=$2 AND f.id=$3 AND c.kind='EXPENSE'`,
                [spaceId, commitmentId, externalLiabilityId],
            );
        return rows[0] ?? null;
    }
    async saveExternalLiabilitySettlement(
        c: FinancialCommitment<ExpenseVersion>,
        command: SettleExternalLiabilityCommand,
    ) {
        const m = this.provider.get();
        if (!m.queryRunner?.isTransactionActive)
            throw new Error('External settlement requires a transaction');
        const updated = await m.update(
            FinancialCommitmentOrmEntity,
            {
                id: c.id,
                spaceId: c.spaceId,
                version: command.expectedCommitmentVersion,
                kind: 'EXPENSE',
            },
            { version: c.version },
        );
        if (updated.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        const liability = c.externalLiabilities.find(
            (f) => f.id === command.externalLiabilityId,
        )!;
        const settlement = liability.settlements!.at(-1)!;
        await m.insert(FinancialExternalLiabilitySettlementOrmEntity, {
            ...settlement,
            spaceId: c.spaceId,
            commitmentId: c.id,
            holderMemberId: settlement.holderMemberId ?? null,
            holderPersonId: settlement.holderPersonId ?? null,
            receiptOperation: 'SETTLE_EXTERNAL_LIABILITY',
            idempotencyKey: command.idempotencyKey,
            registeredAt: new Date(settlement.registeredAt),
        });
        const changed = await m.update(
            FinancialExternalLiabilityOrmEntity,
            {
                id: liability.id,
                spaceId: c.spaceId,
                commitmentId: c.id,
                remainingAmountInCents:
                    liability.remainingAmountInCents + settlement.amountInCents,
            },
            { remainingAmountInCents: liability.remainingAmountInCents },
        );
        if (changed.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
    }
    async listOpen(
        spaceId: string,
        holder: { personId: string } | { memberId: string },
        after: { targetDate: string; id: string } | null,
    ) {
        // One statement gives a coherent page of version, balance and history.
        return this.provider.get().query(
            `
            SELECT c.id AS "commitmentId",c.version AS "commitmentVersion",c.description,
                jsonb_strip_nulls(jsonb_build_object(
                    'id',f.id,'sequence',f.sequence,'holderMemberId',f.holder_member_id,'holderPersonId',f.holder_person_id,
                    'amountInCents',f.amount_in_cents,'remainingAmountInCents',f.remaining_amount_in_cents,
                    'factDate',f.fact_date,'registeredAt',to_char(f.registered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                    'recordedByPersonId',f.recorded_by_person_id,'settlements',COALESCE((
                        SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                            'id',s.id,'externalLiabilityId',s.external_liability_id,'sequence',s.sequence,
                            'holderMemberId',s.holder_member_id,'holderPersonId',s.holder_person_id,
                            'amountInCents',s.amount_in_cents,'factDate',s.fact_date,
                            'registeredAt',to_char(s.registered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                            'recordedByPersonId',s.recorded_by_person_id)) ORDER BY s.sequence)
                        FROM financial_external_liability_settlements s WHERE s.space_id=f.space_id AND s.commitment_id=f.commitment_id AND s.external_liability_id=f.id
                    ),'[]'::jsonb))) AS "externalLiability"
            FROM financial_external_liabilities f JOIN financial_commitments c ON c.space_id=f.space_id AND c.id=f.commitment_id
            WHERE f.space_id=$1 AND ${'memberId' in holder ? 'f.holder_member_id' : 'f.holder_person_id'}=$2 AND f.remaining_amount_in_cents>0
                AND ($3::date IS NULL OR (f.fact_date,f.id)<($3::date,$4::uuid))
            ORDER BY f.fact_date DESC,f.id DESC LIMIT 21`,
            [
                spaceId,
                'memberId' in holder ? holder.memberId : holder.personId,
                after?.targetDate ?? null,
                after?.id ?? null,
            ],
        );
    }
}
