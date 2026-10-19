import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { QueryFailedError, type EntityManager } from 'typeorm';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import { ConcurrentModificationError } from '../../../application/errors/concurrent-modification.error.js';
import { IdempotencyKeyReusedError } from '../../../application/errors/idempotency-key-reused.error.js';
import type {
    ClosureParticipant,
    ClosureDestinationIntent,
    ClosureDestinationReplayInput,
    ClosurePlanDecisionInput,
    ClosurePlanAction,
    ClosureConclusionInput,
    ConfirmClosureInput,
    CancelClosureInput,
    ProposeClosureCutoffInput,
    SpaceClosureCommandBase,
    SpaceClosureCommandResult,
    SpaceClosurePort,
    SpaceClosureView,
    SpaceClosureNextAction,
    UpsertClosureDestinationInput,
} from '../../../application/ports/public/space-closure.port.js';
import { SpacesDomainError } from '../../../domain/errors/spaces-domain.error.js';
import { PersonId } from '../../../domain/person/person-id.js';
import { ClosurePlan } from '../../../domain/space/closure-plan.js';
import { SpaceId } from '../../../domain/space/space-id.js';
import type { Space } from '../../../domain/space/space.js';
import { SpaceMapper } from '../../mappers/space.mapper.js';
import { SpaceClosureAuditOrmEntity } from '../entities/space-closure-audit.orm-entity.js';
import { SpaceClosureCommandReceiptOrmEntity } from '../entities/space-closure-command-receipt.orm-entity.js';
import { SpaceClosureHistoryOrmEntity } from '../entities/space-closure-history.orm-entity.js';
import { SpaceClosureProcessOrmEntity } from '../entities/space-closure-process.orm-entity.js';
import { SpaceInvitationOrmEntity } from '../entities/space-invitation.orm-entity.js';
import { SpaceOrmEntity } from '../entities/space.orm-entity.js';
import { TypeOrmSpaceRepository } from './typeorm-space.repository.js';

type ClosureSpaceRow = {
    id: string;
    type: 'PERSONAL' | 'SHARED';
    status: SpaceClosureView['spaceStatus'];
    version: number;
    actorMemberId: string | null;
    invitationStatus: string | null;
};

type HistoryCursor = { spaceId: string; recordedAt: string; id: string };

function saoPauloDate(now: Date): string {
    const values = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(now);
    const part = (type: string) =>
        values.find((value) => value.type === type)!.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
}

@Injectable()
export class TypeOrmSpaceClosure implements SpaceClosurePort {
    constructor(
        private readonly managers: EntityManagerProvider,
        private readonly spaces: TypeOrmSpaceRepository,
    ) {}

