import { Inject, Injectable } from '@nestjs/common';
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
import type { ChangeRecurringCommitmentDto } from '../../http/dto/recurring-commitment.dto.js';
import {
    RECURRING_COMMITMENT_REPOSITORY,
    type RecurringCommitmentRepository,
} from '../ports/private/recurring-commitment.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import { RecurringCommandExecution } from './recurring-command-execution.js';
import type { Base } from './recurring-commitment.commands.js';
import { rootView } from './recurring-commitment.models.js';
import { RecurringVersionChange } from './recurring-version-change.js';

@Injectable()
export class ChangeRecurringCommitmentHandler {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(RECURRING_COMMITMENT_REPOSITORY)
        private readonly repository: RecurringCommitmentRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
        private readonly changes: RecurringVersionChange,
        private readonly commands: RecurringCommandExecution,
    ) {}

    async changePreview(
        actor: PersonId,
        space: SpaceId,
        id: string,
        input: ChangeRecurringCommitmentDto,
    ) {
        const access = await this.access.assertCanRead(actor, space);
        const result = await this.repository.readSnapshot(async () => {
            const root = await this.repository.find(space.value, id);
            if (!root)
                throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
            const context =
                access.type === 'SHARED'
                    ? await this.context.read(actor, space)
                    : null;
            if ((context !== null) !== 'expectedSpaceVersion' in input)
                throw new FinancesError('VALIDATION_ERROR', [
                    'expectedSpaceVersion',
                ]);
            if (
                context &&
                context.version !==
                    ('expectedSpaceVersion' in input
                        ? input.expectedSpaceVersion
                        : undefined)
            )
                throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
            const candidate = await this.changes.candidate(
                input,
                root,
                context?.members.map((m) => m.memberId) ?? null,
            );
            const impact = await this.changes.changeImpact(
                root,
                candidate,
                context?.actorMemberId ?? null,
            );

            return { commitmentId: id, ...impact };
        });
        await this.access.assertCanRead(actor, space);
        return result;
    }

    changeVersion(
        c: Base & { commitmentId: string } & ChangeRecurringCommitmentDto,
    ) {
        return this.commands.execute(
            'CHANGE_RECURRING_COMMITMENT',
            c,
            async (hash) => {
                const access = await this.access.assertCanRead(
                    c.actorId,
                    c.spaceId,
                );
                if (access.type === 'SHARED')
                    await this.context.lockForWrite(c.actorId, c.spaceId);
                else await this.access.assertCanWrite(c.actorId, c.spaceId);
                const replay = await this.repository.findReceipt(
                    c.actorId.value,
                    'CHANGE_RECURRING_COMMITMENT',
                    c.idempotencyKey,
                    hash,
                );
                if (replay) return { ...(replay as object), replayed: true };
                const result = await this.applyVersion(c);
                await this.repository.saveReceipt(
                    c.actorId.value,
                    c.spaceId.value,
                    c.commitmentId,
                    null,
                    'CHANGE_RECURRING_COMMITMENT',
                    c.idempotencyKey,
                    hash,
                    result,
                    this.clock.now().toISOString(),
                );
                return result;
            },
        );
    }

    async applyVersion(
        c: Base & { commitmentId: string } & ChangeRecurringCommitmentDto,
        acceptance?: { proposedByMemberId: string; acceptedByMemberId: string },
    ) {
        const access = await this.access.assertCanRead(c.actorId, c.spaceId);
        const context =
            access.type === 'SHARED'
                ? await this.context.lockForWrite(c.actorId, c.spaceId)
                : null;
        if (!context) await this.access.assertCanWrite(c.actorId, c.spaceId);
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
        if (!root) throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const candidate = await this.changes.candidate(
            c,
            root,
            context?.members.map((m) => m.memberId) ?? null,
        );
        const impact = await this.changes.changeImpact(
            root,
            candidate,
            acceptance?.proposedByMemberId ?? context?.actorMemberId ?? null,
        );
        if (
            impact.requiresAcceptance &&
            (!acceptance ||
                acceptance.acceptedByMemberId !== context?.actorMemberId ||
                impact.impactByMember.some(
                    (member) =>
                        member.requiresAcceptance &&
                        member.memberId !== acceptance.acceptedByMemberId,
                ))
        )
            throw new FinancesError('RECURRENCE_ACCEPTANCE_REQUIRED');
        await this.repository.saveVersion(root, candidate, c.effectiveFrom);
        const result = {
            commitment: rootView(
                this.changes.withCandidate(root, candidate),
                this.clock.today(),
            ),
            impact,
            replayed: false,
        };
        return result;
    }
}
