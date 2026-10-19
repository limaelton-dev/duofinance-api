import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
    FINANCIAL_CLOSURE_DESTINATIONS_PORT,
    type FinancialClosureDestinationsPort,
} from '../../modules/finances/application/ports/public/financial-closure-destinations.port.js';
import { SpacesDomainError } from '../../modules/spaces/domain/errors/spaces-domain.error.js';
import type { FutureDestinationInput } from './closure.dto.js';
import {
    UNIT_OF_WORK,
    type UnitOfWork,
} from '../../shared/application/unit-of-work.js';
import { EntityManagerProvider } from '../../shared/technical/database/typeorm/entity-manager.provider.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../modules/spaces/application/ports/public/space-access.port.js';
import {
    SPACE_CLOSURE_PORT,
    type SpaceClosurePort,
} from '../../modules/spaces/application/ports/public/space-closure.port.js';
import {
    FINANCIAL_CLOSURE_DIAGNOSTICS_PORT,
    type FinancialClosureDiagnosticsPort,
} from '../../modules/finances/application/ports/public/financial-closure-diagnostics.port.js';
import {
    ROUTINE_CLOSURE_PORT,
    type RoutineClosurePort,
} from '../../modules/routine/application/ports/public/routine-closure.port.js';
import {
    SHOPPING_CLOSURE_PORT,
    type ShoppingClosurePort,
} from '../../modules/shopping/application/ports/public/shopping-closure.port.js';
import { PersonId } from '../../modules/spaces/domain/person/person-id.js';
import { SpaceId } from '../../modules/spaces/domain/space/space-id.js';
import { CLOSURE_CLOCK, type ClosureClock } from './closure.clock.js';
import { todayReferenceDate } from '../today/today.clock.js';

@Injectable()
export class ClosureService {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        private readonly manager: EntityManagerProvider,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_CLOSURE_PORT) private readonly spaces: SpaceClosurePort,
        @Inject(FINANCIAL_CLOSURE_DIAGNOSTICS_PORT)
        private readonly finances: FinancialClosureDiagnosticsPort,
        @Inject(ROUTINE_CLOSURE_PORT)
        private readonly routine: RoutineClosurePort,
        @Inject(SHOPPING_CLOSURE_PORT)
        private readonly shopping: ShoppingClosurePort,
        @Inject(CLOSURE_CLOCK) private readonly clock: ClosureClock,
        @Inject(FINANCIAL_CLOSURE_DESTINATIONS_PORT)
        private readonly destinations: FinancialClosureDestinationsPort,
    ) {}
    async start(
        actorId: string,
        spaceId: string,
        key: string,
        input: { expectedSpaceVersion: number },
    ) {
        return this.uow.execute(
            async () =>
                (
                    await this.spaces.start({
                        actorId,
                        spaceId,
                        idempotencyKey: key,
                        ...input,
                        now: this.clock.now(),
                    })
                ).view,
        );
    }
    async cutoff(
        actorId: string,
        spaceId: string,
        key: string,
        input: {
            expectedSpaceVersion: number;
            expectedPlanRevision: number;
            cutoffDate: string;
        },
    ) {
        return this.uow.execute(
            async () =>
                (
                    await this.spaces.proposeCutoff({
                        actorId,
                        spaceId,
                        idempotencyKey: key,
                        ...input,
                        now: this.clock.now(),
                    })
                ).view,
        );
    }
    read(actorId: string, spaceId: string) {
        return this.spaces.read(actorId, spaceId);
    }
    async destination(
        actorId: string,
        spaceId: string,
        key: string,
        input: FutureDestinationInput,
    ) {
        const { expectedSpaceVersion, expectedPlanRevision, ...choice } = input;
        const intent = {
            ...choice,
            assigneeMemberId:
                'assigneeMemberId' in choice ? choice.assigneeMemberId : null,
            amountInCents:
                'amountInCents' in choice ? choice.amountInCents : null,
        };
        const command = {
            actorId,
            spaceId,
            idempotencyKey: key,
            expectedSpaceVersion,
            expectedPlanRevision,
            intent,
            now: this.clock.now(),
        };
        return this.uow.execute(async () => {
            const closure = await this.spaces.lockForProcess(actorId, spaceId);
            const replay = await this.spaces.replayDestination(command);
            if (replay) return replay.view;
            if (
                !closure ||
                closure.spaceStatus !== 'CLOSING' ||
                closure.processStatus !== 'OPEN'
            )
                throw new SpacesDomainError('CLOSURE_PROCESS_NOT_OPEN');
            if (
                closure.spaceVersion !== expectedSpaceVersion ||
                closure.planRevision !== expectedPlanRevision
            )
                throw new ConflictException({
                    code: 'CONCURRENT_MODIFICATION',
                    message:
                        'O estado mudou. Atualize o plano e confirme novamente.',
                    details: {},
                });
            const destination = await this.destinations.preview(
                actorId,
                spaceId,
                closure.proposedCutoffDate ?? closure.cutoffDate,
                intent,
            );
            return (
                await this.spaces.upsertDestination({ ...command, destination })
            ).view;
        });
    }
    history(
        actorId: string,
        spaceId: string,
        page: { limit: number; cursor?: string },
    ) {
        return this.spaces.history(actorId, spaceId, page);
    }
    async diagnostic(
        actorId: string,
        spaceId: string,
        page: { limit: number; offset: number },
    ) {
        const actor = PersonId.from(actorId),
            space = SpaceId.from(spaceId);
        await this.access.assertCanRead(actor, space);
        const result = await this.manager.readSnapshot(async () => {
            const closure = await this.spaces.read(actorId, spaceId);
            const finance = await this.finances.read(
                actorId,
                spaceId,
                closure?.cutoffDate ?? todayReferenceDate(this.clock.now()),
                page,
            );
            const routine = await this.routine.summary(actorId, spaceId);
            const shopping = await this.shopping.summary(actorId, spaceId);
            return {
                spaceId,
                closure,
                finance,
                informational: {
                    routine,
                    shopping,
                    blocksFinancialClosure: false,
                },
            };
        });
        await this.access.assertCanRead(actor, space);
        return result;
    }
}
