import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { parseZodInput } from '../../../../shared/technical/http/validation/parse-zod-input.js';
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
import { CommitmentChangeProposal } from '../../domain/commitment-change/commitment-change-proposal.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import type {
    FinancialChangeDto,
    FinancialChangeDecisionDto,
} from '../../http/dto/financial-change.dto.js';
import { nonRecurringChangeSchema } from '../../http/dto/non-recurring-change.dto.js';
import { changeRecurringCommitmentSchema } from '../../http/dto/recurring-commitment.dto.js';
import { uuid } from '../../http/dto/record-shared-cash-expense.dto.js';
import {
    adjustmentSchema,
    type AdjustmentDto,
} from '../../http/dto/financial-correction.dto.js';
import {
    FINANCIAL_CHANGE_REPOSITORY,
    type FinancialChangeRepository,
    type FinancialChangeOrigin,
} from '../ports/private/financial-change.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import {
    FinancialIntegrityCommands,
    type FinancialIntegrityCommand,
} from './financial-integrity-commands.js';
import { NonRecurringCommitmentChanges } from './non-recurring-commitment-changes.js';
import { RecurringCommitmentHandler } from './recurring-commitment.handler.js';
import { FinancialCommitmentAdjustments } from './financial-commitment-adjustments.js';

type ChangeCommand = FinancialIntegrityCommand & FinancialChangeDto;
type DecisionCommand = FinancialIntegrityCommand &
    FinancialChangeDecisionDto & { proposalId: string };

@Injectable()
export class FinancialCommitmentChangesHandler {
    constructor(
        private readonly commands: FinancialIntegrityCommands,
        @Inject(FINANCIAL_CHANGE_REPOSITORY)
        private readonly repository: FinancialChangeRepository,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly contexts: SpaceFinancialContextPort,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
        private readonly recurring: RecurringCommitmentHandler,
        private readonly nonRecurring: NonRecurringCommitmentChanges,
        private readonly adjustments: FinancialCommitmentAdjustments,
    ) {}

