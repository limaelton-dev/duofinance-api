import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
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
import { RecurrenceRule } from '../../domain/recurrence/recurrence-rule.js';
import { RecurringCommitment } from '../../domain/recurrence/recurring-commitment.js';
import { ResponsibilitySplit } from '../../domain/shared-expense/responsibility-split.js';
import {
    DEFAULT_SETTLEMENT_RULE_REPOSITORY,
    type DefaultSettlementRuleRepository,
} from '../ports/private/default-settlement-rule.repository.js';
import {
    RECURRING_COMMITMENT_REPOSITORY,
    type RecurringCommitmentRepository,
} from '../ports/private/recurring-commitment.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import { digest } from './recurring-command-digest.js';
import type { Create } from './recurring-commitment.commands.js';
import { rootView } from './recurring-commitment.models.js';

@Injectable()
export class CreateRecurringCommitmentHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(DEFAULT_SETTLEMENT_RULE_REPOSITORY)
        private readonly rules: DefaultSettlementRuleRepository,
        @Inject(RECURRING_COMMITMENT_REPOSITORY)
        private readonly repository: RecurringCommitmentRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}

    async create(c: Create) {
        const operation = 'CREATE_RECURRING_COMMITMENT';
        const hash = digest(operation, c.spaceId.value, {
            ...c,
            actorId: undefined,
            spaceId: undefined,
            idempotencyKey: undefined,
        });
        const execute = async () =>
            this.uow.execute(async () => {
                const access = await this.access.assertCanRead(
                    c.actorId,
                    c.spaceId,
                );
                const prior = await this.repository.findReceipt(
                    c.actorId.value,
                    operation,
                    c.idempotencyKey,
                    hash,
                );
                if (prior) return { ...(prior as object), replayed: true };
                if (access.type !== c.scope)
                    throw new FinancesError(
                        c.scope === 'PERSONAL'
                            ? 'PERSONAL_SPACE_REQUIRED'
                            : 'SHARED_SPACE_REQUIRED',
                    );
                const context =
                    c.scope === 'SHARED'
                        ? await this.context.lockForWrite(c.actorId, c.spaceId)
                        : null;
                if (!context)
                    await this.access.assertCanWrite(c.actorId, c.spaceId);
                if (
                    context &&
                    context.version !==
                        ('expectedSpaceVersion' in c
                            ? c.expectedSpaceVersion
                            : undefined)
                )
                    throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
                const participation =
                    context && c.scope === 'SHARED'
                        ? await (async () => {
                              const ids = context.members.map(
                                  (m) => m.memberId,
                              );
                              if (
                                  c.distribution.shares.length !== ids.length ||
                                  c.distribution.shares.some(
                                      (s) => !ids.includes(s.memberId),
                                  ) ||
                                  (c.expectedMemberId &&
                                      !ids.includes(c.expectedMemberId))
                              )
                                  throw new FinancesError('VALIDATION_ERROR', [
                                      'distribution',
                                  ]);
                              const rule = await this.rules.find(
                                  c.spaceId.value,
                              );
                              return {
                                  type: 'SHARED' as const,
                                  split:
                                      c.valueMode === 'FIXED'
                                          ? ResponsibilitySplit.create(
                                                c.amountInCents,
                                                ids,
                                                c.distribution,
                                            )
                                          : null,
                                  distribution: c.distribution,
                                  expectedMemberId: c.expectedMemberId ?? null,
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
                const now = this.clock.now().toISOString();
                const root = new RecurringCommitment(
                    randomUUID(),
                    c.spaceId.value,
                    c.kind,
                    c.description,
                    c.valueMode === 'FIXED'
                        ? c.amountInCents
                        : (c.expectedAmountInCents ?? null),
                    new RecurrenceRule(
                        c.recurrence,
                        c.startsOn ?? this.clock.today(),
                        c.endsOn ?? null,
                    ),
                    c.actorId.value,
                    now,
                    1,
                    1,
                    participation,
                    c.valueMode,
                );
                await this.repository.save(root);
                const result = {
                    commitment: rootView(root, this.clock.today()),
                    replayed: false,
                };
                await this.repository.saveReceipt(
                    c.actorId.value,
                    c.spaceId.value,
                    root.id,
                    null,
                    operation,
                    c.idempotencyKey,
                    hash,
                    result,
                    now,
                );
                return result;
            });
        try {
            return await execute();
        } catch (error) {
            if (
                !(error instanceof QueryFailedError) ||
                error.driverError.code !== '23505'
            )
                throw error;
            return this.uow.execute(async () => {
                await this.access.assertCanRead(c.actorId, c.spaceId);
                const prior = await this.repository.findReceipt(
                    c.actorId.value,
                    operation,
                    c.idempotencyKey,
                    hash,
                );
                if (!prior) throw error;
                return { ...(prior as object), replayed: true };
            });
        }
    }
}
