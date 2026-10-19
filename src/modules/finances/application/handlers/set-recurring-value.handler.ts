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
import { FinancialOccurrence } from '../../domain/recurrence/financial-occurrence.js';
import {
    RECURRING_COMMITMENT_REPOSITORY,
    type RecurringCommitmentRepository,
} from '../ports/private/recurring-commitment.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import { assertRecurringClosureCutoff } from './assert-recurring-closure-cutoff.js';
import { digest } from './recurring-command-digest.js';
import type { SetValue } from './recurring-commitment.commands.js';
import { rootView, view } from './recurring-commitment.models.js';

@Injectable()
export class SetRecurringValueHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(RECURRING_COMMITMENT_REPOSITORY)
        private readonly repository: RecurringCommitmentRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}

    async setValue(c: SetValue) {
        const operation = 'SET_RECURRING_OCCURRENCE_VALUE';
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
                if ((context !== null) !== 'expectedSpaceVersion' in c)
                    throw new FinancesError('VALIDATION_ERROR', [
                        'expectedSpaceVersion',
                    ]);
                if (
                    context &&
                    context.version !==
                        ('expectedSpaceVersion' in c
                            ? c.expectedSpaceVersion
                            : undefined)
                )
                    throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
                const root = await this.repository.find(
                    c.spaceId.value,
                    c.commitmentId,
                    true,
                );
                if (!root)
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                const replay = await this.repository.findReceipt(
                    c.actorId.value,
                    operation,
                    c.idempotencyKey,
                    hash,
                );
                if (replay) return { ...(replay as object), replayed: true };
                if (root.version !== c.expectedCommitmentVersion)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const now = this.clock.now().toISOString();
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
                if (configuration.valueMode !== 'VARIABLE')
                    throw new FinancesError('VALIDATION_ERROR', ['valueMode']);
                if (
                    (configuration.participation.type === 'SHARED') !==
                    (context !== null)
                )
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                const occurrence =
                    existing ??
                    new FinancialOccurrence(
                        randomUUID(),
                        root.id,
                        root.spaceId,
                        c.referenceDate,
                        configuration.economicVersion,
                        1,
                        null,
                        [],
                        now,
                    );
                const next = occurrence.defineValue(
                    c.amountInCents,
                    c.expectedOccurrenceVersion,
                    c.actorId.value,
                    now,
                );
                const shares =
                    configuration.effectiveSplit(c.amountInCents)?.shares ??
                    null;
                await this.repository.defineValue(
                    root,
                    next,
                    shares,
                    existing === null,
                );
                const result = {
                    commitment: rootView(
                        root,
                        this.clock.today(),
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
