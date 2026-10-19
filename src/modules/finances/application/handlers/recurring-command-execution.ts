import { Inject, Injectable } from '@nestjs/common';
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
    RECURRING_COMMITMENT_REPOSITORY,
    type RecurringCommitmentRepository,
} from '../ports/private/recurring-commitment.repository.js';
import { digest } from './recurring-command-digest.js';
import type { Base } from './recurring-commitment.commands.js';

@Injectable()
export class RecurringCommandExecution {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(RECURRING_COMMITMENT_REPOSITORY)
        private readonly repository: RecurringCommitmentRepository,
    ) {}

    async execute<T extends object>(
        operation: string,
        c: Base & { commitmentId: string },
        work: (hash: Buffer) => Promise<T>,
    ) {
        const hash = digest(operation, c.spaceId.value, {
            ...c,
            actorId: undefined,
            spaceId: undefined,
            idempotencyKey: undefined,
        });
        const execute = () =>
            this.uow.execute(async () => {
                await this.access.assertCanRead(c.actorId, c.spaceId);
                const prior = await this.repository.findReceipt(
                    c.actorId.value,
                    operation,
                    c.idempotencyKey,
                    hash,
                );
                if (prior)
                    return { ...(prior as object), replayed: true } as T & {
                        replayed: boolean;
                    };
                return work(hash);
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
                return { ...(prior as object), replayed: true } as T & {
                    replayed: boolean;
                };
            });
        }
    }
}
