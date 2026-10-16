import { Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { InterMemberObligationRepository } from '../../../application/ports/private/shared-expense.repositories.js';
import type { FulfillmentObligationView } from '../../../application/models/fulfillment-obligation.js';
import type { OriginSettlement } from '../../../domain/shared-expense/obligation-reconciler.js';
import { InterMemberObligation } from '../../../domain/shared-expense/inter-member-obligation.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import {
    obligationChangeRow,
    obligationRow,
} from '../../mappers/shared-expense.mapper.js';
import {
    InterMemberObligationChangeOrmEntity,
    InterMemberObligationOrmEntity,
} from '../entities/shared-expense.orm-entity.js';
function transaction(provider: EntityManagerProvider) {
    const manager = provider.get();
    if (!manager.queryRunner?.isTransactionActive)
        throw new Error('Expense writes require a transaction');
    return manager;
}
@Injectable()
export class TypeOrmInterMemberObligationRepository implements InterMemberObligationRepository {
    constructor(private readonly provider: EntityManagerProvider) {}
    async save(o: InterMemberObligation): Promise<void> {
        const m = transaction(this.provider);
        await m.insert(InterMemberObligationOrmEntity, obligationRow(o));
        await m.insert(
            InterMemberObligationChangeOrmEntity,
            obligationChangeRow(o),
        );
    }
    async originState(spaceId: string, commitmentId: string, lock = false) {
        const m = transaction(this.provider);
        if (lock) {
            const cycles: { id: string }[] = await m.query(
                `SELECT DISTINCT cycle_id AS id FROM inter_member_obligations WHERE space_id=$1 AND commitment_id=$2 AND cycle_id IS NOT NULL ORDER BY cycle_id`,
                [spaceId, commitmentId],
            );
            for (const cycle of cycles)
                await m.query(
                    `SELECT id FROM settlement_cycles WHERE space_id=$1 AND id=$2 FOR SHARE`,
                    [spaceId, cycle.id],
                );
        }
        const query = m
            .createQueryBuilder(InterMemberObligationOrmEntity, 'o')
            .where('o.space_id=:spaceId AND o.commitment_id=:commitmentId', {
                spaceId,
                commitmentId,
            })
            .orderBy('o.id', 'ASC');
        if (lock) query.setLock('pessimistic_write');
        const rows = await query.getMany();
        const obligations: InterMemberObligation[] = [];
        for (const o of rows) {
            const changes = await m.find(InterMemberObligationChangeOrmEntity, {
                where: { spaceId, obligationId: o.id },
                order: { version: 'ASC' },
            });
            obligations.push(
                new InterMemberObligation(
                    o.id,
                    o.spaceId,
                    o.commitmentId,
                    o.disbursementId ?? o.receiptId ?? o.externalLiabilityId!,
                    o.debtorMemberId,
                    o.creditorMemberId,
                    o.originalAmountInCents,
                    o.cycleId,
                    o.factDate,
                    o.registeredAt.toISOString(),
                    changes[0].actorId,
                    o.remainingAmountInCents,
                    o.version,
                    changes
                        .filter((c) => c.allocationId !== null)
                        .map((c) => c.allocationId!),
                    o.receiptId ? 'INCOME' : 'EXPENSE',
                    o.recognizedAmountInCents,
                    o.status === 'RECONCILED',
                    null,
                    o.externalLiabilityId,
                ),
            );
        }
        const chronology: { id: string }[] = await m.query(
            `SELECT o.id FROM inter_member_obligations o LEFT JOIN financial_disbursements d ON d.space_id=o.space_id AND d.commitment_id=o.commitment_id AND d.id=o.disbursement_id LEFT JOIN financial_receipts r ON r.space_id=o.space_id AND r.commitment_id=o.commitment_id AND r.id=o.receipt_id LEFT JOIN financial_external_liabilities e ON e.space_id=o.space_id AND e.commitment_id=o.commitment_id AND e.id=o.external_liability_id WHERE o.space_id=$1 AND o.commitment_id=$2 ORDER BY COALESCE(d.sequence,r.sequence,e.sequence),o.id`,
            [spaceId, commitmentId],
        );
        const order = new Map(chronology.map((row, index) => [row.id, index]));
        obligations.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
        const settlements: OriginSettlement[] = await m.query(
            `SELECT t.payer_member_id AS "payerMemberId",t.recipient_member_id AS "recipientMemberId",a.amount_in_cents::text AS "amountInCents" FROM settlement_allocations a JOIN settlement_transfers t ON t.space_id=a.space_id AND t.id=a.transfer_id JOIN inter_member_obligations o ON o.space_id=a.space_id AND o.id=a.obligation_id WHERE o.space_id=$1 AND o.commitment_id=$2
            UNION ALL
            SELECT o.debtor_member_id AS "payerMemberId",o.creditor_member_id AS "recipientMemberId",ch.snapshot->>'appliedAmountInCents' AS "amountInCents" FROM inter_member_obligation_changes ch JOIN inter_member_obligations o ON o.space_id=ch.space_id AND o.id=ch.obligation_id WHERE o.space_id=$1 AND o.commitment_id=$2 AND ch.type='OFFSET_APPLIED'`,
            [spaceId, commitmentId],
        );
        return {
            obligations,
            settlements: settlements.map((s) => ({
                ...s,
                amountInCents: Number(s.amountInCents),
            })),
        };
    }
    lockOrigin(spaceId: string, commitmentId: string) {
        return this.originState(spaceId, commitmentId, true);
    }
    async saveReconciliation(
        before: InterMemberObligation,
        after: InterMemberObligation,
    ): Promise<void> {
        const m = transaction(this.provider);
        const changed = await m.update(
            InterMemberObligationOrmEntity,
            { id: before.id, spaceId: before.spaceId, version: before.version },
            {
                recognizedAmountInCents: after.recognizedAmountInCents,
                remainingAmountInCents: after.remainingAmountInCents,
                status: after.status,
                version: after.version,
            },
        );
        if (changed.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        const event = after.reconciliation!;
        await m.insert(InterMemberObligationChangeOrmEntity, {
            obligationId: after.id,
            spaceId: after.spaceId,
            version: after.version,
            type: 'RECONCILED',
            allocationId: null,
            actorId: event.actorId,
            registeredAt: new Date(event.registeredAt),
            snapshot: { ...event },
        });
    }
    async history(
        spaceId: string,
        commitmentId: string,
    ): Promise<FulfillmentObligationView[]> {
        const m = this.provider.get();
        const rows = await m
            .createQueryBuilder(InterMemberObligationOrmEntity, 'o')
            .leftJoin(
                'financial_disbursements',
                'd',
                'd.space_id=o.space_id AND d.commitment_id=o.commitment_id AND d.id=o.disbursement_id',
            )
            .leftJoin(
                'financial_receipts',
                'r',
                'r.space_id=o.space_id AND r.commitment_id=o.commitment_id AND r.id=o.receipt_id',
            )
            .leftJoin(
                'financial_external_liabilities',
                'e',
                'e.space_id=o.space_id AND e.commitment_id=o.commitment_id AND e.id=o.external_liability_id',
            )
            .where('o.space_id=:spaceId AND o.commitment_id=:commitmentId', {
                spaceId,
                commitmentId,
            })
            .orderBy('COALESCE(d.sequence,r.sequence,e.sequence)', 'ASC')
            .addOrderBy('o.id', 'ASC')
            .getMany();
        const applications: {
            id: string;
            transferred: string;
            compensated: string;
        }[] = await m.query(
            `WITH applications AS (
                SELECT obligation_id,amount_in_cents,'TRANSFER' AS kind FROM settlement_allocations WHERE space_id=$1
                UNION ALL
                SELECT obligation_id,(snapshot->>'appliedAmountInCents')::bigint AS amount_in_cents,'OFFSET' AS kind FROM inter_member_obligation_changes WHERE space_id=$1 AND type='OFFSET_APPLIED'
            )
            SELECT o.id,
                COALESCE(SUM(a.amount_in_cents) FILTER (WHERE a.kind='TRANSFER'),0)::text AS transferred,
                COALESCE(SUM(a.amount_in_cents) FILTER (WHERE a.kind='OFFSET'),0)::text AS compensated
            FROM inter_member_obligations o LEFT JOIN applications a ON a.obligation_id=o.id
            WHERE o.space_id=$1 AND o.commitment_id=$2 GROUP BY o.id`,
            [spaceId, commitmentId],
        );
        const totals = new Map(applications.map((a) => [a.id, a]));
        const result: FulfillmentObligationView[] = [];
        for (const o of rows) {
            const changes = await m.find(InterMemberObligationChangeOrmEntity, {
                where: { spaceId, obligationId: o.id },
                order: { version: 'ASC' },
            });
            result.push({
                id: o.id,
                originCommitmentId: o.commitmentId,
                ...(o.receiptId
                    ? { originReceiptId: o.receiptId }
                    : o.externalLiabilityId
                      ? { originExternalLiabilityId: o.externalLiabilityId }
                      : { originDisbursementId: o.disbursementId! }),
                debtorMemberId: o.debtorMemberId,
                creditorMemberId: o.creditorMemberId,
                originalAmountInCents: o.originalAmountInCents,
                recognizedAmountInCents: o.recognizedAmountInCents,
                remainingAmountInCents: o.remainingAmountInCents,
                transferredAmountInCents: Number(
                    totals.get(o.id)?.transferred ?? '0',
                ),
                compensatedAmountInCents: Number(
                    totals.get(o.id)?.compensated ?? '0',
                ),
                status: o.status as FulfillmentObligationView['status'],
                cycleId: o.cycleId,
                history: changes.map((c) => ({
                    version: c.version,
                    type: c.type as FulfillmentObligationView['history'][number]['type'],
                    actorId: c.actorId,
                    registeredAt: c.registeredAt.toISOString(),
                    snapshot: c.snapshot as Record<string, unknown>,
                })),
            });
        }
        return result;
    }
}
