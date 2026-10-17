import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
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
    type SpaceFinancialContext,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import {
    FINANCIAL_CHANGE_REPOSITORY,
    type FinancialChangeRepository,
    type FinancialChangeOrigin,
} from '../ports/private/financial-change.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';

export interface FinancialIntegrityCommand {
    actorId: PersonId;
    spaceId: SpaceId;
    commitmentId: string;
    idempotencyKey: string;
    expectedCommitmentVersion: number;
    expectedSpaceVersion?: number;
}

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, canonical(v)]),
        );
    return value;
}

@Injectable()
export class FinancialIntegrityCommands {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly contexts: SpaceFinancialContextPort,
        @Inject(FINANCIAL_CHANGE_REPOSITORY)
        private readonly repository: FinancialChangeRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}

    async execute<T extends object>(
        operation: string,
        c: FinancialIntegrityCommand,
        payload: unknown,
        work: (
            origin: FinancialChangeOrigin,
            context: SpaceFinancialContext | null,
            now: string,
        ) => Promise<T>,
    ) {
        const key = {
            actorId: c.actorId.value,
            spaceId: c.spaceId.value,
            commitmentId: c.commitmentId,
            operation,
            key: c.idempotencyKey,
            hash: createHash('sha256')
                .update(
                    JSON.stringify([
                        operation,
                        c.spaceId.value,
                        c.commitmentId,
                        canonical(payload),
                    ]),
                )
                .digest(),
        };
        const execute = () =>
            this.uow.execute(async () => {
                const access = await this.access.assertCanRead(
                    c.actorId,
                    c.spaceId,
                );
                const prior = await this.repository.receipt(key);
                if (prior) return { ...prior, replayed: true };
                const context =
                    access.type === 'SHARED'
                        ? await this.contexts.lockForWrite(c.actorId, c.spaceId)
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
                const origin = await this.repository.origin(
                    c.spaceId.value,
                    c.commitmentId,
                    true,
                );
                if (!origin)
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                const replay = await this.repository.receipt(key);
                if (replay) return { ...replay, replayed: true };
                if (origin.version !== c.expectedCommitmentVersion)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const now = this.clock.now().toISOString();
                const result = {
                    ...(await work(origin, context, now)),
                    replayed: false,
                };
                await this.repository.saveReceipt(key, result, now);
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
                const prior = await this.repository.receipt(key);
                if (!prior) throw error;
                return { ...prior, replayed: true };
            });
        }
    }
}
