import { Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { SettlementReversalRepository } from '../../../application/ports/private/settlement-reversal.repository.js';
import type {
    SettlementResolutionKind,
    SettlementResolutionOriginal,
    SettlementResolutionAllocation,
    ReversalObligationState,
    SettlementReversalState,
} from '../../../application/models/settlement-reversal.js';
import type { AssignmentCycle } from '../../../application/models/settlement-adjustment.js';
import type { SettlementReversal } from '../../../domain/settlement-reversal/settlement-reversal.js';
import type { InterMemberObligation } from '../../../domain/shared-expense/inter-member-obligation.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import {
    SettlementReversalOrmEntity,
    SettlementReversalApplicationOrmEntity,
} from '../entities/settlement-reversal.orm-entity.js';
import {
    InterMemberObligationOrmEntity,
    InterMemberObligationChangeOrmEntity,
} from '../entities/shared-expense.orm-entity.js';
import {
    obligationRow,
    obligationChangeRow,
} from '../../mappers/shared-expense.mapper.js';
@Injectable()
export class TypeOrmSettlementReversalRepository implements SettlementReversalRepository {
    constructor(private readonly provider: EntityManagerProvider) {}
    private transaction() {
        const m = this.provider.get();
        if (!m.queryRunner?.isTransactionActive)
            throw new Error('Settlement reversal requires a transaction');
        return m;
    }
    state(
        spaceId: string,
        kind: SettlementResolutionKind,
        id: string,
    ): Promise<SettlementReversalState | null> {
        return this.provider.readSnapshot(async () => {
            const transfer = kind === 'TRANSFER';
            const originals: (Omit<
                SettlementResolutionOriginal,
                'amountInCents' | 'kind'
            > & { amountInCents: string })[] = await this.provider
                .get()
                .query(
                    `SELECT id,amount_in_cents::text AS "amountInCents",to_char(fact_date,'YYYY-MM-DD') AS "factDate",to_char(registered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "registeredAt",created_by AS "createdByPersonId" FROM ${transfer ? 'settlement_transfers' : 'settlement_offsets'} WHERE space_id=$1 AND id=$2`,
                    [spaceId, id],
                );
            if (!originals[0]) return null;
            const original: SettlementResolutionOriginal = {
                ...originals[0],
                kind,
                amountInCents: Number(originals[0].amountInCents),
            };
            const allocations: (Omit<
                SettlementResolutionAllocation,
                'amountInCents'
            > & { amountInCents: string })[] = await this.provider
                .get()
                .query(
                    `SELECT a.id,a.obligation_id AS "obligationId",o.commitment_id AS "originCommitmentId",o.debtor_member_id AS "debtorMemberId",o.creditor_member_id AS "creditorMemberId",a.amount_in_cents::text AS "amountInCents",a.cycle_id AS "cycleId" FROM ${transfer ? 'settlement_allocations' : 'settlement_offset_allocations'} a JOIN inter_member_obligations o ON o.space_id=a.space_id AND o.id=a.obligation_id WHERE a.space_id=$1 AND a.${transfer ? 'transfer_id' : 'offset_id'}=$2 ORDER BY a.id`,
                    [spaceId, id],
                );
            const previous: (Omit<
                SettlementReversalState['previousReversals'][number],
                'amountInCents'
            > & { amountInCents: string })[] = await this.provider
                .get()
                .query(
                    `SELECT r.id,r.amount_in_cents::text AS "amountInCents",to_char(r.fact_date,'YYYY-MM-DD') AS "factDate",to_char(r.registered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "registeredAt",r.created_by AS "createdByPersonId",COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'originalAllocationId',COALESCE(a.original_transfer_allocation_id,a.original_offset_allocation_id),'obligationId',a.original_obligation_id,'originalCycleId',a.source_cycle_id,'correctionCycleId',a.correction_cycle_id,'effectObligationId',a.effect_obligation_id,'amountInCents',a.amount_in_cents,'debtorMemberId',a.debtor_member_id,'creditorMemberId',a.creditor_member_id) ORDER BY a.id) FROM settlement_reversal_applications a WHERE a.space_id=r.space_id AND a.reversal_id=r.id),'[]'::jsonb) AS applications FROM settlement_reversals r WHERE r.space_id=$1 AND r.${transfer ? 'original_transfer_id' : 'original_offset_id'}=$2 ORDER BY r.registered_at,r.id`,
                    [spaceId, id],
                );
            const obligations: (Omit<
                ReversalObligationState,
                'remainingAmountInCents'
            > & { remainingAmountInCents: string })[] = await this.provider
                .get()
                .query(
                    `SELECT id,commitment_id AS "originCommitmentId",version,cycle_id AS "cycleId",debtor_member_id AS "debtorMemberId",creditor_member_id AS "creditorMemberId",remaining_amount_in_cents::text AS "remainingAmountInCents",status FROM inter_member_obligations WHERE space_id=$1 AND commitment_id=ANY($2::uuid[]) ORDER BY id`,
                    [
                        spaceId,
                        [
                            ...new Set(
                                allocations.map((a) => a.originCommitmentId),
                            ),
                        ],
                    ],
                );
            const cycleIds = [
                ...new Set(
                    [
                        ...allocations.map((a) => a.cycleId),
                        ...obligations.map((o) => o.cycleId),
                    ].filter((id): id is string => id !== null),
                ),
            ];
            const cycles: AssignmentCycle[] = cycleIds.length
                ? await this.provider
                      .get()
                      .query(
                          `SELECT id,version,status,to_char(target_date,'YYYY-MM-DD') AS "targetDate" FROM settlement_cycles WHERE space_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`,
                          [spaceId, cycleIds],
                      )
                : [];
            return {
                original,
                allocations: allocations.map((a) => ({
                    ...a,
                    amountInCents: Number(a.amountInCents),
                })),
                previousReversals: previous.map((r) => ({
                    ...r,
                    amountInCents: Number(r.amountInCents),
                })),
                obligations: obligations.map((o) => ({
                    ...o,
                    remainingAmountInCents: Number(o.remainingAmountInCents),
                })),
                cycles,
            };
        });
    }
    async save(
        reversal: SettlementReversal,
        before: InterMemberObligation[],
        after: InterMemberObligation[],
        created: InterMemberObligation[],
        effectObligationIds: Map<string, string | null>,
    ) {
        const m = this.transaction();
        await m.insert(SettlementReversalOrmEntity, {
            id: reversal.id,
            spaceId: reversal.spaceId,
            originalKind: reversal.originalKind,
            originalTransferId:
                reversal.originalKind === 'TRANSFER'
                    ? reversal.originalId
                    : null,
            originalOffsetId:
                reversal.originalKind === 'OFFSET' ? reversal.originalId : null,
            amountInCents: reversal.amountInCents,
            factDate: reversal.factDate,
            registeredAt: new Date(reversal.registeredAt),
            createdByPersonId: reversal.createdByPersonId,
        });
        for (const next of after) {
            const old = before.find((o) => o.id === next.id)!;
            const update = await m.update(
                InterMemberObligationOrmEntity,
                { spaceId: old.spaceId, id: old.id, version: old.version },
                {
                    recognizedAmountInCents: next.recognizedAmountInCents,
                    remainingAmountInCents: next.remainingAmountInCents,
                    status: next.status,
                    version: next.version,
                },
            );
            if (update.affected !== 1)
                throw new FinancesError('CONCURRENT_MODIFICATION');
            await m.insert(InterMemberObligationChangeOrmEntity, {
                spaceId: next.spaceId,
                obligationId: next.id,
                version: next.version,
                actorId: reversal.createdByPersonId,
                type: 'REVERSED',
                allocationId: null,
                snapshot: {
                    reversalId: reversal.id,
                    originalKind: reversal.originalKind,
                    originalId: reversal.originalId,
                    previousRecognizedAmountInCents:
                        old.recognizedAmountInCents,
                    recognizedAmountInCents: next.recognizedAmountInCents,
                    previousRemainingAmountInCents: old.remainingAmountInCents,
                    remainingAmountInCents: next.remainingAmountInCents,
                    status: next.status,
                },
                registeredAt: new Date(reversal.registeredAt),
            });
        }
        for (const next of created) {
            await m.insert(InterMemberObligationOrmEntity, obligationRow(next));
            const event = obligationChangeRow(next);
            await m.insert(InterMemberObligationChangeOrmEntity, {
                ...event,
                snapshot: {
                    ...(event.snapshot as object),
                    reversalId: reversal.id,
                    originalKind: reversal.originalKind,
                    originalId: reversal.originalId,
                    correction: true,
                },
            });
        }
        for (const application of reversal.allocations)
            await m.insert(SettlementReversalApplicationOrmEntity, {
                id: application.id,
                spaceId: reversal.spaceId,
                reversalId: reversal.id,
                originalTransferAllocationId:
                    reversal.originalKind === 'TRANSFER'
                        ? application.originalAllocationId
                        : null,
                originalOffsetAllocationId:
                    reversal.originalKind === 'OFFSET'
                        ? application.originalAllocationId
                        : null,
                originalObligationId: application.obligationId,
                effectObligationId:
                    effectObligationIds.get(application.originalAllocationId) ??
                    null,
                sourceCycleId: application.originalCycleId,
                correctionCycleId: application.correctionCycleId,
                debtorMemberId: application.debtorMemberId,
                creditorMemberId: application.creditorMemberId,
                amountInCents: application.amountInCents,
            });
    }
}
