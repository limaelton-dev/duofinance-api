import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../../spaces/application/ports/public/space-access.port.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import { FinancialOccurrence } from '../../domain/recurrence/financial-occurrence.js';
import { RecurringCommitment } from '../../domain/recurrence/recurring-commitment.js';
import type {
    CancelRecurringOccurrenceDto,
    TerminateRecurringCommitmentDto,
} from '../../http/dto/recurring-commitment.dto.js';
import {
    RECURRING_COMMITMENT_REPOSITORY,
    type RecurringCommitmentRepository,
} from '../ports/private/recurring-commitment.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import { assertRecurringClosureCutoff } from './assert-recurring-closure-cutoff.js';
import { RecurringCommandExecution } from './recurring-command-execution.js';
import type { Base } from './recurring-commitment.commands.js';
import { rootView, view } from './recurring-commitment.models.js';

@Injectable()
export class MaintainRecurringCommitmentHandler {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(RECURRING_COMMITMENT_REPOSITORY)
        private readonly repository: RecurringCommitmentRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
        private readonly commands: RecurringCommandExecution,
    ) {}

    async terminationPreview(
        actor: PersonId,
        space: SpaceId,
        id: string,
        input: TerminateRecurringCommitmentDto,
    ) {
        const access = await this.access.assertCanRead(actor, space);
        const result = await this.repository.readSnapshot(async () => {
            const context =
                access.type === 'SHARED'
                    ? await this.context.read(actor, space)
                    : null;
            if (
                (context !== null) !==
                (input.expectedSpaceVersion !== undefined)
            )
                throw new FinancesError('VALIDATION_ERROR', [
                    'expectedSpaceVersion',
                ]);
            if (context && context.version !== input.expectedSpaceVersion)
                throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
            const root = await this.repository.find(space.value, id);
            if (!root)
                throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
            if (root.version !== input.expectedCommitmentVersion)
                throw new FinancesError('CONCURRENT_MODIFICATION');
            if (root.terminatedOn)
                throw new FinancesError('RECURRENCE_ALREADY_TERMINATED');
            if (input.endsOn < this.clock.today())
                throw new FinancesError('VALIDATION_ERROR', ['endsOn']);
            const next = new Date(`${input.endsOn}T00:00:00Z`);
            next.setUTCDate(next.getUTCDate() + 1);
            const preserved = await this.repository.materializedAfter(
                root,
                next.toISOString().slice(0, 10),
            );

            return {
                commitmentId: id,
                currentVersion: root.version,
                endsOn: input.endsOn,
                materializedOccurrencesPreserved: preserved,
            };
        });
        await this.access.assertCanRead(actor, space);
        return result;
    }

    terminate(
        c: Base & { commitmentId: string } & TerminateRecurringCommitmentDto,
    ) {
        return this.commands.execute(
            'TERMINATE_RECURRING_COMMITMENT',
            c,
            async (hash) => {
                const access = await this.access.assertCanRead(
                    c.actorId,
                    c.spaceId,
                );
                const context =
                    access.type === 'SHARED'
                        ? await this.context.lockForWrite(c.actorId, c.spaceId)
                        : null;
                if (!context)
                    await this.access.assertCanWrite(c.actorId, c.spaceId);
                if (
                    (context !== null) !==
                    (c.expectedSpaceVersion !== undefined)
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'expectedSpaceVersion',
                    ]);
                if (context && context.version !== c.expectedSpaceVersion)
                    throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
                const root = await this.repository.find(
                    c.spaceId.value,
                    c.commitmentId,
                    true,
                );
                if (!root)
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                if (root.version !== c.expectedCommitmentVersion)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                if (root.terminatedOn)
                    throw new FinancesError('RECURRENCE_ALREADY_TERMINATED');
                if (c.endsOn < this.clock.today())
                    throw new FinancesError('VALIDATION_ERROR', ['endsOn']);
                const firstAfter = new Date(`${c.endsOn}T00:00:00Z`);
                firstAfter.setUTCDate(firstAfter.getUTCDate() + 1);
                const preserved = await this.repository.materializedAfter(
                    root,
                    firstAfter.toISOString().slice(0, 10),
                );
                const now = this.clock.now().toISOString();
                await this.repository.terminate(
                    root,
                    c.endsOn,
                    c.actorId.value,
                    now,
                );
                const latest = new RecurringCommitment(
                    root.id,
                    root.spaceId,
                    root.kind,
                    root.description,
                    root.amountInCents,
                    root.rule,
                    root.createdByPersonId,
                    root.registeredAt,
                    root.economicVersion,
                    root.version + 1,
                    root.participation,
                    root.valueMode,
                    root.effectiveFrom,
                    root.versions,
                    c.endsOn,
                );
                const result = {
                    commitment: rootView(latest, this.clock.today()),
                    materializedOccurrencesPreserved: preserved,
                    replayed: false,
                };
                await this.repository.saveReceipt(
                    c.actorId.value,
                    c.spaceId.value,
                    root.id,
                    null,
                    'TERMINATE_RECURRING_COMMITMENT',
                    c.idempotencyKey,
                    hash,
                    result,
                    now,
                );
                return result;
            },
        );
    }

    cancelOccurrence(
        c: Base & {
            commitmentId: string;
            referenceDate: string;
        } & CancelRecurringOccurrenceDto,
    ) {
        return this.commands.execute(
            'CANCEL_RECURRING_OCCURRENCE',
            c,
            async (hash) => {
                const access = await this.access.assertCanRead(
                    c.actorId,
                    c.spaceId,
                );
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
                    (context !== null) !==
                    (c.expectedSpaceVersion !== undefined)
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'expectedSpaceVersion',
                    ]);
                if (context && context.version !== c.expectedSpaceVersion)
                    throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
                const root = await this.repository.find(
                    c.spaceId.value,
                    c.commitmentId,
                    true,
                );
                if (!root)
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                if (root.version !== c.expectedCommitmentVersion)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
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
                const now = this.clock.now().toISOString();
                const pending =
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
                const canceled = pending.cancel(
                    c.expectedOccurrenceVersion,
                    c.actorId.value,
                    now,
                );
                await this.repository.cancel(root, canceled, existing === null);
                const result = {
                    commitment: rootView(root, this.clock.today()),
                    occurrence: view(configuration, canceled, c.referenceDate),
                    replayed: false,
                };
                await this.repository.saveReceipt(
                    c.actorId.value,
                    c.spaceId.value,
                    root.id,
                    canceled.id,
                    'CANCEL_RECURRING_OCCURRENCE',
                    c.idempotencyKey,
                    hash,
                    result,
                    now,
                );
                return result;
            },
        );
    }
}