    async start(
        input: SpaceClosureCommandBase,
    ): Promise<SpaceClosureCommandResult> {
        const manager = this.transactionManager();
        const row = await this.loadSpace(input.actorId, input.spaceId, true);
        const digest = this.digest(input);
        const replay = await this.replay(input, 'START_CLOSURE', digest);
        if (replay) return replay;
        this.assertVersion(row, input.expectedSpaceVersion);
        if (row.status !== 'ACTIVE')
            throw new SpacesDomainError('SPACE_NOT_ACTIVE');
        if (await this.process(input.spaceId, true)) {
            throw new SpacesDomainError('CLOSURE_PROCESS_NOT_OPEN');
        }
        const space = await this.requireAggregate(input.spaceId);
        const participants: ClosureParticipant[] = await manager.query(
            `SELECT m.id AS "memberId", m.person_id AS "personId", p.display_name AS "displayName"
             FROM space_members m JOIN persons p ON p.id=m.person_id
             WHERE m.space_id=$1 ORDER BY m.joined_at, m.id`,
            [input.spaceId],
        );
        const plan = space.startClosure({
            actorPersonId: PersonId.from(input.actorId),
            processId: randomUUID(),
            participants,
            cutoffDate: saoPauloDate(input.now),
            now: input.now,
        });
        const snapshot = plan.snapshot();
        const process = manager.create(SpaceClosureProcessOrmEntity, {
            id: snapshot.processId,
            spaceId: input.spaceId,
            status: 'OPEN',
            requestedByMemberId: snapshot.requestedByMemberId,
            startedAt: input.now,
            completedAt: null,
            cancelledAt: null,
            cutoffDate: snapshot.cutoffDate,
            proposedCutoffDate: null,
            planRevision: 1,
            planStatus: 'DRAFT',
            participants: snapshot.participants,
            approvals: [],
            confirmations: [],
            futureDestinations: [],
            proposalSnapshot: null,
            hasBilateralApproval: false,
            cancellationConsents: [],
        });
        await manager.insert(SpaceClosureProcessOrmEntity, process);
        await this.saveSpace(space, input.expectedSpaceVersion);
        for (const invitation of space.invitations) {
            await manager.update(
                SpaceInvitationOrmEntity,
                {
                    id: invitation.id.value,
                    spaceId: space.id.value,
                },
                SpaceMapper.invitationToPersistence(invitation, space.id),
            );
        }
        const latestInvitation = [...space.invitations].sort(
            (left, right) =>
                right.issuedAt.getTime() - left.issuedAt.getTime() ||
                right.id.value.localeCompare(left.id.value),
        )[0];
        const view = this.view(
            {
                ...row,
                status: 'CLOSING',
                version: space.version,
                invitationStatus:
                    latestInvitation?.status ?? row.invitationStatus,
            },
            process,
        );
        await this.record(
            input,
            row.actorMemberId!,
            'START_CLOSURE',
            digest,
            view,
            201,
        );
        return { view, replayed: false, httpStatus: 201 };
    }

    async proposeCutoff(
        input: ProposeClosureCutoffInput,
    ): Promise<SpaceClosureCommandResult> {
        const manager = this.transactionManager();
        const row = await this.loadSpace(input.actorId, input.spaceId, true);
        const digest = this.digest(input);
        const replay = await this.replay(
            input,
            'PROPOSE_CLOSURE_CUTOFF',
            digest,
        );
        if (replay) return replay;
        this.assertVersion(row, input.expectedSpaceVersion);
        const process = await this.process(input.spaceId, true);
        if (!process) throw new SpacesDomainError('CLOSURE_PROCESS_NOT_FOUND');
        if (process.status !== 'OPEN' || row.status !== 'CLOSING') {
            throw new SpacesDomainError('CLOSURE_PROCESS_NOT_OPEN');
        }
        if (process.planRevision !== input.expectedPlanRevision)
            throw new ConcurrentModificationError();
        const space = await this.requireAggregate(input.spaceId);
        const next = space
            .proposeClosureCutoff(
                PersonId.from(input.actorId),
                this.restorePlan(process),
                input.cutoffDate,
                input.now,
            )
            .snapshot();
        Object.assign(process, {
            planRevision: next.planRevision,
            planStatus: next.planStatus,
            proposedCutoffDate: next.proposedCutoffDate,
            cancellationConsents: next.cancellationConsents,
            proposalSnapshot: next.proposalSnapshot,
            approvals: next.approvals,
            confirmations: next.confirmations,
        });
        await this.saveSpace(space, input.expectedSpaceVersion);
        await manager.update(
            SpaceClosureProcessOrmEntity,
            { id: process.id, spaceId: input.spaceId },
            {
                planRevision: process.planRevision,
                planStatus: process.planStatus,
                proposedCutoffDate: process.proposedCutoffDate,
                cancellationConsents: process.cancellationConsents,
                proposalSnapshot: process.proposalSnapshot,
                approvals: process.approvals,
                confirmations: process.confirmations,
            },
        );
        const view = this.view({ ...row, version: space.version }, process);
        await this.record(
            input,
            row.actorMemberId!,
            'PROPOSE_CLOSURE_CUTOFF',
            digest,
            view,
            200,
        );
        return { view, replayed: false, httpStatus: 200 };
    }

