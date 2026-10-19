import { Injectable } from '@nestjs/common';
import { assertFinancialClosureOriginOpen } from './assert-financial-closure-origin-open.js';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type {
    NonRecurringChangeRepository,
    NonRecurringChangeState,
} from '../../../application/ports/private/non-recurring-change.repository.js';
import type { NonRecurringEconomicVersion } from '../../../domain/changes/non-recurring-version.js';
import type { EconomicShare } from '../../../domain/shared-expense/responsibility-split.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import { FinancialCommitmentOrmEntity } from '../entities/shared-expense.orm-entity.js';
import { FinancialNonRecurringVersionOrmEntity } from '../entities/non-recurring-version.orm-entity.js';
import {
    FinancialCommitmentAdjustmentOrmEntity,
    FinancialCommitmentCancellationOrmEntity,
} from '../entities/financial-correction.orm-entity.js';
import { applyFinancialAdjustments } from '../queries/financial-correction-projection.js';

@Injectable()
export class TypeOrmNonRecurringChangeRepository implements NonRecurringChangeRepository {
    constructor(private readonly managers: EntityManagerProvider) {}

    snapshot<T>(work: () => Promise<T>) {
        return this.managers.readSnapshot(work);
    }

    async read(
        spaceId: string,
        commitmentId: string,
        effectiveFrom: string,
        lock: boolean,
    ): Promise<NonRecurringChangeState | null> {
        const manager = this.managers.get();
        const query = manager
            .createQueryBuilder(FinancialCommitmentOrmEntity, 'c')
            .where(
                'c.space_id=:spaceId AND c.id=:commitmentId AND c.modality IN (:...modalities)',
                {
                    spaceId,
                    commitmentId,
                    modalities: ['ONE_TIME', 'INSTALLMENT'],
                },
            );
        if (lock) query.setLock('pessimistic_write');
        const root = await query.getOne();
        if (!root) return null;
        const history = await manager.find(
            FinancialNonRecurringVersionOrmEntity,
            {
                where: { spaceId, commitmentId },
                order: { version: 'ASC', targetId: 'ASC' },
            },
        );
        type Target = {
            id: string;
            due_date: string | null;
            amount: string;
            shares: EconomicShare[] | null;
            state_version: number;
            fulfilled: string;
            resolved: boolean;
        };
        const rows: Target[] = await manager.query(
            root.modality === 'INSTALLMENT'
                ? `SELECT i.id,i.due_date::text,i.amount_in_cents::text AS amount,o.state_version,
                (SELECT jsonb_agg(jsonb_build_object('memberId',s.member_id,'amountInCents',s.amount_in_cents) ORDER BY s.member_id) FROM financial_installment_shares s WHERE s.installment_id=i.id) AS shares,
                (COALESCE((SELECT SUM(d.amount_in_cents) FROM financial_disbursements d WHERE d.space_id=i.space_id AND d.occurrence_id=i.id),0)+COALESCE((SELECT SUM(l.amount_in_cents) FROM financial_external_liabilities l WHERE l.space_id=i.space_id AND l.occurrence_id=i.id),0))::text AS fulfilled,
                EXISTS (SELECT 1 FROM financial_installment_resolutions r WHERE r.installment_id=i.id) OR EXISTS (SELECT 1 FROM financial_installment_anticipations a WHERE a.installment_id=i.id) AS resolved
                FROM financial_installments i JOIN financial_occurrences o ON o.space_id=i.space_id AND o.commitment_id=i.commitment_id AND o.installment_id=i.id WHERE i.space_id=$1 AND i.commitment_id=$2 ORDER BY i.position`
                : root.kind === 'EXPENSE'
                  ? `SELECT v.commitment_id AS id,v.expected_payment_date::text AS due_date,v.amount_in_cents::text AS amount,1 AS state_version,
                    (SELECT jsonb_agg(jsonb_build_object('memberId',s.member_id,'amountInCents',s.amount_in_cents) ORDER BY s.member_id) FROM financial_commitment_shares s WHERE s.space_id=v.space_id AND s.commitment_id=v.commitment_id AND s.version=1) AS shares,
                    (COALESCE((SELECT SUM(d.amount_in_cents) FROM financial_disbursements d WHERE d.space_id=v.space_id AND d.commitment_id=v.commitment_id),0)+COALESCE((SELECT SUM(l.amount_in_cents) FROM financial_external_liabilities l WHERE l.space_id=v.space_id AND l.commitment_id=v.commitment_id),0))::text AS fulfilled,false AS resolved FROM financial_commitment_versions v WHERE v.space_id=$1 AND v.commitment_id=$2 AND v.version=1`
                  : `SELECT v.commitment_id AS id,v.expected_receipt_date::text AS due_date,v.amount_in_cents::text AS amount,1 AS state_version,
                    (SELECT jsonb_agg(jsonb_build_object('memberId',s.member_id,'amountInCents',s.amount_in_cents) ORDER BY s.member_id) FROM financial_income_shares s WHERE s.space_id=v.space_id AND s.commitment_id=v.commitment_id) AS shares,
                    COALESCE((SELECT SUM(r.amount_in_cents) FROM financial_receipts r WHERE r.space_id=v.space_id AND r.commitment_id=v.commitment_id),0)::text AS fulfilled,false AS resolved FROM financial_income_versions v WHERE v.space_id=$1 AND v.commitment_id=$2`,
            [spaceId, commitmentId],
        );
        const factDates: { target_id: string; first_date: string }[] =
            await manager.query(
                `SELECT target_id,MIN(fact_date)::text AS first_date FROM (
            SELECT COALESCE(occurrence_id,commitment_id) AS target_id,fact_date FROM financial_disbursements WHERE space_id=$1 AND commitment_id=$2
            UNION ALL SELECT COALESCE(occurrence_id,commitment_id),fact_date FROM financial_external_liabilities WHERE space_id=$1 AND commitment_id=$2
            UNION ALL SELECT COALESCE(occurrence_id,commitment_id),fact_date FROM financial_receipts WHERE space_id=$1 AND commitment_id=$2
            UNION ALL SELECT installment_id,fact_date FROM financial_installment_resolutions WHERE space_id=$1 AND commitment_id=$2
        ) facts GROUP BY target_id`,
                [spaceId, commitmentId],
            );
        const correctionRows = await manager.find(
            FinancialCommitmentAdjustmentOrmEntity,
            {
                where: { spaceId, commitmentId },
                order: { commitmentVersion: 'ASC' },
            },
        );
        const cancellation = await manager.findOneBy(
            FinancialCommitmentCancellationOrmEntity,
            { spaceId, commitmentId },
        );
        return {
            id: root.id,
            spaceId,
            kind: root.kind as 'EXPENSE' | 'INCOME',
            modality: root.modality as 'ONE_TIME' | 'INSTALLMENT',
            version: root.version,
            description: root.description,
            ownerPersonId: root.personalOwnerPersonId,
            targets: rows.map((row) => {
                const firstDate = factDates.find(
                    (item) => item.target_id === row.id,
                )?.first_date;
                const date =
                    firstDate && firstDate < effectiveFrom
                        ? firstDate
                        : effectiveFrom;
                const selected = history
                    .filter(
                        (version) =>
                            version.targetId === row.id &&
                            version.effectiveFrom <= date,
                    )
                    .at(-1);
                const adjustments = correctionRows
                    .filter((correction) => correction.targetId === row.id)
                    .map((correction) => ({
                        ...correction,
                        registeredAt: correction.registeredAt.toISOString(),
                    }));
                const corrected = applyFinancialAdjustments(
                    selected?.amountInCents ?? Number(row.amount),
                    selected?.economicShares ?? row.shares,
                    adjustments,
                    selected?.version ?? 1,
                );
                return {
                    id: row.id,
                    dueDate: row.due_date,
                    originalAmountInCents: Number(row.amount),
                    amountInCents: corrected.amountInCents,
                    economicShares: corrected.economicShares,
                    originalEconomicShares: row.shares,
                    economicVersion: selected?.version ?? 1,
                    fulfilledAmountInCents: Number(row.fulfilled),
                    stateVersion: row.state_version,
                    resolved: row.resolved || cancellation !== null,
                };
            }),
            versions: history.map((version) => ({
                ...version,
                registeredAt: version.registeredAt.toISOString(),
            })),
        };
    }

    async save(
        state: NonRecurringChangeState,
        versions: readonly NonRecurringEconomicVersion[],
    ) {
        const manager = this.managers.get();
        if (!manager.queryRunner?.isTransactionActive)
            throw new Error('Economic version writes require a transaction');
        for (const version of versions)
            await assertFinancialClosureOriginOpen(
                manager,
                state.spaceId,
                state.id,
                version.targetId,
                version.effectiveFrom,
            );
        const updated = await manager.update(
            FinancialCommitmentOrmEntity,
            { id: state.id, spaceId: state.spaceId, version: state.version },
            { version: state.version + 1 },
        );
        if (updated.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        await manager.insert(
            FinancialNonRecurringVersionOrmEntity,
            versions.map((version) => ({
                ...version,
                registeredAt: new Date(version.registeredAt),
            })),
        );
    }
}
