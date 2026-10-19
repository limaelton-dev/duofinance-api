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
import {
    FinancialOccurrence,
    type OccurrenceFact,
} from '../../domain/recurrence/financial-occurrence.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import type { SettlementSelection } from '../../domain/shared-expense/settlement-selection.js';
import {
    RECURRING_COMMITMENT_REPOSITORY,
    type RecurringCommitmentRepository,
} from '../ports/private/recurring-commitment.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import { assertRecurringClosureCutoff } from './assert-recurring-closure-cutoff.js';
import { ReconcileFinancialOrigin } from './reconcile-financial-origin.js';
import { digest } from './recurring-command-digest.js';
import type { Fulfillment } from './recurring-commitment.commands.js';
import { rootView, view } from './recurring-commitment.models.js';
import { recurringFinancialOrigin } from './recurring-commitment.origin.js';

@Injectable()
export class RecordRecurringCommitmentHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(RECURRING_COMMITMENT_REPOSITORY)
        private readonly repository: RecurringCommitmentRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
        private readonly reconcile: ReconcileFinancialOrigin,
    ) {}

    async record(c: Fulfillment) {
        const operation =
            c.kind === 'DISBURSEMENT'
                ? 'RECORD_RECURRING_DISBURSEMENT'
                : c.kind === 'RECEIPT'
                  ? 'RECORD_RECURRING_RECEIPT'
                  : c.kind === 'EXTERNAL_LIABILITY'
                    ? 'RECORD_RECURRING_EXTERNAL_LIABILITY'
                    : 'SETTLE_RECURRING_EXTERNAL_LIABILITY';
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
                const context =
                    access.type === 'SHARED'
                        ? await this.context.lockForFulfillment(
                              c.actorId,
                              c.spaceId,
                          )
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
                if ((context !== null) !== 'expectedSpaceVersion' in c)
                    throw new FinancesError('VALIDATION_ERROR', [
                        'expectedSpaceVersion',
                    ]);
                const root = await this.repository.find(
                    c.spaceId.value,
                    c.commitmentId,
                    true,
                );
                if (!root)
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                if (
                    root.kind === 'INCOME'
                        ? c.kind !== 'RECEIPT'
                        : c.kind === 'RECEIPT'
                )
                    throw new FinancesError('VALIDATION_ERROR', ['kind']);
                const replay = await this.repository.findReceipt(
                    c.actorId.value,
                    operation,
                    c.idempotencyKey,
                    hash,
                );
                if (replay) return { ...(replay as object), replayed: true };
                const now = this.clock.now().toISOString(),
                    today = this.clock.today();
                const existing = await this.repository.occurrence(
                    root,
                    c.referenceDate,
                );
                assertRecurringClosureCutoff(
                    context,
                    c.referenceDate,
                    existing?.facts.length ?? 0,
                );
                if (
                    !existing &&
                    (
                        await this.repository.occurrencesInMonth(
                            root,
                            c.referenceDate.slice(0, 7),
                        )
                    ).length
                )
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                const configuration = existing
                    ? root.configurationForVersion(existing.economicVersion)
                    : root.projectedConfigurationAt(c.referenceDate);
                if (!configuration)
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                if (
                    (configuration.participation.type === 'SHARED') !==
                    (context !== null)
                )
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                if (c.kind === 'SETTLE_EXTERNAL_LIABILITY') {
                    if (
                        !existing ||
                        existing.stateVersion !== c.expectedOccurrenceVersion
                    )
                        throw new FinancesError('CONCURRENT_MODIFICATION');
                    if (civilDate(c.factDate) > today)
                        throw new FinancesError('VALIDATION_ERROR', [
                            'factDate',
                        ]);
                    const liability = existing.facts.find(
                        (f) =>
                            f.kind === 'EXTERNAL_LIABILITY' &&
                            f.id === c.liabilityId,
                    );
                    if (!liability || liability.kind !== 'EXTERNAL_LIABILITY')
                        throw new FinancesError('EXTERNAL_LIABILITY_NOT_FOUND');
                    if (
                        liability.holderMemberId
                            ? liability.holderMemberId !==
                              context?.actorMemberId
                            : liability.holderPersonId !== c.actorId.value
                    )
                        throw new FinancesError(
                            'EXTERNAL_LIABILITY_HOLDER_REQUIRED',
                        );
                    if (c.amountInCents > liability.remainingAmountInCents)
                        throw new FinancesError('CONCURRENT_MODIFICATION');
                    const settlement = await this.repository.settleExternal(
                        root,
                        existing,
                        c.liabilityId,
                        c.amountInCents,
                        c.factDate,
                        c.actorId.value,
                        c.idempotencyKey,
                        now,
                    );
                    const updated = await this.repository.occurrence(
                        root,
                        c.referenceDate,
                    );
                    const result = {
                        commitment: rootView(
                            root,
                            today,
                            context?.closureCutoffDate,
                        ),
                        occurrence: view(
                            configuration,
                            updated,
                            c.referenceDate,
                        ),
                        settlement,
                        replayed: false,
                    };
                    await this.repository.saveReceipt(
                        c.actorId.value,
                        c.spaceId.value,
                        root.id,
                        existing.id,
                        operation,
                        c.idempotencyKey,
                        hash,
                        result,
                        now,
                    );
                    return result;
                }
                if (root.version !== c.expectedCommitmentVersion)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const priorOccurrence =
                    existing ??
                    new FinancialOccurrence(
                        randomUUID(),
                        root.id,
                        root.spaceId,
                        c.referenceDate,
                        configuration.economicVersion,
                        1,
                        configuration.valueMode === 'FIXED'
                            ? configuration.amountInCents
                            : null,
                        [],
                        now,
                    );
                if (
                    priorOccurrence.stateVersion !== c.expectedOccurrenceVersion
                )
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const memberId =
                    c.kind === 'DISBURSEMENT'
                        ? 'payerMemberId' in c
                            ? c.payerMemberId
                            : null
                        : c.kind === 'RECEIPT'
                          ? 'recipientMemberId' in c
                              ? c.recipientMemberId
                              : null
                          : 'holderMemberId' in c
                            ? c.holderMemberId
                            : null;
                if (
                    context &&
                    (!memberId ||
                        !context.members.some((m) => m.memberId === memberId))
                )
                    throw new FinancesError('VALIDATION_ERROR', ['memberId']);
                const common = {
                    id: randomUUID(),
                    amountInCents: c.amountInCents,
                    factDate: c.factDate,
                    registeredAt: now,
                    recordedByPersonId: c.actorId.value,
                };
                const fact: OccurrenceFact =
                    c.kind === 'DISBURSEMENT'
                        ? {
                              ...common,
                              kind: 'DISBURSEMENT',
                              method: c.method,
                              payerMemberId: context ? memberId : null,
                              payerPersonId: context ? null : c.actorId.value,
                          }
                        : c.kind === 'RECEIPT'
                          ? {
                                ...common,
                                kind: 'RECEIPT',
                                recipientMemberId: context ? memberId : null,
                                recipientPersonId: context
                                    ? null
                                    : c.actorId.value,
                            }
                          : {
                                ...common,
                                kind: 'EXTERNAL_LIABILITY',
                                holderMemberId: context ? memberId : null,
                                holderPersonId: context
                                    ? null
                                    : c.actorId.value,
                                remainingAmountInCents: c.amountInCents,
                            };
                const next = priorOccurrence.record(
                    fact,
                    c.expectedOccurrenceVersion,
                    today,
                );
                await this.repository.record(
                    root,
                    next,
                    fact,
                    existing === null,
                );
                if (context && configuration.participation.type === 'SHARED') {
                    const synthetic = recurringFinancialOrigin(
                        configuration,
                        next,
                        today,
                    );
                    await this.reconcile.execute(
                        synthetic,
                        ('settlement' in c
                            ? c.settlement
                            : undefined) as SettlementSelection,
                        c.actorId.value,
                        today,
                        now,
                        next.id,
                    );
                }
                const result = {
                    commitment: rootView(
                        root,
                        today,
                        context?.closureCutoffDate,
                    ),
                    occurrence: view(configuration, next, c.referenceDate),
                    replayed: false,
                };
                await this.repository.saveReceipt(
                    c.actorId.value,
                    c.spaceId.value,
                    root.id,
                    next.id,
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
