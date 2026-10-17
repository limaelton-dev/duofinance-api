import { Inject, Injectable, Optional } from '@nestjs/common';
import {
    SETTLEMENT_ADJUSTMENT_REPOSITORY,
    type SettlementAdjustmentRepository,
} from '../ports/private/settlement-adjustment.repository.js';
import { randomUUID } from 'node:crypto';
import {
    IncomeCommitment,
    incomeDifference,
} from '../../domain/income/income-commitment.js';
import {
    FinancialCommitment,
    type ExpenseVersion,
} from '../../domain/shared-expense/financial-commitment.js';
import {
    expenseDifference,
    correctedExpenseDifference,
    planObligationReconciliation,
} from '../../domain/shared-expense/obligation-reconciler.js';
import { InterMemberObligation } from '../../domain/shared-expense/inter-member-obligation.js';
import { SettlementRule } from '../../domain/settlement-rule/settlement-rule.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import type { SettlementSelection } from '../../domain/shared-expense/settlement-selection.js';
import {
    FinancesError,
    type FinancesErrorCode,
} from '../../domain/errors/finances.error.js';
import {
    INTER_MEMBER_OBLIGATION_REPOSITORY,
    SETTLEMENT_CYCLE_REPOSITORY,
    type InterMemberObligationRepository,
    type SettlementCycleRepository,
} from '../ports/private/shared-expense.repositories.js';
@Injectable()
export class ReconcileFinancialOrigin {
    constructor(
        @Inject(INTER_MEMBER_OBLIGATION_REPOSITORY)
        private readonly obligations: InterMemberObligationRepository,
        @Inject(SETTLEMENT_CYCLE_REPOSITORY)
        private readonly cycles: SettlementCycleRepository,
        @Optional()
        @Inject(SETTLEMENT_ADJUSTMENT_REPOSITORY)
        private readonly adjustments?: SettlementAdjustmentRepository,
    ) {}
    private async suggestedDate(
        origin: IncomeCommitment | FinancialCommitment<ExpenseVersion>,
        selection: Extract<SettlementSelection, { mode: 'SUGGESTED' }>,
        today: string,
    ) {
        const participation =
            origin instanceof IncomeCommitment
                ? origin.participation
                : origin.initialVersion;
        const snapshot =
            'settlementRuleSnapshot' in participation
                ? participation.settlementRuleSnapshot
                : null;
        const source =
            'settlementRuleSourceVersion' in participation
                ? participation.settlementRuleSourceVersion
                : 0;
        const effective = this.adjustments
            ? await this.adjustments.effectiveRule(
                  origin.spaceId,
                  origin.id,
                  snapshot,
                  source,
              )
            : { rule: snapshot, version: source };
        if (
            !effective.rule ||
            selection.referenceDate !== today ||
            selection.expectedRuleVersion !== effective.version
        )
            throw new FinancesError(
                origin instanceof IncomeCommitment
                    ? 'INCOME_OPTIONS_CHANGED'
                    : 'EXPENSE_OPTIONS_CHANGED',
            );
        return SettlementRule.from(effective.rule).suggestTargetDate(today);
    }
    private difference(
        origin: IncomeCommitment | FinancialCommitment<ExpenseVersion>,
        settlements: Parameters<typeof expenseDifference>[2],
        corrected: boolean,
    ) {
        if (origin instanceof IncomeCommitment)
            return incomeDifference(origin, settlements);
        if (!('split' in origin.initialVersion)) return null;
        const payments = [
            ...origin.validDisbursements,
            ...origin.validExternalLiabilities.map((fact) => ({
                payerMemberId:
                    'holderMemberId' in fact ? fact.holderMemberId : '',
                amountInCents: fact.amountInCents,
            })),
        ];
        return (
            corrected || origin.reversals.length > 0
                ? correctedExpenseDifference
                : expenseDifference
        )(
            origin.initialVersion.split,
            payments as Parameters<typeof expenseDifference>[1],
            settlements,
        );
    }
    async preview(
        origin: IncomeCommitment | FinancialCommitment<ExpenseVersion>,
        occurrenceId: string | null = null,
        selection: SettlementSelection = { mode: 'NONE' },
        today?: string,
    ) {
        const state = await this.obligations.originState(
            origin.spaceId,
            origin.id,
            occurrenceId,
        );
        const difference = this.difference(origin, state.settlements, true);
        const finalizedCycleIds: string[] = [];
        for (const id of [
            ...new Set(
                state.obligations
                    .map((obligation) => obligation.cycleId)
                    .filter((id): id is string => id !== null),
            ),
        ].sort()) {
            const cycle = await this.adjustments?.cycle(origin.spaceId, id);
            if (cycle?.status === 'FINALIZED') finalizedCycleIds.push(id);
        }
        const plan = planObligationReconciliation(
            state.obligations,
            difference,
            finalizedCycleIds,
        );
        const requiresOpenCycle =
            finalizedCycleIds.length > 0 &&
            difference !== null &&
            (!plan.reusedObligation?.cycleId ||
                finalizedCycleIds.includes(plan.reusedObligation.cycleId));
        let blockingReason: FinancesErrorCode | null = null;
        const targetDate =
            selection.mode === 'SUGGESTED'
                ? await this.suggestedDate(
                      origin,
                      selection,
                      today ?? selection.referenceDate,
                  )
                : selection.mode === 'DATE'
                  ? selection.targetDate
                  : null;
        const destination =
            selection.mode === 'CYCLE'
                ? await this.adjustments?.cycle(
                      origin.spaceId,
                      selection.cycleId,
                  )
                : targetDate
                  ? await this.adjustments?.cycleForDate(
                        origin.spaceId,
                        targetDate,
                    )
                  : null;
        if (selection.mode === 'CYCLE' && !destination)
            blockingReason = 'SETTLEMENT_CYCLE_NOT_FOUND';
        else if (destination?.status === 'FINALIZED')
            blockingReason = 'SETTLEMENT_CYCLE_FINALIZED';
        else if (requiresOpenCycle && selection.mode === 'NONE')
            blockingReason = 'REVERSAL_CORRECTION_CYCLE_REQUIRED';
        return {
            currentPendingAmountInCents: state.obligations
                .reduce(
                    (sum, obligation) =>
                        sum + BigInt(obligation.remainingAmountInCents),
                    0n,
                )
                .toString(),
            proposedDifference: difference,
            requiresOpenCycle,
            finalizedCycleIds,
            blockingReason,
        };
    }
    async execute(
        origin: IncomeCommitment | FinancialCommitment<ExpenseVersion>,
        selection: SettlementSelection,
        actorId: string,
        today: string,
        now: string,
        occurrenceId: string | null = null,
        cause?: {
            id: string;
            factDate: string;
            kind: 'ADJUSTMENT' | 'REVERSAL';
            preserveSettlementEffects?: boolean;
            originalFact?: {
                id: string;
                kind: 'DISBURSEMENT' | 'EXTERNAL_LIABILITY' | 'RECEIPT';
                factDate: string;
            };
        },
        preserveSettlementEffects = false,
    ) {
        const state = await this.obligations.originState(
            origin.spaceId,
            origin.id,
            occurrenceId,
        );
        const income = origin instanceof IncomeCommitment;
        const difference = this.difference(
            origin,
            state.settlements,
            cause?.preserveSettlementEffects ?? preserveSettlementEffects,
        );
        const fact =
            cause?.originalFact ??
            (income ? origin.receipts.at(-1)! : origin.fulfillments.at(-1)!);
        const finalizedCycleIds: string[] = [];
        for (const id of [
            ...new Set(
                state.obligations
                    .map((obligation) => obligation.cycleId)
                    .filter((id): id is string => id !== null),
            ),
        ].sort()) {
            const cycle = await this.adjustments?.cycle(origin.spaceId, id);
            if (cycle?.status === 'FINALIZED') finalizedCycleIds.push(id);
        }
        const plan = planObligationReconciliation(
            state.obligations,
            difference,
            finalizedCycleIds,
        );
        if (
            finalizedCycleIds.length > 0 &&
            difference &&
            selection.mode === 'NONE' &&
            (!plan.reusedObligation?.cycleId ||
                finalizedCycleIds.includes(plan.reusedObligation.cycleId))
        )
            throw new FinancesError(
                cause?.kind === 'REVERSAL'
                    ? 'REVERSAL_CORRECTION_CYCLE_REQUIRED'
                    : 'SETTLEMENT_CYCLE_FINALIZED',
            );
        const matching = plan.reusedObligation;
        let cycleId: string | null = matching?.cycleId ?? null;
        let targetDate: string | null = null;
        if (difference && !matching) {
            if (selection.mode === 'CYCLE') {
                cycleId = selection.cycleId;
            } else if (selection.mode === 'DATE') {
                if (civilDate(selection.targetDate) < today)
                    throw new FinancesError('VALIDATION_ERROR', [
                        'settlement.targetDate',
                    ]);
                targetDate = selection.targetDate;
            } else if (selection.mode === 'SUGGESTED') {
                targetDate = await this.suggestedDate(origin, selection, today);
            }
        }
        if (targetDate) {
            const existing = await this.adjustments?.cycleForDate(
                origin.spaceId,
                targetDate,
            );
            cycleId =
                existing?.id ??
                (await this.cycles.lockForDate(origin.spaceId, targetDate)).id;
        }
        const affectedCycles = [
            ...new Set(
                [
                    ...plan.changes.map((change) => change.obligation.cycleId),
                    ...(difference ? [cycleId] : []),
                ].filter((id): id is string => id !== null),
            ),
        ].sort();
        const cycleIds = [
            ...new Set(
                [
                    ...state.obligations.map(
                        (obligation) => obligation.cycleId,
                    ),
                    ...affectedCycles,
                ].filter((id): id is string => id !== null),
            ),
        ].sort();
        for (const id of cycleIds) {
            const cycle = await this.cycles.lockExisting(origin.spaceId, id);
            if (!cycle) throw new FinancesError('SETTLEMENT_CYCLE_NOT_FOUND');
            if (affectedCycles.includes(id)) cycle.assertOpen();
        }
        const locked = await this.obligations.lockOrigin(
            origin.spaceId,
            origin.id,
            occurrenceId,
        );
        if (
            locked.obligations.length !== state.obligations.length ||
            locked.obligations.some((obligation) => {
                const previous = state.obligations.find(
                    (o) => o.id === obligation.id,
                );
                return (
                    !previous ||
                    previous.version !== obligation.version ||
                    previous.cycleId !== obligation.cycleId
                );
            })
        )
            throw new FinancesError('CONCURRENT_MODIFICATION');
        for (const change of plan.changes) {
            const before = change.obligation;
            await this.obligations.saveReconciliation(
                before,
                before.reconcile(
                    change.remainingAmountInCents,
                    actorId,
                    cause?.id ?? fact.id,
                    now,
                ),
            );
        }
        if (!difference || matching) return;
        await this.obligations.save(
            new InterMemberObligation(
                randomUUID(),
                origin.spaceId,
                origin.id,
                fact.id,
                difference.debtorMemberId,
                difference.creditorMemberId,
                difference.amountInCents,
                cycleId,
                cause?.factDate ?? fact.factDate,
                now,
                actorId,
                undefined,
                undefined,
                undefined,
                income ? 'INCOME' : 'EXPENSE',
                undefined,
                undefined,
                null,
                !income &&
                    ('holderMemberId' in fact ||
                        ('kind' in fact && fact.kind === 'EXTERNAL_LIABILITY'))
                    ? fact.id
                    : null,
                false,
                occurrenceId,
                cause?.id ?? null,
            ),
        );
    }
}