    async replayDestination(
        input: ClosureDestinationReplayInput,
    ): Promise<SpaceClosureCommandResult | null> {
        this.transactionManager();
        await this.loadSpace(input.actorId, input.spaceId, true);
        return this.replay(
            input,
            'UPSERT_CLOSURE_DESTINATION',
            this.digest(input),
        );
    }

    async upsertDestination(
        input: UpsertClosureDestinationInput,
    ): Promise<SpaceClosureCommandResult> {
        const manager = this.transactionManager();
        const row = await this.loadSpace(input.actorId, input.spaceId, true);
        const digest = this.digest(input);
        const replay = await this.replay(
            input,
            'UPSERT_CLOSURE_DESTINATION',
            digest,
        );
        if (replay) return replay;
        this.assertVersion(row, input.expectedSpaceVersion);
        const process = await this.process(input.spaceId, true);
        if (!process) throw new SpacesDomainError('CLOSURE_PROCESS_NOT_FOUND');
        if (row.status !== 'CLOSING' || process.status !== 'OPEN') {
            throw new SpacesDomainError('CLOSURE_PROCESS_NOT_OPEN');
        }
        if (process.planRevision !== input.expectedPlanRevision)
            throw new ConcurrentModificationError();
        if (
            JSON.stringify(this.intentDigest(input.intent)) !==
            JSON.stringify(this.intentDigest(input.destination))
        ) {
            throw new SpacesDomainError('CLOSURE_DESTINATION_INVALID');
        }
        const space = await this.requireAggregate(input.spaceId);
        const next = space
            .upsertClosureDestination(
                PersonId.from(input.actorId),
                this.restorePlan(process),
                input.destination,
                input.now,
            )
            .snapshot();
        Object.assign(process, {
            futureDestinations: next.futureDestinations,
            cancellationConsents: next.cancellationConsents,
            proposalSnapshot: next.proposalSnapshot,
            planRevision: next.planRevision,
            planStatus: next.planStatus,
            approvals: next.approvals,
            confirmations: next.confirmations,
        });
        await this.saveSpace(space, input.expectedSpaceVersion);
        await manager.update(
            SpaceClosureProcessOrmEntity,
            { id: process.id, spaceId: input.spaceId },
            {
                futureDestinations: process.futureDestinations,
                cancellationConsents: process.cancellationConsents,
                proposalSnapshot: process.proposalSnapshot,
                planRevision: process.planRevision,
                planStatus: process.planStatus,
                approvals: process.approvals,
                confirmations: process.confirmations,
            },
        );
        const view = this.view({ ...row, version: space.version }, process);
        await this.record(
            input,
            row.actorMemberId!,
            'UPSERT_CLOSURE_DESTINATION',
            digest,
            view,
            200,
        );
        return { view, replayed: false, httpStatus: 200 };
    }

    async replayPlanDecision(
        input: ClosurePlanDecisionInput,
    ): Promise<SpaceClosureCommandResult | null> {
        this.transactionManager();
        await this.loadSpace(input.actorId, input.spaceId, true);
        return this.replay(
            input,
            this.planOperation(input.action),
            this.digest(input),
        );
    }

