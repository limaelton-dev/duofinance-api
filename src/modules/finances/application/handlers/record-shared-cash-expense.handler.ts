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
import {
    DEFAULT_SETTLEMENT_RULE_REPOSITORY,
    type DefaultSettlementRuleRepository,
} from '../ports/private/default-settlement-rule.repository.js';
import {
    EXPENSE_COMMAND_RECEIPTS,
    ExpenseReceiptRaceError,
    FINANCIAL_COMMITMENT_REPOSITORY,
    INTER_MEMBER_OBLIGATION_REPOSITORY,
    SETTLEMENT_CYCLE_REPOSITORY,
    FINANCES_CLOCK,
    type ExpenseCommandReceipts,
    type FinancialCommitmentRepository,
    type InterMemberObligationRepository,
    type SettlementCycleRepository,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import {
    FinancialCommitment,
    ResponsibilitySplit,
    InterMemberObligation,
    civilDate,
    type SettlementCycle,
} from '../../domain/shared-expense/shared-expense.js';
import { expenseDifference } from '../../domain/shared-expense/obligation-reconciler.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import {
    expenseView,
    type RecordSharedCashExpenseCommand,
    type SharedCashExpenseResult,
} from '../models/shared-cash-expense.js';
@Injectable()
export class RecordSharedCashExpenseHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(DEFAULT_SETTLEMENT_RULE_REPOSITORY)
        private readonly rules: DefaultSettlementRuleRepository,
        @Inject(FINANCIAL_COMMITMENT_REPOSITORY)
        private readonly commitments: FinancialCommitmentRepository,
        @Inject(INTER_MEMBER_OBLIGATION_REPOSITORY)
        private readonly obligations: InterMemberObligationRepository,
        @Inject(SETTLEMENT_CYCLE_REPOSITORY)
        private readonly cycles: SettlementCycleRepository,
        @Inject(EXPENSE_COMMAND_RECEIPTS)
        private readonly receipts: ExpenseCommandReceipts,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    async execute(
        c: RecordSharedCashExpenseCommand,
    ): Promise<SharedCashExpenseResult> {
        try {
            return await this.uow.execute(async () => {
                await this.context.read(c.actorId, c.spaceId);
                const receipt = await this.receipts.find(c);
                if (receipt) return { ...receipt, replayed: true };
                const context = await this.context.lockForWrite(
                    c.actorId,
                    c.spaceId,
                );
                if (context.version !== c.expectedSpaceVersion)
                    throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
                const now = this.clock.now().toISOString(),
                    today = this.clock.today();
                if (civilDate(c.factDate) > today)
                    throw new FinancesError('VALIDATION_ERROR', ['factDate']);
                if (
                    c.expectedPayerMemberId !== null &&
                    !context.members.some(
                        (m) => m.memberId === c.expectedPayerMemberId,
                    )
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'expectedPayerMemberId',
                    ]);
                if (
                    !context.members.some(
                        (m) => m.memberId === c.disbursement.payerMemberId,
                    )
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'disbursement.payerMemberId',
                    ]);
                if (
                    c.responsibilitySplit.shares.length !==
                        context.members.length ||
                    c.responsibilitySplit.shares.some(
                        (s) =>
                            !context.members.some(
                                (m) => m.memberId === s.memberId,
                            ),
                    )
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'responsibilitySplit.shares',
                    ]);
                const split = ResponsibilitySplit.create(
                    c.amountInCents,
                    context.members.map((m) => m.memberId),
                    c.responsibilitySplit,
                );
                const difference = expenseDifference(split, [
                    {
                        payerMemberId: c.disbursement.payerMemberId,
                        amountInCents:
                            c.disbursement.amountInCents ?? c.amountInCents,
                    },
                ]);
                if (
                    !difference &&
                    c.settlement.mode !== 'NONE' &&
                    c.disbursement.amountInCents === undefined
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'settlement.mode',
                    ]);
                const rule = await this.rules.find(c.spaceId.value);
                const suggestedTargetDate =
                    rule?.rule.suggestTargetDate(today) ?? null;
                let cycle: SettlementCycle | null = null;
                if (difference) {
                    if (c.settlement.mode === 'SUGGESTED') {
                        if (
                            !rule ||
                            c.settlement.referenceDate !== today ||
                            c.settlement.expectedRuleVersion !== rule.version
                        )
                            throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
                        cycle = await this.cycles.lockForDate(
                            c.spaceId.value,
                            suggestedTargetDate!,
                        );
                    } else if (c.settlement.mode === 'DATE') {
                        if (civilDate(c.settlement.targetDate) < today)
                            throw new FinancesError('VALIDATION_ERROR', [
                                'settlement.targetDate',
                            ]);
                        cycle = await this.cycles.lockForDate(
                            c.spaceId.value,
                            c.settlement.targetDate,
                        );
                    } else if (c.settlement.mode === 'CYCLE') {
                        cycle = await this.cycles.lockExisting(
                            c.spaceId.value,
                            c.settlement.cycleId,
                        );
                        if (!cycle)
                            throw new FinancesError(
                                'SETTLEMENT_CYCLE_NOT_FOUND',
                            );
                        cycle.assertOpen();
                    }
                }
                const commitment = new FinancialCommitment(
                    randomUUID(),
                    c.spaceId.value,
                    c.description.trim(),
                    c.actorId.value,
                    now,
                    {
                        version: 1,
                        split,
                        expectedPayerMemberId: c.expectedPayerMemberId,
                        factDate: c.factDate,
                        settlementRuleSnapshot: rule?.rule.snapshot ?? null,
                        settlementRuleSourceVersion: rule?.version ?? 0,
                        suggestedTargetDate,
                    },
                    {
                        id: randomUUID(),
                        payerMemberId: c.disbursement.payerMemberId,
                        method: c.disbursement.method,
                        amountInCents:
                            c.disbursement.amountInCents ?? c.amountInCents,
                        recordedByPersonId: c.actorId.value,
                        factDate: c.factDate,
                        registeredAt: now,
                    },
                    today,
                );
                const obligation = difference
                    ? new InterMemberObligation(
                          randomUUID(),
                          c.spaceId.value,
                          commitment.id,
                          commitment.disbursement!.id,
                          difference.debtorMemberId,
                          difference.creditorMemberId,
                          difference.amountInCents,
                          cycle?.id ?? null,
                          c.factDate,
                          now,
                          c.actorId.value,
                      )
                    : null;
                await this.commitments.save(commitment);
                if (obligation) await this.obligations.save(obligation);
                const result = {
                    ...expenseView(commitment, obligation, cycle),
                    replayed: false,
                };
                if (result.obligation)
                    result.obligations.push(result.obligation);
                await this.receipts.save(c, result, now);
                return result;
            });
        } catch (error) {
            if (!(error instanceof ExpenseReceiptRaceError)) throw error;
            return this.uow.execute(async () => {
                await this.context.read(c.actorId, c.spaceId);
                const receipt = await this.receipts.find(c);
                if (!receipt) throw error;
                return { ...receipt, replayed: true };
            });
        }
    }
}
