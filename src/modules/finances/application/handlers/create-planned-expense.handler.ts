import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
    UNIT_OF_WORK,
    type UnitOfWork,
} from '../../../../shared/application/unit-of-work.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../../spaces/application/ports/public/space-access.port.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import {
    FinancialCommitment,
    type PersonalCommitmentVersion,
} from '../../domain/shared-expense/financial-commitment.js';
import { Money } from '../../domain/shared-expense/money.js';
import { ResponsibilitySplit } from '../../domain/shared-expense/responsibility-split.js';
import { personalExpenseView } from '../models/personal-expense.js';
import { expenseView } from '../models/shared-cash-expense.js';
import type {
    CreatePlannedExpenseCommand,
    PlannedExpenseResult,
} from '../models/planned-expense.js';
import {
    DEFAULT_SETTLEMENT_RULE_REPOSITORY,
    type DefaultSettlementRuleRepository,
} from '../ports/private/default-settlement-rule.repository.js';
import {
    PLANNED_EXPENSE_RECEIPTS,
    type PlannedExpenseReceipts,
} from '../ports/private/planned-expense.receipts.js';
import {
    ExpenseReceiptRaceError,
    FINANCIAL_COMMITMENT_REPOSITORY,
    FINANCES_CLOCK,
    type FinancialCommitmentRepository,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';

@Injectable()
export class CreatePlannedExpenseHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(DEFAULT_SETTLEMENT_RULE_REPOSITORY)
        private readonly rules: DefaultSettlementRuleRepository,
        @Inject(FINANCIAL_COMMITMENT_REPOSITORY)
        private readonly commitments: FinancialCommitmentRepository,
        @Inject(PLANNED_EXPENSE_RECEIPTS)
        private readonly receipts: PlannedExpenseReceipts,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}

    async execute(
        c: CreatePlannedExpenseCommand,
    ): Promise<PlannedExpenseResult> {
        try {
            return await this.uow.execute(async () => {
                const access = await this.access.assertCanRead(
                    c.actorId,
                    c.spaceId,
                );
                const prior = await this.receipts.find(c);
                if (prior) return { ...prior, replayed: true };
                if (access.type !== c.scope)
                    throw new FinancesError(
                        c.scope === 'PERSONAL'
                            ? 'PERSONAL_SPACE_REQUIRED'
                            : 'SHARED_SPACE_REQUIRED',
                    );
                const now = this.clock.now().toISOString();
                const today = this.clock.today();
                if (c.scope === 'PERSONAL') {
                    await this.access.assertCanWrite(c.actorId, c.spaceId);
                    const commitment =
                        new FinancialCommitment<PersonalCommitmentVersion>(
                            randomUUID(),
                            c.spaceId.value,
                            c.description,
                            c.actorId.value,
                            now,
                            {
                                version: 1,
                                ownerPersonId: c.actorId.value,
                                amount: Money.from(c.amountInCents),
                                factDate: null,
                                expectedPaymentDate: c.expectedPaymentDate,
                            },
                            [],
                            today,
                        );
                    await this.commitments.save(commitment);
                    const result = {
                        ...personalExpenseView(commitment),
                        replayed: false,
                    };
                    await this.receipts.save(c, result, now);
                    return result;
                }
                const context = await this.context.lockForWrite(
                    c.actorId,
                    c.spaceId,
                );
                if (context.version !== c.expectedSpaceVersion)
                    throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
                if (
                    c.expectedPayerMemberId &&
                    !context.members.some(
                        (m) => m.memberId === c.expectedPayerMemberId,
                    )
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'expectedPayerMemberId',
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
                const rule = await this.rules.find(c.spaceId.value);
                const commitment = new FinancialCommitment(
                    randomUUID(),
                    c.spaceId.value,
                    c.description,
                    c.actorId.value,
                    now,
                    {
                        version: 1,
                        split,
                        expectedPayerMemberId: c.expectedPayerMemberId ?? null,
                        factDate: null,
                        expectedPaymentDate: c.expectedPaymentDate,
                        settlementRuleSnapshot: rule?.rule.snapshot ?? null,
                        settlementRuleSourceVersion: rule?.version ?? 0,
                        suggestedTargetDate: null,
                    },
                    [],
                    today,
                );
                await this.commitments.save(commitment);
                const result = {
                    ...expenseView(commitment, null, null),
                    replayed: false,
                };
                await this.receipts.save(c, result, now);
                return result;
            });
        } catch (error) {
            if (!(error instanceof ExpenseReceiptRaceError)) throw error;
            return this.uow.execute(async () => {
                await this.access.assertCanRead(c.actorId, c.spaceId);
                const prior = await this.receipts.find(c);
                if (!prior) throw error;
                return { ...prior, replayed: true };
            });
        }
    }
}