    async decidePlan(
        input: ClosurePlanDecisionInput,
    ): Promise<SpaceClosureCommandResult> {
        const manager = this.transactionManager();
        const row = await this.loadSpace(input.actorId, input.spaceId, true);
        const digest = this.digest(input);
        const operation = this.planOperation(input.action);
        const replay = await this.replay(input, operation, digest);
        if (replay) return replay;
        this.assertVersion(row, input.expectedSpaceVersion);
        const process = await this.process(input.spaceId, true);
        if (!process) throw new SpacesDomainError('CLOSURE_PROCESS_NOT_FOUND');
        if (row.status !== 'CLOSING' || process.status !== 'OPEN')
            throw new SpacesDomainError('CLOSURE_PROCESS_NOT_OPEN');
        if (process.planRevision !== input.expectedPlanRevision)
            throw new ConcurrentModificationError();
        if (
            input.action !== 'REJECT' &&
            (!input.proposalSnapshot ||
                input.proposalSnapshot.financialFingerprint !==
                    input.expectedFinancialFingerprint)
        ) {
            throw new SpacesDomainError('CLOSURE_PROPOSAL_CHANGED');
        }
        const space = await this.requireAggregate(input.spaceId);
        const next = space
            .decideClosurePlan(
                PersonId.from(input.actorId),
                this.restorePlan(process),
                input.action,
                input.proposalSnapshot,
                input.now,
            )
            .snapshot();
        Object.assign(process, {
            cutoffDate: next.cutoffDate,
            proposedCutoffDate: next.proposedCutoffDate,
            proposalSnapshot: next.proposalSnapshot,
            hasBilateralApproval: next.hasBilateralApproval,
            cancellationConsents: next.cancellationConsents,
            planRevision: next.planRevision,
            planStatus: next.planStatus,
            approvals: next.approvals,
            confirmations: next.confirmations,
        });
        await this.saveSpace(space, input.expectedSpaceVersion);
        await manager.update(
            SpaceClosureProcessOrmEntity,
            { id: process.id, spaceId: input.spaceId },
            {
                cutoffDate: process.cutoffDate,
                proposedCutoffDate: process.proposedCutoffDate,
                proposalSnapshot: process.proposalSnapshot,
                hasBilateralApproval: process.hasBilateralApproval,
                cancellationConsents: process.cancellationConsents,
                planRevision: process.planRevision,
                planStatus: process.planStatus,
                approvals: process.approvals,
                confirmations: process.confirmations,
            },
        );
        const view = this.view({ ...row, version: space.version }, process);
        await this.record(
            input,
            row.actorMemberId!,
            operation,
            digest,
            view,
            200,
        );
        return { view, replayed: false, httpStatus: 200 };
    }

    async replayConclusion(
        input: ClosureConclusionInput,
    ): Promise<SpaceClosureCommandResult | null> {
        this.transactionManager();
        await this.loadSpace(input.actorId, input.spaceId, true);
        return this.replay(
            input,
            this.conclusionOperation(input.action),
            this.digest(input),
        );
    }

    confirm(input: ConfirmClosureInput): Promise<SpaceClosureCommandResult> {
        return this.conclude(input);
    }

    cancel(input: CancelClosureInput): Promise<SpaceClosureCommandResult> {
        return this.conclude(input);
    }

    private async conclude(
        input: ClosureConclusionInput,
    ): Promise<SpaceClosureCommandResult> {
        const manager = this.transactionManager();
        const row = await this.loadSpace(input.actorId, input.spaceId, true);
        const digest = this.digest(input);
        const operation = this.conclusionOperation(input.action);
        const replay = await this.replay(input, operation, digest);
        if (replay) return replay;
        this.assertVersion(row, input.expectedSpaceVersion);
        const process = await this.process(input.spaceId, true);
        if (!process || process.status !== 'OPEN' || row.status !== 'CLOSING')
            throw new SpacesDomainError('CLOSURE_PROCESS_NOT_OPEN');
        if (process.planRevision !== input.expectedPlanRevision)
            throw new ConcurrentModificationError();
        await this.assertHistoricalParticipants(process);
        const space = await this.requireAggregate(input.spaceId);
        const plan = this.restorePlan(process);
        const actor = PersonId.from(input.actorId);
        const result =
            input.action === 'CONFIRM'
                ? space.confirmClosure(actor, plan, {
                      now: input.now,
                      expectedFinancialFingerprint:
                          input.expectedFinancialFingerprint,
                      financialFingerprint: input.financialFingerprint,
                      financiallyReady: input.financiallyReady,
                      completionPrepared: input.completionPrepared,
                  })
                : space.cancelClosure(actor, plan, input.now);
        const snapshot = result.plan.snapshot();
        Object.assign(process, {
            status: result.completed
                ? input.action === 'CONFIRM'
                    ? 'COMPLETED'
                    : 'CANCELLED'
                : 'OPEN',
            completedAt:
                result.completed && input.action === 'CONFIRM'
                    ? input.now
                    : null,
            cancelledAt:
                result.completed && input.action === 'CANCEL'
                    ? input.now
                    : null,
            planStatus: snapshot.planStatus,
            proposedCutoffDate: snapshot.proposedCutoffDate,
            proposalSnapshot: snapshot.proposalSnapshot,
            approvals: snapshot.approvals,
            confirmations: snapshot.confirmations,
            cancellationConsents: snapshot.cancellationConsents,
        });
        await this.saveSpace(space, input.expectedSpaceVersion);
        await manager.update(
            SpaceClosureProcessOrmEntity,
            { id: process.id, spaceId: input.spaceId },
            {
                status: process.status,
                completedAt: process.completedAt,
                cancelledAt: process.cancelledAt,
                planStatus: process.planStatus,
                proposedCutoffDate: process.proposedCutoffDate,
                proposalSnapshot: process.proposalSnapshot,
                approvals: process.approvals,
                confirmations: process.confirmations,
                cancellationConsents: process.cancellationConsents,
            },
        );
        const view = this.view(
            { ...row, status: space.status, version: space.version },
            process,
        );
        await this.record(
            input,
            row.actorMemberId!,
            operation,
            digest,
            view,
            200,
        );
        return { view, replayed: false, httpStatus: 200 };
    }

