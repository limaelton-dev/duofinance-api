import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
    UNIT_OF_WORK,
    type UnitOfWork,
} from '../../../../shared/application/unit-of-work.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import {
    SettlementReversal,
    planSettlementReversal,
} from '../../domain/settlement-reversal/settlement-reversal.js';
import { InterMemberObligation } from '../../domain/shared-expense/inter-member-obligation.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import type {
    ReverseSettlementCommand,
    SettlementReversalResult,
    SettlementReversalState,
} from '../models/settlement-reversal.js';
import {
    SETTLEMENT_REVERSAL_REPOSITORY,
    type SettlementReversalRepository,
} from '../ports/private/settlement-reversal.repository.js';
import {
    SETTLEMENT_ADJUSTMENT_REPOSITORY,
    SettlementAdjustmentReceiptRaceError,
    type SettlementAdjustmentRepository,
} from '../ports/private/settlement-adjustment.repository.js';
import {
    SETTLEMENT_TRANSFER_REPOSITORY,
    type SettlementTransferRepository,
} from '../ports/private/settlement-transfer.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
export function requiresReversalCorrection(state: SettlementReversalState) {
    const finalized = new Set(
        state.cycles.filter((c) => c.status === 'FINALIZED').map((c) => c.id),
    );
    return state.allocations.some(
        (a) =>
            (a.cycleId !== null && finalized.has(a.cycleId)) ||
            state.obligations.some(
                (o) =>
                    o.id === a.obligationId &&
                    o.cycleId !== null &&
                    finalized.has(o.cycleId),
            ),
    );
}
@Injectable()
export class ReverseSettlementHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(SETTLEMENT_REVERSAL_REPOSITORY)
        private readonly reversals: SettlementReversalRepository,
        @Inject(SETTLEMENT_ADJUSTMENT_REPOSITORY)
        private readonly adjustments: SettlementAdjustmentRepository,
        @Inject(SETTLEMENT_TRANSFER_REPOSITORY)
        private readonly obligations: SettlementTransferRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    async execute(
        c: ReverseSettlementCommand,
    ): Promise<SettlementReversalResult> {
        const operation =
            c.originalKind === 'TRANSFER'
                ? 'REVERSE_SETTLEMENT_TRANSFER'
                : 'REVERSE_SETTLEMENT_OFFSET';
        try {
            return await this.uow.execute(async () => {
                await this.context.read(c.actorId, c.spaceId);
                const receipt =
                    await this.adjustments.findReceipt<SettlementReversalResult>(
                        operation,
                        c,
                    );
                if (receipt) return { ...receipt, replayed: true };
                const context = await this.context.lockForSettlement(
                    c.actorId,
                    c.spaceId,
                );
                if (context.version !== c.expectedSpaceVersion)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                if (civilDate(c.factDate) > this.clock.today())
                    throw new FinancesError('VALIDATION_ERROR', ['factDate']);
                const discovered = await this.reversals.state(
                    c.spaceId.value,
                    c.originalKind,
                    c.originalId,
                );
                if (!discovered)
                    throw new FinancesError(
                        c.originalKind === 'TRANSFER'
                            ? 'SETTLEMENT_TRANSFER_NOT_FOUND'
                            : 'SETTLEMENT_OFFSET_NOT_FOUND',
                    );
                const originIds = [
                    ...new Set(
                        discovered.allocations.map((a) => a.originCommitmentId),
                    ),
                ].sort();
                await this.obligations.lockOrigins(c.spaceId.value, originIds);
                const lockedReceipt =
                    await this.adjustments.findReceipt<SettlementReversalResult>(
                        operation,
                        c,
                    );
                if (lockedReceipt) return { ...lockedReceipt, replayed: true };
                const state = (await this.reversals.state(
                    c.spaceId.value,
                    c.originalKind,
                    c.originalId,
                ))!;
                if (state.previousReversals.length)
                    throw new FinancesError(
                        'SETTLEMENT_RESOLUTION_ALREADY_REVERSED',
                    );
                if (
                    c.applications.length !== state.allocations.length ||
                    new Set(c.applications.map((a) => a.allocationId)).size !==
                        c.applications.length ||
                    state.allocations.some(
                        (a) =>
                            !c.applications.some(
                                (input) =>
                                    input.allocationId === a.id &&
                                    input.amountInCents === a.amountInCents,
                            ),
                    )
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'applications',
                    ]);
                const discoveryKey = (s: SettlementReversalState) =>
                    JSON.stringify(
                        s.obligations.map((o) => [o.id, o.cycleId, o.version]),
                    );
                if (discoveryKey(discovered) !== discoveryKey(state))
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const needsCorrection = requiresReversalCorrection(state);
                if (needsCorrection && !c.correctionCycleId)
                    throw new FinancesError(
                        'REVERSAL_CORRECTION_CYCLE_REQUIRED',
                    );
                if (!needsCorrection && c.correctionCycleId)
                    throw new FinancesError('VALIDATION_ERROR', [
                        'correctionCycleId',
                    ]);
                const cycleIds = [
                    ...new Set([
                        ...state.cycles.map((c) => c.id),
                        ...(c.correctionCycleId ? [c.correctionCycleId] : []),
                    ]),
                ].sort();
                const cycles = await this.adjustments.lockCycles(
                    c.spaceId.value,
                    cycleIds,
                );
                if (
                    state.cycles.some(
                        (before) =>
                            !cycles.some(
                                (after) =>
                                    after.id === before.id &&
                                    after.version === before.version &&
                                    after.status === before.status,
                            ),
                    )
                )
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                if (
                    c.correctionCycleId &&
                    cycles.find((cycle) => cycle.id === c.correctionCycleId)
                        ?.status !== 'OPEN'
                )
                    throw new FinancesError('SETTLEMENT_CYCLE_FINALIZED');
                if (
                    c.expectedCycleVersions.length !== cycles.length ||
                    cycles.some(
                        (cycle) =>
                            !c.expectedCycleVersions.some(
                                (v) =>
                                    v.cycleId === cycle.id &&
                                    v.version === cycle.version,
                            ),
                    )
                )
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const ids = state.obligations.map((o) => o.id).sort();
                const before = await this.obligations.lockObligations(
                    c.spaceId.value,
                    ids,
                );
                if (
                    before.length !== ids.length ||
                    c.expectedObligationVersions.length !== ids.length ||
                    before.some(
                        (o) =>
                            !c.expectedObligationVersions.some(
                                (v) =>
                                    v.obligationId === o.id &&
                                    v.version === o.version,
                            ) ||
                            o.cycleId !==
                                state.obligations.find(
                                    (row) => row.id === o.id,
                                )!.cycleId,
                    )
                )
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const finalizedIds = cycles
                    .filter((c) => c.status === 'FINALIZED')
                    .map((c) => c.id);
                const finalized = new Set(finalizedIds);
                if (
                    before.some(
                        (o) =>
                            ![o.debtorMemberId, o.creditorMemberId].every(
                                (id) =>
                                    context.members.some(
                                        (m) => m.memberId === id,
                                    ),
                            ),
                    )
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'applications',
                    ]);
                const allocations = state.allocations.map((a) => ({
                    id: randomUUID(),
                    originalAllocationId: a.id,
                    obligationId: a.obligationId,
                    debtorMemberId: a.debtorMemberId,
                    creditorMemberId: a.creditorMemberId,
                    amountInCents: a.amountInCents,
                    originalCycleId: a.cycleId,
                    correctionCycleId:
                        (a.cycleId !== null && finalized.has(a.cycleId)) ||
                        before.some(
                            (o) =>
                                o.id === a.obligationId &&
                                o.cycleId !== null &&
                                finalized.has(o.cycleId),
                        )
                            ? c.correctionCycleId!
                            : null,
                }));
                const now = this.clock.now().toISOString();
                const reversal = new SettlementReversal(
                    randomUUID(),
                    c.spaceId.value,
                    c.originalKind,
                    c.originalId,
                    c.factDate,
                    now,
                    c.actorId.value,
                    allocations,
                );
                const after: InterMemberObligation[] = [],
                    created: InterMemberObligation[] = [],
                    effectIds = new Map<string, string | null>();
                for (const originId of originIds) {
                    const originObligations = before.filter(
                        (o) => o.originCommitmentId === originId,
                    );
                    const apps = allocations.filter((a) =>
                        state.allocations.some(
                            (source) =>
                                source.id === a.originalAllocationId &&
                                source.originCommitmentId === originId,
                        ),
                    );
                    const plan = planSettlementReversal(
                        originObligations,
                        apps,
                        finalizedIds,
                    );
                    const originCorrection = apps.some(
                        (a) => a.correctionCycleId !== null,
                    );
                    for (const change of plan.changes)
                        after.push(
                            change.obligation.reverseResolution(
                                change.remainingAmountInCents,
                                change.reversedAmountInCents,
                                change.obligation.version,
                            ),
                        );
                    let effectId =
                        plan.reusedObligation?.id ??
                        plan.changes[0]?.obligation.id ??
                        null;
                    if (plan.newDifference) {
                        const source = originObligations.find(
                            (o) => o.id === apps[0].obligationId,
                        )!;
                        const targetCycleId = originCorrection
                            ? c.correctionCycleId!
                            : source.cycleId;
                        if (targetCycleId && finalized.has(targetCycleId))
                            throw new FinancesError(
                                'SETTLEMENT_CYCLE_FINALIZED',
                            );
                        const next = new InterMemberObligation(
                            randomUUID(),
                            c.spaceId.value,
                            originId,
                            source.originDisbursementId,
                            plan.newDifference.debtorMemberId,
                            plan.newDifference.creditorMemberId,
                            plan.newDifference.amountInCents,
                            targetCycleId,
                            source.factDate,
                            now,
                            c.actorId.value,
                            undefined,
                            undefined,
                            undefined,
                            source.originKind,
                            undefined,
                            undefined,
                            null,
                            source.originExternalLiabilityId,
                        );
                        created.push(next);
                        effectId = next.id;
                    }
                    for (const app of apps)
                        effectIds.set(app.originalAllocationId, effectId);
                }
                await this.reversals.save(
                    reversal,
                    before,
                    after,
                    created,
                    effectIds,
                );
                const effects = [...after, ...created].map((o) => ({
                    obligationId: o.id,
                    originCommitmentId: o.originCommitmentId,
                    remainingAmountInCents: o.remainingAmountInCents,
                    cycleId: o.cycleId,
                    version: o.version,
                    status: o.status,
                }));
                const result: SettlementReversalResult = {
                    spaceId: c.spaceId.value,
                    reversal: {
                        id: reversal.id,
                        originalKind: reversal.originalKind,
                        originalId: reversal.originalId,
                        amountInCents: reversal.amountInCents,
                        factDate: reversal.factDate,
                        registeredAt: reversal.registeredAt,
                        createdByPersonId: reversal.createdByPersonId,
                    },
                    original: state.original,
                    applications: allocations.map((a) => ({
                        ...a,
                        effectObligationId:
                            effectIds.get(a.originalAllocationId) ?? null,
                    })),
                    effects,
                    affectedCycleIds: [
                        ...new Set(
                            [
                                ...allocations.flatMap((a) => [
                                    a.originalCycleId,
                                    a.correctionCycleId,
                                ]),
                                ...effects.map((e) => e.cycleId),
                            ].filter((id): id is string => id !== null),
                        ),
                    ].sort(),
                    replayed: false,
                };
                await this.adjustments.saveReceipt(operation, c, result, now);
                return result;
            });
        } catch (error) {
            if (!(error instanceof SettlementAdjustmentReceiptRaceError))
                throw error;
            return this.uow.execute(async () => {
                await this.context.read(c.actorId, c.spaceId);
                const receipt =
                    await this.adjustments.findReceipt<SettlementReversalResult>(
                        operation,
                        c,
                    );
                if (!receipt) throw error;
                return { ...receipt, replayed: true };
            });
        }
    }
}
