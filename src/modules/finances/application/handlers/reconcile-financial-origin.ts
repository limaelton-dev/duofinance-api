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
    planObligationReconciliation,
} from '../../domain/shared-expense/obligation-reconciler.js';
import { InterMemberObligation } from '../../domain/shared-expense/inter-member-obligation.js';
import { SettlementRule } from '../../domain/settlement-rule/settlement-rule.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import type { SettlementSelection } from '../../domain/shared-expense/settlement-selection.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
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
    async execute(
        origin: IncomeCommitment | FinancialCommitment<ExpenseVersion>,
        selection: SettlementSelection,
        actorId: string,
        today: string,
        now: string,
    ) {
        const state = await this.obligations.originState(
            origin.spaceId,
            origin.id,
        );
        const income = origin instanceof IncomeCommitment;
        const difference = income
            ? incomeDifference(origin, state.settlements)
            : 'split' in origin.initialVersion
              ? expenseDifference(
                    origin.initialVersion.split,
                    [
                        ...(origin.disbursements as FinancialCommitment['disbursements']),
                        ...origin.externalLiabilities.map((f) => ({
                            payerMemberId:
                                'holderMemberId' in f ? f.holderMemberId : '',
                            amountInCents: f.amountInCents,
                        })),
                    ],
                    state.settlements,
                )
              : null;
        const fact = income
            ? origin.receipts.at(-1)!
            : origin.fulfillments.at(-1)!;
        const latest = state.obligations.at(-1);
        const latestCycle =
            latest?.status === 'SETTLED' && latest.cycleId
                ? await this.adjustments?.cycle(origin.spaceId, latest.cycleId)
                : null;
        if (
            latestCycle?.status === 'FINALIZED' &&
            difference &&
            selection.mode === 'NONE'
        )
            throw new FinancesError('SETTLEMENT_CYCLE_FINALIZED');
        const plan = planObligationReconciliation(
            state.obligations,
            difference,
            latestCycle?.status === 'FINALIZED' ? [latestCycle.id] : [],
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
                const p = income ? origin.participation : origin.initialVersion;
                const snapshot =
                    'settlementRuleSnapshot' in p
                        ? p.settlementRuleSnapshot
                        : null;
                const source =
                    'settlementRuleSourceVersion' in p
                        ? p.settlementRuleSourceVersion
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
                        income
                            ? 'INCOME_OPTIONS_CHANGED'
                            : 'EXPENSE_OPTIONS_CHANGED',
                    );
                targetDate = SettlementRule.from(
                    effective.rule,
                ).suggestTargetDate(today);
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
                    fact.id,
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
                fact.factDate,
                now,
                actorId,
                undefined,
                undefined,
                undefined,
                income ? 'INCOME' : 'EXPENSE',
                undefined,
                undefined,
                null,
                !income && 'holderMemberId' in fact ? fact.id : null,
            ),
        );
    }
}