    private async assertHistoricalParticipants(
        process: SpaceClosureProcessOrmEntity,
    ): Promise<void> {
        const members: { id: string; personId: string }[] = await this.managers
            .get()
            .query(
                `SELECT id,person_id AS "personId" FROM space_members WHERE space_id=$1 ORDER BY id`,
                [process.spaceId],
            );
        if (
            members.length !== process.participants.length ||
            members.some(
                (member) =>
                    !process.participants.some(
                        (participant) =>
                            participant.memberId === member.id &&
                            participant.personId === member.personId,
                    ),
            )
        ) {
            throw new SpacesDomainError('CLOSURE_PARTICIPANTS_CHANGED');
        }
    }

    async read(
        actorId: string,
        spaceId: string,
    ): Promise<SpaceClosureView | null> {
        const view = await this.managers.readSnapshot(async () => {
            const row = await this.loadSpace(actorId, spaceId, false);
            const process = await this.process(spaceId);
            return process ? this.view(row, process) : null;
        });
        await this.loadSpace(actorId, spaceId, false);
        return view;
    }

    async lockForProcess(
        actorId: string,
        spaceId: string,
    ): Promise<SpaceClosureView | null> {
        this.transactionManager();
        const row = await this.loadSpace(actorId, spaceId, true);
        const process = await this.process(spaceId);
        return process ? this.view(row, process) : null;
    }

    async history(
        actorId: string,
        spaceId: string,
        input: { limit: number; cursor?: string },
    ) {
        const cursor = this.parseCursor(input.cursor, spaceId);
        if (
            !Number.isSafeInteger(input.limit) ||
            input.limit < 1 ||
            input.limit > 100
        ) {
            throw new SpacesDomainError('CLOSURE_HISTORY_CURSOR_INVALID');
        }
        const result = await this.managers.readSnapshot(async () => {
            await this.loadSpace(actorId, spaceId, false);
            const query = this.managers
                .get()
                .getRepository(SpaceClosureHistoryOrmEntity)
                .createQueryBuilder('history')
                .where('history.space_id=:spaceId', { spaceId });
            if (cursor)
                query.andWhere(
                    '(history.recorded_at, history.id) < (:recordedAt, :id)',
                    cursor,
                );
            const rows = await query
                .orderBy('history.recorded_at', 'DESC')
                .addOrderBy('history.id', 'DESC')
                .take(input.limit + 1)
                .getMany();
            const page = rows.slice(0, input.limit);
            const last = page.at(-1);
            return {
                items: page.map((item) => ({
                    id: item.id,
                    processId: item.processId,
                    action: item.action,
                    actorMemberId: item.actorMemberId,
                    planRevision: item.planRevision,
                    recordedAt: item.recordedAt.toISOString(),
                    snapshot: item.snapshot,
                })),
                nextCursor:
                    rows.length > input.limit && last
                        ? Buffer.from(
                              JSON.stringify({
                                  spaceId: spaceId.toLowerCase(),
                                  recordedAt: last.recordedAt.toISOString(),
                                  id: last.id,
                              }),
                          ).toString('base64url')
                        : null,
            };
        });
        await this.loadSpace(actorId, spaceId, false);
        return result;
    }

