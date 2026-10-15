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
import { IncomeCommitment } from '../../domain/income/income-commitment.js';
import { ReconcileFinancialOrigin } from './reconcile-financial-origin.js';
import { ResponsibilitySplit } from '../../domain/shared-expense/responsibility-split.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import type {
    IncomeResult,
    RecordIncomeCommand,
    RecordIncomeReceiptCommand,
} from '../models/income.js';
import {
    DEFAULT_SETTLEMENT_RULE_REPOSITORY,
    type DefaultSettlementRuleRepository,
} from '../ports/private/default-settlement-rule.repository.js';
import {
    INCOME_COMMAND_RECEIPTS,
    INCOME_REPOSITORY,
    IncomeReceiptRaceError,
    type IncomeCommandReceipts,
    type IncomeRepository,
} from '../ports/private/income.ports.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';

@Injectable()
export class RecordIncomeHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(DEFAULT_SETTLEMENT_RULE_REPOSITORY)
        private readonly rules: DefaultSettlementRuleRepository,
        @Inject(INCOME_REPOSITORY) private readonly incomes: IncomeRepository,
        @Inject(INCOME_COMMAND_RECEIPTS)
        private readonly receipts: IncomeCommandReceipts,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
        private readonly reconcile: ReconcileFinancialOrigin,
    ) {}

    async execute(c: RecordIncomeCommand): Promise<IncomeResult> {
        try {
            return await this.uow.execute(async () => {
                const access = await this.access.assertCanRead(
                    c.actorId,
                    c.spaceId,
                );
                const previous = await this.receipts.find(c);
                if (previous) return { ...previous, replayed: true };
                const shared = access.type === 'SHARED';
                if (shared !== 'participationSplit' in c)
                    throw new FinancesError(
                        shared
                            ? 'SHARED_SPACE_REQUIRED'
                            : 'PERSONAL_SPACE_REQUIRED',
                    );
                const context = shared
                    ? await this.context.lockForWrite(c.actorId, c.spaceId)
                    : null;
                if (!shared)
                    await this.access.assertCanWrite(c.actorId, c.spaceId);
                if (
                    context &&
                    'expectedSpaceVersion' in c &&
                    context.version !== c.expectedSpaceVersion
                )
                    throw new FinancesError('INCOME_OPTIONS_CHANGED');
                const today = this.clock.today();
                const now = this.clock.now().toISOString();
                if (c.receipt && civilDate(c.receipt.factDate) > today)
                    throw new FinancesError('VALIDATION_ERROR', [
                        'receipt.factDate',
                    ]);
                const p =
                    'participationSplit' in c && context
                        ? await (async () => {
                              const ids = context.members.map(
                                  (m) => m.memberId,
                              );
                              if (
                                  c.participationSplit.shares.length !==
                                      ids.length ||
                                  c.participationSplit.shares.some(
                                      (s) => !ids.includes(s.memberId),
                                  )
                              )
                                  throw new FinancesError('VALIDATION_ERROR', [
                                      'participationSplit.shares',
                                  ]);
                              if (
                                  c.expectedRecipientMemberId !== null &&
                                  !ids.includes(c.expectedRecipientMemberId)
                              )
                                  throw new FinancesError('VALIDATION_ERROR', [
                                      'expectedRecipientMemberId',
                                  ]);
                              if (
                                  c.receipt &&
                                  (!('recipientMemberId' in c.receipt) ||
                                      !ids.includes(
                                          c.receipt.recipientMemberId,
                                      ))
                              )
                                  throw new FinancesError('VALIDATION_ERROR', [
                                      'receipt.recipientMemberId',
                                  ]);
                              const rule = await this.rules.find(
                                  c.spaceId.value,
                              );
                              return {
                                  type: 'SHARED' as const,
                                  split: ResponsibilitySplit.create(
                                      c.amountInCents,
                                      ids,
                                      c.participationSplit,
                                  ),
                                  expectedRecipientMemberId:
                                      c.expectedRecipientMemberId,
                                  settlementRuleSnapshot:
                                      rule?.rule.snapshot ?? null,
                                  settlementRuleSourceVersion:
                                      rule?.version ?? 0,
                              };
                          })()
                        : {
                              type: 'PERSONAL' as const,
                              ownerPersonId: c.actorId.value,
                          };
                const pending = new IncomeCommitment(
                    randomUUID(),
                    c.spaceId.value,
                    c.description.trim(),
                    c.amountInCents,
                    c.expectedReceiptDate,
                    c.actorId.value,
                    now,
                    p,
                );
                const income = c.receipt
                    ? pending.recordReceipt(
                          {
                              id: randomUUID(),
                              amountInCents:
                                  c.receipt.amountInCents ?? c.amountInCents,
                              factDate: c.receipt.factDate,
                              registeredAt: now,
                              recordedByPersonId: c.actorId.value,
                              recipientPersonId: shared
                                  ? null
                                  : c.actorId.value,
                              recipientMemberId:
                                  'recipientMemberId' in c.receipt
                                      ? c.receipt.recipientMemberId
                                      : null,
                          },
                          1,
                          today,
                      )
                    : pending;
                await this.incomes.save(income);
                if (income.receipt && 'settlement' in c.receipt!)
                    await this.reconcile.execute(
                        income,
                        c.receipt!.settlement,
                        c.actorId.value,
                        today,
                        now,
                    );
                const detail = await this.incomes.detail(
                    c.spaceId.value,
                    income.id,
                );
                const result = {
                    ...detail!,
                    ...(context ? { members: context.members } : {}),
                    replayed: false,
                };
                await this.receipts.save(c, result, now);
                return result;
            });
        } catch (error) {
            if (!(error instanceof IncomeReceiptRaceError)) throw error;
            return this.uow.execute(async () => {
                await this.access.assertCanRead(c.actorId, c.spaceId);
                const previous = await this.receipts.find(c);
                if (!previous) throw error;
                return { ...previous, replayed: true };
            });
        }
    }

    async recordReceipt(c: RecordIncomeReceiptCommand): Promise<IncomeResult> {
        try {
            return await this.uow.execute(async () => {
                const access = await this.access.assertCanRead(
                    c.actorId,
                    c.spaceId,
                );
                const previous = await this.receipts.find(c);
                if (previous) return { ...previous, replayed: true };
                const shared = access.type === 'SHARED';
                if (shared !== 'recipientMemberId' in c)
                    throw new FinancesError(
                        shared
                            ? 'SHARED_SPACE_REQUIRED'
                            : 'PERSONAL_SPACE_REQUIRED',
                    );
                const context = shared
                    ? await this.context.lockForFulfillment(
                          c.actorId,
                          c.spaceId,
                      )
                    : null;
                if (!shared)
                    await this.access.assertCanWrite(c.actorId, c.spaceId);
                if (context && context.version !== c.expectedSpaceVersion)
                    throw new FinancesError('INCOME_OPTIONS_CHANGED');
                const existing = await this.incomes.find(
                    c.spaceId.value,
                    c.commitmentId,
                    true,
                );
                if (!existing || existing.participation.type !== access.type)
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                if (
                    context &&
                    existing.participation.type === 'SHARED' &&
                    (!context.members.some(
                        (m) => m.memberId === c.recipientMemberId,
                    ) ||
                        !existing.participation.split.shares.some(
                            (s) => s.memberId === c.recipientMemberId,
                        ))
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'recipientMemberId',
                    ]);
                const concurrentReceipt = await this.receipts.find(c);
                if (concurrentReceipt)
                    return { ...concurrentReceipt, replayed: true };
                if (
                    c.amountInCents === undefined &&
                    existing.receipts.length > 0 &&
                    existing.remainingAmountInCents > 0
                )
                    throw new FinancesError('INCOME_OPTIONS_CHANGED');
                const today = this.clock.today();
                const now = this.clock.now().toISOString();
                const income = existing.recordReceipt(
                    {
                        id: randomUUID(),
                        amountInCents:
                            c.amountInCents ?? existing.amountInCents,
                        factDate: c.factDate,
                        registeredAt: now,
                        recordedByPersonId: c.actorId.value,
                        recipientPersonId: shared ? null : c.actorId.value,
                        recipientMemberId: shared ? c.recipientMemberId! : null,
                    },
                    c.expectedCommitmentVersion,
                    today,
                );
                await this.incomes.saveReceipt(income, existing.version);
                if (shared)
                    await this.reconcile.execute(
                        income,
                        c.settlement!,
                        c.actorId.value,
                        today,
                        now,
                    );
                const detail = await this.incomes.detail(
                    c.spaceId.value,
                    income.id,
                );
                const result = {
                    ...detail!,
                    ...(context ? { members: context.members } : {}),
                    replayed: false,
                };
                await this.receipts.save(c, result, now);
                return result;
            });
        } catch (error) {
            if (!(error instanceof IncomeReceiptRaceError)) throw error;
            return this.uow.execute(async () => {
                await this.access.assertCanRead(c.actorId, c.spaceId);
                const previous = await this.receipts.find(c);
                if (!previous) throw error;
                return { ...previous, replayed: true };
            });
        }
    }
}
