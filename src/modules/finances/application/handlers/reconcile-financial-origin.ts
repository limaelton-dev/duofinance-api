import { Inject, Injectable } from '@nestjs/common';
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
                    origin.disbursements as FinancialCommitment['disbursements'],
                    state.settlements,
                )
              : null;
        const fact = income
            ? origin.receipts.at(-1)!
            : origin.disbursements.at(-1)!;
        const plan = planObligationReconciliation(
            state.obligations,
            difference,
        );
        const matching = plan.reusedObligation;
        let cycleId: string | null = matching?.cycleId ?? null;
        if (difference && matching?.cycleId) {
            const cycle = await this.cycles.lockExisting(
                origin.spaceId,
                matching.cycleId,
            );
            if (!cycle) throw new FinancesError('SETTLEMENT_CYCLE_NOT_FOUND');
            cycle.assertOpen();
        }
        if (difference && !matching) {
            if (selection.mode === 'CYCLE') {
                const cycle = await this.cycles.lockExisting(
                    origin.spaceId,
                    selection.cycleId,
                );
                if (!cycle)
                    throw new FinancesError('SETTLEMENT_CYCLE_NOT_FOUND');
                cycle.assertOpen();
                cycleId = cycle.id;
            } else if (selection.mode === 'DATE') {
                if (civilDate(selection.targetDate) < today)
                    throw new FinancesError('VALIDATION_ERROR', [
                        'settlement.targetDate',
                    ]);
                cycleId = (
                    await this.cycles.lockForDate(
                        origin.spaceId,
                        selection.targetDate,
                    )
                ).id;
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
                if (
                    !snapshot ||
                    selection.referenceDate !== today ||
                    selection.expectedRuleVersion !== source
                )
                    throw new FinancesError(
                        income
                            ? 'INCOME_OPTIONS_CHANGED'
                            : 'EXPENSE_OPTIONS_CHANGED',
                    );
                cycleId = (
                    await this.cycles.lockForDate(
                        origin.spaceId,
                        SettlementRule.from(snapshot).suggestTargetDate(today),
                    )
                ).id;
            }
        }
        await this.obligations.lockOrigin(origin.spaceId, origin.id);
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
            ),
        );
    }
}