    private async loadSpace(
        actorId: string,
        spaceId: string,
        lock: boolean,
    ): Promise<ClosureSpaceRow> {
        const rows: ClosureSpaceRow[] = await this.managers.get().query(
            `SELECT s.id, s.type, s.status, s.version, m.id AS "actorMemberId",
                (SELECT CASE WHEN i.status='PENDING' AND i.expires_at <= now() THEN 'EXPIRED' ELSE i.status END
                 FROM space_invitations i WHERE i.space_id=s.id
                 ORDER BY (i.status='PENDING') DESC, i.issued_at DESC, i.id DESC LIMIT 1) AS "invitationStatus"
             FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.person_id=$1
             WHERE s.id=$2 AND ((s.type='PERSONAL' AND s.personal_owner_person_id=$1) OR (s.type='SHARED' AND m.id IS NOT NULL))
             ${lock ? 'FOR UPDATE OF s' : ''}`,
            [actorId, spaceId],
        );
        const row = rows[0];
        if (!row) throw new SpacesDomainError('SPACE_NOT_FOUND');
        if (row.type !== 'SHARED')
            throw new SpacesDomainError('SHARED_SPACE_REQUIRED');
        return row;
    }

    private async process(spaceId: string, openOnly = false) {
        return this.managers
            .get()
            .getRepository(SpaceClosureProcessOrmEntity)
            .createQueryBuilder('process')
            .where('process.space_id=:spaceId', { spaceId })
            .andWhere(openOnly ? "process.status='OPEN'" : 'TRUE')
            .orderBy("CASE WHEN process.status='OPEN' THEN 0 ELSE 1 END", 'ASC')
            .addOrderBy(
                `COALESCE((SELECT MAX((entry.snapshot->>'spaceVersion')::bigint)
                FROM space_closure_history entry WHERE entry.process_id=process.id AND entry.space_id=process.space_id),0)`,
                'DESC',
            )
            .addOrderBy('process.started_at', 'DESC')
            .addOrderBy('process.id', 'DESC')
            .limit(1)
            .getOne();
    }

    private async requireAggregate(spaceId: string) {
        const space = await this.spaces.findById(SpaceId.from(spaceId));
        if (!space) throw new SpacesDomainError('SPACE_NOT_FOUND');
        return space;
    }

    private async saveSpace(space: Space, expectedVersion: number) {
        const updated = await this.transactionManager()
            .createQueryBuilder()
            .update(SpaceOrmEntity)
            .set({
                status: space.status,
                version: space.version,
                updatedAt: space.updatedAt,
            })
            .where('id=:id AND version=:expectedVersion AND type=:type', {
                id: space.id.value,
                expectedVersion,
                type: 'SHARED',
            })
            .execute();
        if (updated.affected !== 1) throw new ConcurrentModificationError();
    }

