import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManagerProvider } from '../../../shared/technical/database/typeorm/entity-manager.provider.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../spaces/application/ports/public/space-access.port.js';
import { PersonId } from '../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../spaces/domain/space/space-id.js';
import type { RoutineClosurePort } from '../application/ports/public/routine-closure.port.js';
import {
    SPACE_CLOSURE_PORT,
    type SpaceClosurePort,
} from '../../spaces/application/ports/public/space-closure.port.js';
import {
    ROUTINE_STORE,
    type RoutineStore,
} from '../application/routine-store.js';
import {
    TASK_RECURRENCE_STORE,
    type TaskRecurrenceStore,
} from '../application/task-recurrence-store.js';
import { RoutineError } from '../domain/routine-error.js';
import { maintainTask } from '../domain/task-maintenance.js';
import { routineReference } from '../application/routine-clock.js';
import {
    RoutineAuditOrmEntity,
    TaskOrmEntity,
    rowToTask,
} from './routine.orm-entity.js';
import {
    TaskOccurrenceOrmEntity,
    TaskRecurrenceOrmEntity,
} from './task-recurrence.orm-entity.js';

@Injectable()
export class TypeOrmRoutineClosure implements RoutineClosurePort {
    constructor(
        private readonly manager: EntityManagerProvider,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_CLOSURE_PORT) private readonly closures: SpaceClosurePort,
        @Inject(ROUTINE_STORE) private readonly tasks: RoutineStore,
        @Inject(TASK_RECURRENCE_STORE)
        private readonly recurrences: TaskRecurrenceStore,
    ) {}
    async complete(
        actorId: string,
        spaceId: string,
        processId: string,
        now: Date,
    ): Promise<void> {
        const manager = this.manager.get();
        if (!manager.queryRunner?.isTransactionActive)
            throw new Error('Routine closure requires a transaction');
        await this.access.assertCanRead(
            PersonId.from(actorId),
            SpaceId.from(spaceId),
        );
        const process = await this.closures.lockForProcess(actorId, spaceId);
        if (
            !process ||
            process.processId !== processId ||
            process.spaceStatus !== 'CLOSING' ||
            process.processStatus !== 'OPEN' ||
            process.planStatus !== 'APPROVED' ||
            !process.requiredMemberIds.every((memberId) =>
                process.approvals.some(
                    (approval) =>
                        approval.memberId === memberId &&
                        approval.planRevision === process.planRevision,
                ),
            )
        )
            throw new RoutineError('CONCURRENT_MODIFICATION');
        const closure = { processId, planRevision: process.planRevision };
        const registeredAt = now.toISOString();
        const record = async (
            aggregateId: string,
            sequence: number,
            type: string,
            action: string,
            before: object,
            after: object,
        ) => {
            await this.tasks.event({
                id: randomUUID(),
                spaceId,
                aggregateId,
                sequence,
                type,
                actorId,
                registeredAt: now,
                data: { before, after, closure },
            });
            await manager.insert(RoutineAuditOrmEntity, {
                id: randomUUID(),
                spaceId,
                actorId,
                action,
                aggregateId,
                key: processId,
                registeredAt: now,
            });
        };
        const taskRows = await manager
            .createQueryBuilder(TaskOrmEntity, 'task')
            .where('task.spaceId=:spaceId AND task.status=:status', {
                spaceId,
                status: 'PENDING',
            })
            .orderBy('task.id', 'ASC')
            .setLock('pessimistic_write')
            .getMany();
        for (const row of taskRows) {
            const before = rowToTask(row),
                after = maintainTask(before, { kind: 'CANCEL' });
            await this.tasks.update(before, after);
            await record(
                before.id,
                after.version,
                'CANCELLED',
                'CLOSE_SPACE_TASK',
                before,
                after,
            );
        }
        const recurrenceRows = await manager
            .createQueryBuilder(TaskRecurrenceOrmEntity, 'recurrence')
            .where('recurrence.spaceId=:spaceId', { spaceId })
            .orderBy('recurrence.id', 'ASC')
            .setLock('pessimistic_write')
            .getMany();
        for (const row of recurrenceRows) {
            const before = row.snapshot;
            if (before.closure) continue;
            const after = {
                ...before,
                status: 'CANCELLED' as const,
                version: before.version + 1,
                cancelledAt: before.cancelledAt ?? registeredAt,
                cancelledOn:
                    before.cancelledOn ?? routineReference(now).referenceDate,
                closure: { ...closure, recordedAt: registeredAt },
            };
            await this.recurrences.update(before, after);
            await record(
                before.id,
                after.version,
                'RECURRENCE_CANCELLED',
                'CLOSE_SPACE_RECURRENCE',
                before,
                after,
            );
        }
        const occurrenceRows = await manager
            .createQueryBuilder(TaskOccurrenceOrmEntity, 'occurrence')
            .where(
                'occurrence.spaceId=:spaceId AND occurrence.status=:status',
                { spaceId, status: 'PENDING' },
            )
            .orderBy('occurrence.id', 'ASC')
            .setLock('pessimistic_write')
            .getMany();
        for (const row of occurrenceRows) {
            const before = row.snapshot,
                after = {
                    ...before,
                    status: 'CANCELLED' as const,
                    version: before.version + 1,
                };
            await this.recurrences.saveOccurrence(before, after);
            await record(
                before.id,
                after.version,
                'CANCELLED',
                'CLOSE_SPACE_OCCURRENCE',
                before,
                after,
            );
        }
    }
    async summary(actorId: string, spaceId: string) {
        await this.access.assertCanRead(
            PersonId.from(actorId),
            SpaceId.from(spaceId),
        );
        const [row] = await this.manager.get().query(
            `SELECT ((SELECT count(*) FROM routine_tasks WHERE space_id=$1 AND status='PENDING') +
                (SELECT count(*) FROM routine_task_occurrences WHERE space_id=$1 AND status='PENDING'))::int AS "pendingTaskCount",
                (SELECT count(*)::int FROM routine_task_recurrences WHERE space_id=$1 AND status='ACTIVE') AS "activeRecurrenceCount"`,
            [spaceId],
        );
        return row;
    }
}
