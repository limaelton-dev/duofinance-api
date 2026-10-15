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
import {
    DEFAULT_SETTLEMENT_RULE_REPOSITORY,
    type DefaultSettlementRuleRepository,
} from '../ports/private/default-settlement-rule.repository.js';
import {
    FINANCIAL_COMMITMENT_REPOSITORY,
    FINANCES_CLOCK,
    ExpenseReceiptRaceError,
    type FinancialCommitmentRepository,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import {
    CREDIT_CARD_RECEIPTS,
    type CreditCardReceipts,
} from '../ports/private/credit-card-receipts.js';
import {
    FinancialCommitment,
    type ExpenseVersion,
    type PersonalCommitmentVersion,
} from '../../domain/shared-expense/financial-commitment.js';
import { ResponsibilitySplit } from '../../domain/shared-expense/responsibility-split.js';
import { Money } from '../../domain/shared-expense/money.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import { personalExpenseView } from '../models/personal-expense.js';
import type {
    CreditCardCommand,
    CreditCardResult,
} from '../models/credit-card-purchase.js';
import { ReconcileFinancialOrigin } from './reconcile-financial-origin.js';
@Injectable()
export class RecordCreditCardPurchaseHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(DEFAULT_SETTLEMENT_RULE_REPOSITORY)
        private readonly rules: DefaultSettlementRuleRepository,
        @Inject(FINANCIAL_COMMITMENT_REPOSITORY)
        private readonly commitments: FinancialCommitmentRepository,
        @Inject(CREDIT_CARD_RECEIPTS)
        private readonly receipts: CreditCardReceipts,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
        private readonly reconcile: ReconcileFinancialOrigin,
    ) {}
    async execute(c: CreditCardCommand): Promise<CreditCardResult> {
        try {
            return await this.uow.execute(async () => {
                const access = await this.access.assertCanRead(
                    c.actorId,
                    c.spaceId,
                );
                const previous = await this.receipts.find(c);
                if (previous) return { ...previous, replayed: true };
                const shared = access.type === 'SHARED',
                    additional = 'commitmentId' in c;
                const holder = additional
                    ? c.holderMemberId
                    : c.externalLiability.holderMemberId;
                if (shared !== (holder !== undefined))
                    throw new FinancesError(
                        shared
                            ? 'SHARED_SPACE_REQUIRED'
                            : 'PERSONAL_SPACE_REQUIRED',
                    );
                const context = shared
                    ? await (additional
                          ? this.context.lockForFulfillment(
                                c.actorId,
                                c.spaceId,
                            )
                          : this.context.lockForWrite(c.actorId, c.spaceId))
                    : null;
                if (!shared)
                    await this.access.assertCanWrite(c.actorId, c.spaceId);
                if (context && context.version !== c.expectedSpaceVersion)
                    throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
                const existing = additional
                    ? await this.commitments.find(
                          c.spaceId.value,
                          c.commitmentId,
                          true,
                      )
                    : null;
                if (
                    additional &&
                    (!existing || shared !== 'split' in existing.initialVersion)
                )
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                const replay = await this.receipts.find(c);
                if (replay) return { ...replay, replayed: true };
                if (
                    context &&
                    !context.members.some((m) => m.memberId === holder)
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'holderMemberId',
                    ]);
                const now = this.clock.now().toISOString(),
                    today = this.clock.today();
                const amount = additional
                    ? c.amountInCents
                    : (c.externalLiability.amountInCents ?? c.amountInCents);
                const liability = {
                    id: randomUUID(),
                    amountInCents: amount,
                    remainingAmountInCents: amount,
                    factDate: c.factDate,
                    registeredAt: now,
                    recordedByPersonId: c.actorId.value,
                    ...(shared
                        ? { holderMemberId: holder! }
                        : { holderPersonId: c.actorId.value }),
                };
                let next: FinancialCommitment<ExpenseVersion>;
                if (additional) {
                    next = existing!.recordExternalLiability(
                        liability,
                        c.expectedCommitmentVersion,
                        today,
                    );
                    await this.commitments.saveExternalLiability(
                        next,
                        existing!.version,
                    );
                } else {
                    let initial: ExpenseVersion;
                    if (context) {
                        const input = c.responsibilitySplit;
                        if (
                            !input ||
                            input.shares.length !== context.members.length ||
                            input.shares.some(
                                (s) =>
                                    !context.members.some(
                                        (m) => m.memberId === s.memberId,
                                    ),
                            )
                        )
                            throw new FinancesError('VALIDATION_ERROR', [
                                'responsibilitySplit',
                            ]);
                        if (
                            c.expectedPayerMemberId &&
                            !context.members.some(
                                (m) => m.memberId === c.expectedPayerMemberId,
                            )
                        )
                            throw new FinancesError('VALIDATION_ERROR', [
                                'expectedPayerMemberId',
                            ]);
                        const rule = await this.rules.find(c.spaceId.value);
                        initial = {
                            version: 1,
                            split: ResponsibilitySplit.create(
                                c.amountInCents,
                                context.members.map((m) => m.memberId),
                                input,
                            ),
                            expectedPayerMemberId:
                                c.expectedPayerMemberId ?? null,
                            factDate: c.factDate,
                            settlementRuleSnapshot: rule?.rule.snapshot ?? null,
                            settlementRuleSourceVersion: rule?.version ?? 0,
                            suggestedTargetDate:
                                rule?.rule.suggestTargetDate(today) ?? null,
                        };
                    } else
                        initial = {
                            version: 1,
                            ownerPersonId: c.actorId.value,
                            amount: Money.from(c.amountInCents),
                            factDate: c.factDate,
                        };
                    next = new FinancialCommitment(
                        randomUUID(),
                        c.spaceId.value,
                        c.description.trim(),
                        c.actorId.value,
                        now,
                        initial,
                        [],
                        today,
                        undefined,
                        [liability],
                    );
                    await this.commitments.save(next);
                }
                if (shared)
                    await this.reconcile.execute(
                        next,
                        c.settlement!,
                        c.actorId.value,
                        today,
                        now,
                    );
                const detail = shared
                    ? await this.commitments.detail(c.spaceId.value, next.id)
                    : personalExpenseView(
                          next as FinancialCommitment<PersonalCommitmentVersion>,
                      );
                if (!detail) throw new Error('Persisted expense missing');
                const result = {
                    ...detail,
                    externalLiability: next.externalLiabilities.at(-1)!,
                    ...(context ? { members: context.members } : {}),
                    replayed: false,
                };
                await this.receipts.save(c, result, now);
                return result;
            });
        } catch (error) {
            if (!(error instanceof ExpenseReceiptRaceError)) throw error;
            return this.uow.execute(async () => {
                await this.access.assertCanRead(c.actorId, c.spaceId);
                const previous = await this.receipts.find(c);
                if (!previous) throw error;
                return { ...previous, replayed: true };
            });
        }
    }
}
