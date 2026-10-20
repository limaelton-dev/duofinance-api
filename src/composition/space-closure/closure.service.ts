import { ConcurrentModificationError } from '../../modules/spaces/application/errors/concurrent-modification.error.js';
import {
    Inject,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';
import { isPostgresqlUnavailable } from '../../shared/technical/database/postgresql-unavailable.js';
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
    async reviewPlan(actorId: string, spaceId: string) {
        const actor = PersonId.from(actorId),
            space = SpaceId.from(spaceId);
        await this.access.assertCanRead(actor, space);
        const result = await this.manager.readSnapshot(async () => {
            const closure = await this.spaces.read(actorId, spaceId);
            if (!closure)
                throw new SpacesDomainError('CLOSURE_PROCESS_NOT_FOUND');
            const finance = await this.destinations.reviewPlan(
                actorId,
                spaceId,
                closure.proposedCutoffDate ?? closure.cutoffDate,
                closure.futureDestinations,
            );
            const routine = await this.routine.summary(actorId, spaceId),
                shopping = await this.shopping.summary(actorId, spaceId);
            return {
                spaceId,
                closure,
                finance,
                informational: { routine, shopping },
            };
        });
        await this.access.assertCanRead(actor, space);
        return result;
    }
    async financialValidation(actorId: string, spaceId: string) {
        const actor = PersonId.from(actorId),
            space = SpaceId.from(spaceId);
        await this.access.assertCanRead(actor, space);
        try {
            const result = await this.manager.readSnapshot(async () => {
                const closure = await this.spaces.read(actorId, spaceId);
                if (!closure)
                    throw new SpacesDomainError('CLOSURE_PROCESS_NOT_FOUND');
                const planApproved =
                    closure.planStatus === 'APPROVED' &&
                    closure.requiredMemberIds.every((id) =>
                        closure.approvals.some(
                            (approval) =>
                                approval.memberId === id &&
                                approval.planRevision === closure.planRevision,
                        ),
                    );
                const finance = await this.destinations.reviewPlan(
                    actorId,
                    spaceId,
                    closure.cutoffDate,
                    planApproved ? closure.futureDestinations : [],
                );
                const financiallyReady =
                    finance.diagnostic.financiallyReady &&
                    finance.missingDestinationOriginIds.length === 0;
                const actorMemberId = closure.participants.find(
                    (member) => member.personId === actorId,
                )?.memberId;
                const actorConfirmed = closure.confirmations.some(
                    (confirmation) =>
                        confirmation.memberId === actorMemberId &&
                        confirmation.planRevision === closure.planRevision &&
                        confirmation.financialFingerprint ===
                            finance.fingerprint,
                );
                return {
                    ...finance.diagnostic,
                    spaceId,
                    processId: closure.processId,
                    planRevision: closure.planRevision,
                    spaceVersion: closure.spaceVersion,
                    planApproved,
                    financiallyReady,
                    canConfirm:
                        closure.spaceStatus === 'CLOSING' &&
                        closure.processStatus === 'OPEN' &&
                        planApproved &&
                        financiallyReady &&
                        !actorConfirmed &&
                        !closure.cancellationConsents?.length,
                    financialFingerprint: finance.fingerprint,
                    appliedDestinations: finance.appliedDestinations,
                    resolutions: await this.destinations.resolutions(
                        actorId,
                        spaceId,
                        closure.processId,
                    ),
                    missingDestinationOriginIds:
                        finance.missingDestinationOriginIds,
                    informational: {
                        routine: await this.routine.summary(actorId, spaceId),
                        shopping: await this.shopping.summary(actorId, spaceId),
                        blocksFinancialClosure: false as const,
                    },
                };
            });
            await this.access.assertCanRead(actor, space);
            return result;
        } catch (error) {
            if (isPostgresqlUnavailable(error))
                throw new ServiceUnavailableException();
            throw error;
        }
    }
    async finalSummary(actorId: string, spaceId: string) {
        return this.manager.readSnapshot(async () => {
            const validation = await this.financialValidation(actorId, spaceId),
                closure = await this.spaces.read(actorId, spaceId);
            if (!closure)
                throw new SpacesDomainError('CLOSURE_PROCESS_NOT_FOUND');
            const validConfirmations =
                validation.planApproved && !closure.cancellationConsents?.length
                    ? closure.confirmations.filter(
                          (confirmation) =>
                              confirmation.planRevision ===
                                  closure.planRevision &&
                              confirmation.financialFingerprint ===
                                  validation.financialFingerprint,
                      )
                    : [];
            const memberId = closure.participants.find(
                (member) => member.personId === actorId,
            )?.memberId;
            const actorConfirmed = validConfirmations.some(
                (confirmation) => confirmation.memberId === memberId,
            );
            return {
                ...validation,
                closure,
                validConfirmations,
                actorConfirmed,
                requiredConfirmations: closure.requiredMemberIds.length,
                confirmedCount: validConfirmations.length,
                canConfirm: validation.canConfirm && !actorConfirmed,
            };
        });
    }
    async confirm(
        actorId: string,
        spaceId: string,
        key: string,
        input: {
            expectedSpaceVersion: number;
            expectedPlanRevision: number;
            expectedFinancialFingerprint: string;
        },
    ) {
        const command = {
            actorId,
            spaceId,
            idempotencyKey: key,
            ...input,
            now: this.clock.now(),
            action: 'CONFIRM' as const,
            financialFingerprint: input.expectedFinancialFingerprint,
            financiallyReady: false,
            completionPrepared: false,
        };
        return this.uow.execute(async () => {
            const closure = await this.spaces.lockForProcess(actorId, spaceId),
                replay = await this.spaces.replayConclusion(command);
            if (replay) return replay.view;
            if (
                !closure ||
                closure.spaceStatus !== 'CLOSING' ||
                closure.processStatus !== 'OPEN'
            )
                throw new SpacesDomainError('CLOSURE_PROCESS_NOT_OPEN');
            if (
                closure.spaceVersion !== input.expectedSpaceVersion ||
                closure.planRevision !== input.expectedPlanRevision
            )
                throw new ConcurrentModificationError();
            if (closure.cancellationConsents?.length)
                throw new SpacesDomainError('CLOSURE_CANCELLATION_PENDING');
            const validation = await this.financialValidation(actorId, spaceId);
            if (
                input.expectedFinancialFingerprint !==
                validation.financialFingerprint
            )
                throw new SpacesDomainError('CLOSURE_FINANCIAL_STATE_CHANGED');
            if (!validation.planApproved || !validation.financiallyReady)
                throw new SpacesDomainError('CLOSURE_CONFIRMATION_NOT_READY');
            const memberId = closure.participants.find(
                (member) => member.personId === actorId,
            )?.memberId;
            const validConfirmations = closure.confirmations.filter(
                (confirmation) =>
                    confirmation.planRevision === closure.planRevision &&
                    confirmation.financialFingerprint ===
                        validation.financialFingerprint,
            );
            const completionPrepared = closure.requiredMemberIds.every(
                (id) =>
                    id === memberId ||
                    validConfirmations.some(
                        (confirmation) => confirmation.memberId === id,
                    ),
            );
            if (completionPrepared) {
                await this.routine.complete(
                    actorId,
                    spaceId,
                    closure.processId,
                    command.now,
                );
                await this.shopping.complete(
                    actorId,
                    spaceId,
                    closure.processId,
                    command.now,
                );
            }
            return (
                await this.spaces.confirm({
                    ...command,
                    financialFingerprint: validation.financialFingerprint,
                    financiallyReady: true,
                    completionPrepared,
                })
            ).view;
        });
    }
    async cancel(
        actorId: string,
        spaceId: string,
        key: string,
        input: { expectedSpaceVersion: number; expectedPlanRevision: number },
    ) {
        return this.uow.execute(
            async () =>
                (
                    await this.spaces.cancel({
                        actorId,
                        spaceId,
                        idempotencyKey: key,
                        ...input,
                        action: 'CANCEL',
                        now: this.clock.now(),
                    })
                ).view,
        );
    }
    async decidePlan(
        actorId: string,
        spaceId: string,
        key: string,
        input: {
            expectedSpaceVersion: number;
            expectedPlanRevision: number;
            expectedFinancialFingerprint?: string;
        },
        action: 'PROPOSE' | 'APPROVE' | 'REJECT',
    ) {
        const command = {
            actorId,
            spaceId,
            idempotencyKey: key,
            ...input,
            action,
            now: this.clock.now(),
        };
        return this.uow.execute(async () => {
            const closure = await this.spaces.lockForProcess(actorId, spaceId);
            const replay = await this.spaces.replayPlanDecision(command);
            if (replay) return replay.view;
            if (
                !closure ||
                closure.spaceStatus !== 'CLOSING' ||
                closure.processStatus !== 'OPEN'
            )
                throw new SpacesDomainError('CLOSURE_PROCESS_NOT_OPEN');
            if (
                closure.spaceVersion !== input.expectedSpaceVersion ||
                closure.planRevision !== input.expectedPlanRevision
            )
                throw new ConcurrentModificationError();
            let proposalSnapshot;
            if (action !== 'REJECT') {
                const review = await this.destinations.reviewPlan(
                    actorId,
                    spaceId,
                    closure.proposedCutoffDate ?? closure.cutoffDate,
                    closure.futureDestinations,
                );
                if (review.missingDestinationOriginIds.length)
                    throw new SpacesDomainError('CLOSURE_PLAN_INCOMPLETE');
                if (input.expectedFinancialFingerprint !== review.fingerprint)
                    throw new SpacesDomainError('CLOSURE_PLAN_OBSOLETE');
                if (
                    action === 'APPROVE' &&
                    closure.proposalSnapshot?.financialFingerprint !==
                        review.fingerprint
                )
                    throw new SpacesDomainError('CLOSURE_PLAN_OBSOLETE');
                proposalSnapshot = {
                    financialFingerprint: review.fingerprint,
                    financialBlockerCount: review.diagnostic.totalCount,
                    outstandingAmounts: review.diagnostic.outstandingAmounts,
                    routine: await this.routine.summary(actorId, spaceId),
                    shopping: await this.shopping.summary(actorId, spaceId),
                };
            }
            const result = await this.spaces.decidePlan({
                ...command,
                proposalSnapshot,
            });
            if (result.view.planStatus === 'APPROVED')
                await this.destinations.applyApproved(
                    actorId,
                    spaceId,
                    result.view.processId,
                    command.now,
                );
            return result.view;
        });
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
                throw new ConcurrentModificationError();
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