    private view(
        row: ClosureSpaceRow,
        process: SpaceClosureProcessOrmEntity,
    ): SpaceClosureView {
        return {
            spaceId: row.id,
            spaceStatus: row.status,
            spaceVersion: row.version,
            processId: process.id,
            processStatus: process.status,
            planRevision: process.planRevision,
            planStatus: process.planStatus,
            cutoffDate: process.cutoffDate,
            proposedCutoffDate: process.proposedCutoffDate,
            requestedByMemberId: process.requestedByMemberId,
            requiredMemberIds: process.participants.map(
                (member) => member.memberId,
            ),
            participants: structuredClone(process.participants),
            approvals: structuredClone(process.approvals),
            confirmations: structuredClone(process.confirmations),
            futureDestinations: structuredClone(process.futureDestinations),
            proposalSnapshot: structuredClone(process.proposalSnapshot ?? null),
            hasBilateralApproval: process.hasBilateralApproval ?? false,
            cancellationConsents: structuredClone(
                process.cancellationConsents ?? [],
            ),
            actorNextAction: this.nextAction(row, process),
            startedAt: process.startedAt.toISOString(),
            completedAt: process.completedAt?.toISOString() ?? null,
            cancelledAt: process.cancelledAt?.toISOString() ?? null,
            invitationStatus: row.invitationStatus,
        };
    }

    private digest(
        input:
            | SpaceClosureCommandBase
            | ProposeClosureCutoffInput
            | ClosureDestinationReplayInput
            | ClosurePlanDecisionInput
            | ClosureConclusionInput,
    ): Buffer {
        const fields: unknown[] = [
            input.spaceId.toLowerCase(),
            input.expectedSpaceVersion,
            'expectedPlanRevision' in input ? input.expectedPlanRevision : null,
            'cutoffDate' in input ? input.cutoffDate : null,
        ];
        if ('intent' in input) fields.push(this.intentDigest(input.intent));
        if ('action' in input)
            fields.push(
                input.action,
                input.action === 'REJECT'
                    ? null
                    : 'expectedFinancialFingerprint' in input
                      ? (input.expectedFinancialFingerprint ?? null)
                      : null,
            );
        return createHash('sha256').update(JSON.stringify(fields)).digest();
    }

    private planOperation(action: ClosurePlanAction): string {
        return {
            PROPOSE: 'PROPOSE_CLOSURE_PLAN',
            APPROVE: 'APPROVE_CLOSURE_PLAN',
            REJECT: 'REJECT_CLOSURE_PLAN',
        }[action];
    }

    private conclusionOperation(
        action: ClosureConclusionInput['action'],
    ): string {
        return action === 'CONFIRM'
            ? 'CONFIRM_SPACE_CLOSURE'
            : 'CANCEL_SPACE_CLOSURE';
    }

    private nextAction(
        row: ClosureSpaceRow,
        process: SpaceClosureProcessOrmEntity,
    ): SpaceClosureNextAction {
        if (row.status !== 'CLOSING' || process.status !== 'OPEN')
            return 'READ_ONLY';
        if (process.cancellationConsents?.length) {
            return process.cancellationConsents.some(
                (consent) => consent.memberId === row.actorMemberId,
            )
                ? 'WAIT_CANCELLATION'
                : 'APPROVE_CANCELLATION';
        }
        if (process.planStatus === 'APPROVED') return 'REVIEW_CLOSURE';
        if (process.planStatus === 'PROPOSED') {
            return process.approvals[0]?.memberId === row.actorMemberId
                ? 'WAIT_APPROVAL'
                : 'REVIEW_PLAN';
        }
        return 'PROPOSE_PLAN';
    }

    private intentDigest(intent: ClosureDestinationIntent): unknown[] {
        return [
            intent.originType,
            intent.originId.toLowerCase(),
            intent.expectedOriginVersion,
            intent.destination,
            intent.assigneeMemberId?.toLowerCase() ?? null,
            intent.amountInCents ?? null,
        ];
    }

    private restorePlan(process: SpaceClosureProcessOrmEntity): ClosurePlan {
        return ClosurePlan.restore({
            processId: process.id,
            requestedByMemberId: process.requestedByMemberId,
            participants: process.participants,
            startedAt: process.startedAt.toISOString(),
            cutoffDate: process.cutoffDate,
            proposedCutoffDate: process.proposedCutoffDate,
            planRevision: process.planRevision,
            planStatus: process.planStatus,
            approvals: process.approvals,
            confirmations: process.confirmations,
            futureDestinations: process.futureDestinations,
            proposalSnapshot: process.proposalSnapshot ?? null,
            hasBilateralApproval: process.hasBilateralApproval ?? false,
            cancellationConsents: process.cancellationConsents ?? [],
        });
    }

