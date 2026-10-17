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
import {
    assessNonRecurringChange,
    type NonRecurringEconomicVersion,
} from '../../domain/changes/non-recurring-version.js';
import type { NonRecurringChangeDto } from '../../http/dto/non-recurring-change.dto.js';
import {
    NON_RECURRING_CHANGE_REPOSITORY,
    type NonRecurringChangeRepository,
} from '../ports/private/non-recurring-change.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';

export interface ApprovedNonRecurringChange {
    acceptedByMemberId?: string;
    proposedByMemberId?: string;
}

@Injectable()
export class NonRecurringCommitmentChanges {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(NON_RECURRING_CHANGE_REPOSITORY)
        private readonly repository: NonRecurringChangeRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}

    preview(
        actorId: PersonId,
        spaceId: SpaceId,
        id: string,
        input: NonRecurringChangeDto,
    ) {
        return this.repository.snapshot(async () => {
            const assessment = await this.assess(
                actorId,
                spaceId,
                id,
                input,
                false,
            );
            await this.access.assertCanRead(actorId, spaceId);
            return assessment.preview;
        });
    }

    history(actorId: PersonId, spaceId: SpaceId, id: string) {
        return this.repository.snapshot(async () => {
            await this.access.assertCanRead(actorId, spaceId);
            const state = await this.repository.read(
                spaceId.value,
                id,
                this.clock.today(),
                false,
            );
            if (!state)
                throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
            await this.access.assertCanRead(actorId, spaceId);
            const today = this.clock.today();
            return {
                commitmentId: id,
                version: state.version,
                targets: state.targets,
                versions: state.versions,
                currentVersions: state.targets.map((target) => ({
                    targetId: target.id,
                    version:
                        state.versions.find(
                            (version) =>
                                version.targetId === target.id &&
                                version.version === target.economicVersion,
                        ) ?? null,
                })),
                nextVersions: state.versions.filter(
                    (version) => version.effectiveFrom > today,
                ),
            };
        });
    }

    async apply(
        actorId: PersonId,
        spaceId: SpaceId,
        id: string,
        input: NonRecurringChangeDto,
        approval: ApprovedNonRecurringChange = {},
    ) {
        const { state, impact, preview } = await this.assess(
            actorId,
            spaceId,
            id,
            input,
            true,
            approval,
        );
        const recipient =
            impact.impactByMember.find((row) => row.requiresAcceptance)
                ?.memberId ?? null;
        if (
            recipient &&
            (approval.acceptedByMemberId !== recipient ||
                !approval.proposedByMemberId)
        )
            throw new FinancesError('RECURRENCE_ACCEPTANCE_REQUIRED');
        const now = this.clock.now().toISOString();
        const versions: NonRecurringEconomicVersion[] =
            impact.proposedTargets.map((target) => ({
                id: randomUUID(),
                spaceId: spaceId.value,
                commitmentId: id,
                targetId: target.targetId,
                installmentId:
                    state.modality === 'INSTALLMENT' ? target.targetId : null,
                version: state.version + 1,
                effectiveFrom: input.effectiveFrom,
                description: input.description,
                amountInCents: target.amountInCents,
                distribution:
                    input.scope === 'SHARED' ? input.distribution : null,
                economicShares: target.economicShares,
                expectedMemberId:
                    input.scope === 'SHARED'
                        ? (input.expectedMemberId ?? null)
                        : null,
                actorId: actorId.value,
                registeredAt: now,
            }));
        await this.repository.save(state, versions);
        return { ...preview, version: state.version + 1, versions };
    }

    private async assess(
        actorId: PersonId,
        spaceId: SpaceId,
        id: string,
        input: NonRecurringChangeDto,
        lock: boolean,
        approval: ApprovedNonRecurringChange = {},
    ) {
        const access = await this.access.assertCanRead(actorId, spaceId);
        if (access.type !== input.scope)
            throw new FinancesError(
                input.scope === 'SHARED'
                    ? 'SHARED_SPACE_REQUIRED'
                    : 'PERSONAL_SPACE_REQUIRED',
            );
        const context =
            input.scope === 'SHARED'
                ? lock
                    ? await this.context.lockForWrite(actorId, spaceId)
                    : await this.context.read(actorId, spaceId)
                : null;
        if (lock && !context)
            await this.access.assertCanWrite(actorId, spaceId);
        if (
            context &&
            input.scope === 'SHARED' &&
            context.version !== input.expectedSpaceVersion
        )
            throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
        if (input.effectiveFrom <= this.clock.today())
            throw new FinancesError('VALIDATION_ERROR', ['effectiveFrom']);
        const state = await this.repository.read(
            spaceId.value,
            id,
            input.effectiveFrom,
            lock,
        );
        if (!state) throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        if (state.version !== input.expectedCommitmentVersion)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        if (
            state.kind !== input.kind ||
            (state.ownerPersonId === null) !== (input.scope === 'SHARED')
        )
            throw new FinancesError('VALIDATION_ERROR', ['kind', 'scope']);
        if (
            state.versions.some(
                (version) => version.effectiveFrom >= input.effectiveFrom,
            )
        )
            throw new FinancesError('VALIDATION_ERROR', ['effectiveFrom']);
        if (state.modality === 'ONE_TIME' && input.installmentIds !== undefined)
            throw new FinancesError('VALIDATION_ERROR', ['installmentIds']);
        const ids = input.installmentIds;
        if (
            ids &&
            (new Set(ids).size !== ids.length ||
                ids.some(
                    (targetId) =>
                        !state.targets.some((target) => target.id === targetId),
                ))
        )
            throw new FinancesError('VALIDATION_ERROR', ['installmentIds']);
        const targets = ids
            ? state.targets.filter((target) => ids.includes(target.id))
            : state.targets.filter(
                  (target) =>
                      !target.resolved &&
                      target.fulfilledAmountInCents === 0 &&
                      (target.dueDate === null ||
                          target.dueDate >= input.effectiveFrom),
              );
        if (
            !targets.length ||
            targets.some(
                (target) =>
                    target.resolved ||
                    target.fulfilledAmountInCents > 0 ||
                    (target.dueDate !== null &&
                        target.dueDate < input.effectiveFrom),
            )
        )
            throw new FinancesError('OCCURRENCE_ALREADY_RESOLVED');
        const memberIds =
            context?.members.map((member) => member.memberId) ?? null;
        if (
            input.scope === 'SHARED' &&
            (!memberIds ||
                input.distribution.shares.length !== memberIds.length ||
                input.distribution.shares.some(
                    (share) => !memberIds.includes(share.memberId),
                ) ||
                (input.expectedMemberId &&
                    !memberIds.includes(input.expectedMemberId)))
        )
            throw new FinancesError('VALIDATION_ERROR', ['distribution']);
        if (
            (approval.acceptedByMemberId !== undefined) !==
                (approval.proposedByMemberId !== undefined) ||
            (approval.acceptedByMemberId &&
                (!context ||
                    context.actorMemberId !== approval.acceptedByMemberId ||
                    !memberIds?.includes(approval.proposedByMemberId!)))
        )
            throw new FinancesError('VALIDATION_ERROR', ['approval']);
        const impact = assessNonRecurringChange(
            state.kind,
            targets,
            input.amountInCents,
            memberIds,
            input.scope === 'SHARED' ? input.distribution : null,
            approval.proposedByMemberId ?? context?.actorMemberId ?? null,
        );
        return {
            state,
            impact,
            preview: {
                commitmentId: id,
                kind: state.kind,
                modality: state.modality,
                currentVersion: state.version,
                proposedVersion: state.version + 1,
                effectiveFrom: input.effectiveFrom,
                currentAmountInCents: targets
                    .reduce(
                        (sum, target) => sum + BigInt(target.amountInCents),
                        0n,
                    )
                    .toString(),
                proposedAmountInCents: input.amountInCents.toString(),
                impactByMember: impact.impactByMember,
                requiresAcceptance: impact.requiresAcceptance,
                recipientMemberId:
                    impact.impactByMember.find((row) => row.requiresAcceptance)
                        ?.memberId ?? null,
                targets: targets.map((target) => ({
                    ...target,
                    proposed: impact.proposedTargets.find(
                        (candidate) => candidate.targetId === target.id,
                    )!,
                })),
                versions: state.versions,
                eligible: true,
                cashImpactInCents: '0',
                supportedImpactInCents: '0',
                pendingImpactInCents: '0',
            },
        };
    }
}
