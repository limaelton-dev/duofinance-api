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
import type { CancellationDto } from '../../http/dto/financial-correction.dto.js';
import {
    FINANCIAL_CORRECTION_REPOSITORY,
    type FinancialCorrectionRepository,
} from '../ports/private/financial-correction.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import {
    FinancialIntegrityCommands,
    type FinancialIntegrityCommand,
} from './financial-integrity-commands.js';

@Injectable()
export class FinancialCommitmentCancellations {
    constructor(
        private readonly commands: FinancialIntegrityCommands,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly contexts: SpaceFinancialContextPort,
        @Inject(FINANCIAL_CORRECTION_REPOSITORY)
        private readonly repository: FinancialCorrectionRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    preview(
        actor: PersonId,
        space: SpaceId,
        id: string,
        input: CancellationDto,
    ) {
        return this.repository.snapshot(async () => {
            const { preview } = await this.assess(actor, space, id, input);
            await this.access.assertCanRead(actor, space);
            return preview;
        });
    }
    confirm(command: FinancialIntegrityCommand, input: CancellationDto) {
        return this.commands.execute(
            'CANCEL_COMMITMENT',
            command,
            input,
            async () => {
                const { state, preview } = await this.assess(
                    command.actorId,
                    command.spaceId,
                    command.commitmentId,
                    input,
                    true,
                );
                const cancellation = {
                    id: randomUUID(),
                    spaceId: state.spaceId,
                    commitmentId: state.id,
                    commitmentVersion: state.version + 1,
                    reason: input.reason,
                    factDate: input.factDate,
                    actorId: command.actorId.value,
                    registeredAt: this.clock.now().toISOString(),
                };
                await this.repository.cancel(state, cancellation);
                return {
                    ...preview,
                    cancellation,
                    version: state.version + 1,
                    status: 'CANCELLED',
                };
            },
            'CORRECTION',
        );
    }
    private async assess(
        actor: PersonId,
        space: SpaceId,
        id: string,
        input: CancellationDto,
        lock = false,
    ) {
        const access = await this.access.assertCanRead(actor, space);
        const context =
            access.type === 'SHARED'
                ? lock
                    ? await this.contexts.lockForFulfillment(actor, space)
                    : await this.contexts.read(actor, space)
                : null;
        if ((context !== null) !== (input.expectedSpaceVersion !== undefined))
            throw new FinancesError('VALIDATION_ERROR', [
                'expectedSpaceVersion',
            ]);
        if (context && context.version !== input.expectedSpaceVersion)
            throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
        if (input.factDate > this.clock.today())
            throw new FinancesError('VALIDATION_ERROR', ['factDate']);
        const state = await this.repository.read(
            space.value,
            id,
            {},
            this.clock.now().toISOString(),
            lock,
        );
        if (!state) throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        if (state.version !== input.expectedCommitmentVersion)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        if (
            state.modality !== 'ONE_TIME' ||
            state.cancelled ||
            state.fulfilledAmountInCents > 0
        )
            throw new FinancesError('FINANCIAL_CANCELLATION_NOT_ALLOWED');
        return {
            state,
            preview: {
                commitmentId: id,
                currentVersion: state.version,
                kind: state.kind,
                modality: state.modality,
                amountInCents: state.amountInCents,
                fulfilledAmountInCents: state.fulfilledAmountInCents,
                remainingAmountInCents: state.amountInCents,
                adjustments: state.adjustments,
                facts: state.facts,
                eligible: true,
            },
        };
    }
}