    private async replay(
        input: SpaceClosureCommandBase,
        operation: string,
        digest: Buffer,
    ): Promise<SpaceClosureCommandResult | null> {
        const receipt = await this.managers
            .get()
            .findOneBy(SpaceClosureCommandReceiptOrmEntity, {
                actorId: input.actorId,
                operation,
                key: input.idempotencyKey,
            });
        if (!receipt) return null;
        if (!receipt.requestHash.equals(digest))
            throw new IdempotencyKeyReusedError();
        return {
            view: structuredClone(receipt.result),
            replayed: true,
            httpStatus: receipt.httpStatus,
        };
    }

    private async record(
        input: SpaceClosureCommandBase,
        actorMemberId: string,
        action: string,
        digest: Buffer,
        view: SpaceClosureView,
        httpStatus: 200 | 201,
    ): Promise<void> {
        const manager = this.transactionManager();
        await manager.insert(SpaceClosureHistoryOrmEntity, {
            id: randomUUID(),
            spaceId: input.spaceId,
            processId: view.processId,
            action,
            actorMemberId,
            planRevision: view.planRevision,
            recordedAt: input.now,
            snapshot: view,
        });
        await manager.insert(SpaceClosureAuditOrmEntity, {
            id: randomUUID(),
            spaceId: input.spaceId,
            processId: view.processId,
            actorId: input.actorId,
            action,
            idempotencyKey: input.idempotencyKey,
            planRevision: view.planRevision,
            recordedAt: input.now,
        });
        try {
            await manager.insert(SpaceClosureCommandReceiptOrmEntity, {
                actorId: input.actorId,
                operation: action,
                key: input.idempotencyKey,
                spaceId: input.spaceId,
                processId: view.processId,
                requestHash: digest,
                httpStatus,
                result: view,
                recordedAt: input.now,
            });
        } catch (error: unknown) {
            if (error instanceof QueryFailedError) {
                const databaseError = error.driverError as {
                    code?: string;
                    constraint?: string;
                };
                if (
                    databaseError.code === '23505' &&
                    databaseError.constraint ===
                        'PK_space_closure_command_receipts'
                ) {
                    throw new IdempotencyKeyReusedError();
                }
            }
            throw error;
        }
    }

    private assertVersion(row: ClosureSpaceRow, expectedVersion: number): void {
        if (
            !Number.isSafeInteger(expectedVersion) ||
            row.version !== expectedVersion
        ) {
            throw new ConcurrentModificationError();
        }
    }

    private transactionManager(): EntityManager {
        const manager = this.managers.get();
        if (!manager.queryRunner?.isTransactionActive)
            throw new Error('Space closure commands require a transaction');
        return manager;
    }

    private parseCursor(
        value: string | undefined,
        spaceId: string,
    ): HistoryCursor | null {
        if (!value) return null;
        try {
            const parsed: unknown = JSON.parse(
                Buffer.from(value, 'base64url').toString(),
            );
            if (
                !parsed ||
                typeof parsed !== 'object' ||
                !('spaceId' in parsed) ||
                parsed.spaceId !== spaceId.toLowerCase() ||
                !('recordedAt' in parsed) ||
                !('id' in parsed) ||
                typeof parsed.recordedAt !== 'string' ||
                typeof parsed.id !== 'string' ||
                !Number.isFinite(Date.parse(parsed.recordedAt)) ||
                !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
                    parsed.id,
                )
            ) {
                throw new Error('Invalid cursor');
            }
            return {
                spaceId: spaceId.toLowerCase(),
                recordedAt: new Date(parsed.recordedAt).toISOString(),
                id: parsed.id,
            };
        } catch {
            throw new SpacesDomainError('CLOSURE_HISTORY_CURSOR_INVALID');
        }
    }
}