    private configuration(origin: FinancialChangeOrigin, input: unknown) {
        return origin.modality === 'RECURRING'
            ? parseZodInput(changeRecurringCommitmentSchema, input)
            : parseZodInput(nonRecurringChangeSchema, input);
    }
    private assess(
        actor: PersonId,
        space: SpaceId,
        id: string,
        origin: FinancialChangeOrigin,
        input: unknown,
    ) {
        if (origin.modality === 'RECURRING')
            return this.recurring.changePreview(
                actor,
                space,
                id,
                parseZodInput(changeRecurringCommitmentSchema, input),
            );
        return this.nonRecurring.preview(
            actor,
            space,
            id,
            parseZodInput(nonRecurringChangeSchema, input),
        );
    }
    private apply(
        c: FinancialIntegrityCommand,
        origin: FinancialChangeOrigin,
        input: unknown,
        acceptance?: { proposedByMemberId: string; acceptedByMemberId: string },
    ) {
        if (origin.modality === 'RECURRING')
            return this.recurring.applyVersion(
                {
                    ...parseZodInput(changeRecurringCommitmentSchema, input),
                    actorId: c.actorId,
                    spaceId: c.spaceId,
                    commitmentId: c.commitmentId,
                    idempotencyKey: c.idempotencyKey,
                },
                acceptance,
            );
        return this.nonRecurring.apply(
            c.actorId,
            c.spaceId,
            c.commitmentId,
            parseZodInput(nonRecurringChangeSchema, input),
            acceptance,
        );
    }
    async preview(
        actor: PersonId,
        space: SpaceId,
        id: string,
        input: FinancialChangeDto,
    ) {
        await this.access.assertCanRead(actor, space);
        const result = await this.repository.snapshot(async () => {
            const origin = await this.repository.origin(space.value, id);
            if (!origin)
                throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
            return this.assess(actor, space, id, origin, input);
        });
        await this.access.assertCanRead(actor, space);
        return result;
    }
    async history(actor: PersonId, space: SpaceId, id: string) {
        await this.access.assertCanRead(actor, space);
        const result = await this.repository.snapshot(async () => {
            const origin = await this.repository.origin(space.value, id);
            if (!origin)
                throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
            return origin.modality === 'RECURRING'
                ? this.recurring.detail(actor, space, id)
                : this.nonRecurring.history(actor, space, id);
        });
        await this.access.assertCanRead(actor, space);
        return result;
    }
    change(c: ChangeCommand, input: FinancialChangeDto) {
        return this.commands.execute(
            'CHANGE_COMMITMENT_VERSION',
            c,
            input,
            async (origin) => this.apply(c, origin, input),
        );
    }
    propose(c: ChangeCommand, input: FinancialChangeDto) {
        return this.commands.execute(
            'PROPOSE_COMMITMENT_CHANGE',
            c,
            input,
            async (origin, context, now) => {
                if (!context) throw new FinancesError('SHARED_SPACE_REQUIRED');
                const configuration = this.configuration(origin, input);
                const impact = await this.assess(
                    c.actorId,
                    c.spaceId,
                    c.commitmentId,
                    origin,
                    configuration,
                );
                const recipients = impact.impactByMember.filter(
                    (member) => member.requiresAcceptance,
                );
                if (!impact.requiresAcceptance || recipients.length !== 1)
                    throw new FinancesError('VALIDATION_ERROR', [
                        'distribution',
                    ]);
                const proposal = new CommitmentChangeProposal({
                    id: randomUUID(),
                    spaceId: c.spaceId.value,
                    commitmentId: c.commitmentId,
                    version: 1,
                    baseVersion: origin.version,
                    originFingerprint: origin.fingerprint,
                    proposedByMemberId: context.actorMemberId,
                    recipientMemberId: recipients[0].memberId,
                    actorId: c.actorId.value,
                    effectiveFrom: configuration.effectiveFrom,
                    configuration,
                    impact,
                    status: 'PROPOSED',
                    registeredAt: now,
                    decidedAt: null,
                    decidedByPersonId: null,
                });
                await this.repository.insert(proposal);
                return { proposal: proposal.state };
            },
        );
    }
    adjust(c: FinancialIntegrityCommand, input: AdjustmentDto) {
        return this.commands.execute(
            'RECORD_FINANCIAL_ADJUSTMENT',
            c,
            input,
            async (origin, context, now) => {
                const impact = await this.adjustments.preview(
                    c.actorId,
                    c.spaceId,
                    c.commitmentId,
                    input,
                );
                if (!impact.requiresAcceptance)
                    return this.adjustments.applyApproved(c, input);
                if (!context) throw new FinancesError('SHARED_SPACE_REQUIRED');
                const recipients = impact.impactByMember.filter(
                    (member) => member.requiresAcceptance,
                );
                if (recipients.length !== 1)
                    throw new FinancesError('VALIDATION_ERROR', [
                        'distribution',
                    ]);
                const proposal = new CommitmentChangeProposal({
                    id: randomUUID(),
                    spaceId: c.spaceId.value,
                    commitmentId: c.commitmentId,
                    version: 1,
                    baseVersion: origin.version,
                    originFingerprint: origin.fingerprint,
                    proposedByMemberId: context.actorMemberId,
                    recipientMemberId: recipients[0].memberId,
                    actorId: c.actorId.value,
                    effectiveFrom: input.factDate,
                    configuration: {
                        changeType: 'ADJUSTMENT',
                        adjustment: input,
                    },
                    impact,
                    status: 'PROPOSED',
                    registeredAt: now,
                    decidedAt: null,
                    decidedByPersonId: null,
                });
                await this.repository.insert(proposal);
                return { proposal: proposal.state };
            },
            'CORRECTION',
        );
    }
    decide(c: DecisionCommand, accept: boolean) {
        return this.commands.execute(
            accept ? 'ACCEPT_COMMITMENT_CHANGE' : 'REJECT_COMMITMENT_CHANGE',
            c,
            {
                proposalId: c.proposalId,
                expectedProposalVersion: c.expectedProposalVersion,
                expectedCommitmentVersion: c.expectedCommitmentVersion,
                expectedSpaceVersion: c.expectedSpaceVersion,
            },
            async (origin, context, now) => {
                if (!context) throw new FinancesError('SHARED_SPACE_REQUIRED');
                const proposal = await this.repository.find(
                    c.spaceId.value,
                    c.commitmentId,
                    c.proposalId,
                );
                if (!proposal)
                    throw new FinancesError(
                        'FINANCIAL_CHANGE_PROPOSAL_NOT_FOUND',
                    );
                const decided = proposal.decide(
                    context.actorMemberId,
                    c.actorId.value,
                    c.expectedProposalVersion,
                    accept,
                    now,
                );
                let result: object = {};
                if (accept) {
                    const configuration = proposal.state.configuration;
                    const isAdjustment =
                        'changeType' in configuration &&
                        configuration.changeType === 'ADJUSTMENT';
                    if (
                        proposal.state.baseVersion !== origin.version ||
                        proposal.state.originFingerprint !==
                            origin.fingerprint ||
                        (!isAdjustment &&
                            proposal.state.effectiveFrom <= this.clock.today())
                    )
                        throw new FinancesError(
                            'FINANCIAL_CHANGE_PROPOSAL_OBSOLETE',
                        );
                    const approval = {
                        proposedByMemberId: proposal.state.proposedByMemberId,
                        acceptedByMemberId: context.actorMemberId,
                        proposalId: proposal.state.id,
                    };
                    result = isAdjustment
                        ? await this.adjustments.applyApproved(
                              c,
                              {
                                  ...parseZodInput(
                                      adjustmentSchema,
                                      'adjustment' in configuration
                                          ? configuration.adjustment
                                          : null,
                                  ),
                                  expectedSpaceVersion: c.expectedSpaceVersion,
                              },
                              approval,
                          )
                        : await this.apply(
                              c,
                              origin,
                              proposal.state.configuration,
                              approval,
                          );
                }
                await this.repository.update(decided, proposal.state.version);
                return { ...result, proposal: decided.state };
            },
            'CORRECTION',
        );
    }
    async list(
        actor: PersonId,
        space: SpaceId,
        query: { status?: string; recipient?: string; cursor?: string },
    ) {
        const access = await this.access.assertCanRead(actor, space);
        if (access.type !== 'SHARED')
            throw new FinancesError('SHARED_SPACE_REQUIRED');
        if (
            query.status &&
            !['PROPOSED', 'ACCEPTED', 'REJECTED', 'CANCELLED'].includes(
                query.status,
            )
        )
            throw new FinancesError('VALIDATION_ERROR', ['status']);
        if (query.recipient && query.recipient !== 'ME')
            throw new FinancesError('VALIDATION_ERROR', ['recipient']);
        const context = await this.contexts.read(actor, space);
        const scope = JSON.stringify([
            actor.value,
            space.value,
            null, // Inbox cursors have no commitment filter.
            query.status ?? null,
            query.recipient ?? null,
        ]);
        let after: string | null = null;
        if (query.cursor !== undefined) {
            try {
                if (
                    query.cursor.length > 2048 ||
                    !/^[A-Za-z0-9_-]+$/.test(query.cursor)
                )
                    throw new Error();
                const values: unknown = JSON.parse(
                    Buffer.from(query.cursor, 'base64url').toString('utf8'),
                );
                if (
                    !Array.isArray(values) ||
                    values.length !== 3 ||
                    values[0] !== 1 ||
                    values[1] !== scope ||
                    !uuid.safeParse(values[2]).success
                )
                    throw new Error();
                after = values[2] as string;
            } catch {
                throw new FinancesError('VALIDATION_ERROR', ['cursor']);
            }
        }
        const result = await this.repository.snapshot(() =>
            this.repository.list(
                space.value,
                query.recipient === 'ME' ? context.actorMemberId : null,
                query.status ?? null,
                after,
            ),
        );
        await this.access.assertCanRead(actor, space);
        const items = result.items
            .slice(0, 20)
            .map((proposal) => proposal.state);
        return {
            items,
            totalCount: result.totalCount,
            nextCursor:
                result.items.length > 20
                    ? Buffer.from(
                          JSON.stringify([1, scope, items.at(-1)!.id]),
                      ).toString('base64url')
                    : null,
        };
    }
}
