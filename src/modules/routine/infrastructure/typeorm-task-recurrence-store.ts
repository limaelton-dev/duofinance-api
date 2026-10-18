import { Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { TaskRecurrenceStore } from '../application/task-recurrence-store.js';
import type {
    TaskRecurrence,
    TaskOccurrence,
} from '../domain/task-recurrence.js';
import { RoutineError } from '../domain/routine-error.js';
import {
    TaskRecurrenceOrmEntity,
    TaskOccurrenceOrmEntity,
} from './task-recurrence.orm-entity.js';
const row = (r: TaskRecurrence) => ({
    id: r.id,
    spaceId: r.spaceId,
    creatorPersonId: r.creator.personId,
    startsOn: r.startsOn,
    endsOn: r.endsOn,
    cancelledOn: r.cancelledOn,
    status: r.status,
    version: r.version,
    snapshot: r,
});
@Injectable()
export class TypeOrmTaskRecurrenceStore implements TaskRecurrenceStore {
    constructor(private readonly provider: EntityManagerProvider) {}
    async find(spaceId: string, id: string, lock = false) {
        const q = this.provider
            .get()
            .createQueryBuilder(TaskRecurrenceOrmEntity, 'r')
            .where('r.spaceId=:spaceId AND r.id=:id', { spaceId, id });
        if (lock) q.setLock('pessimistic_write');
        const found = await q.getOne();
        if (!found) throw new RoutineError('RECURRENCE_NOT_FOUND');
        return found.snapshot;
    }
    async insert(recurrence: TaskRecurrence) {
        await this.provider
            .get()
            .insert(TaskRecurrenceOrmEntity, row(recurrence));
    }
    async update(before: TaskRecurrence, after: TaskRecurrence) {
        const result = await this.provider.get().update(
            TaskRecurrenceOrmEntity,
            {
                spaceId: before.spaceId,
                id: before.id,
                version: before.version,
            },
            row(after),
        );
        if (result.affected !== 1)
            throw new RoutineError('CONCURRENT_MODIFICATION');
    }
    async page(spaceId: string, after: string | null, limit: number) {
        const q = this.provider
            .get()
            .createQueryBuilder(TaskRecurrenceOrmEntity, 'r')
            .where('r.spaceId=:spaceId', { spaceId })
            .orderBy('r.id', 'ASC')
            .limit(limit);
        if (after) q.andWhere('r.id>:after', { after });
        return (await q.getMany()).map((r) => r.snapshot);
    }
    async occurrence(
        spaceId: string,
        recurrenceId: string,
        scheduledDate: string,
    ) {
        return (
            (
                await this.provider.get().findOneBy(TaskOccurrenceOrmEntity, {
                    spaceId,
                    recurrenceId,
                    scheduledDate,
                })
            )?.snapshot ?? null
        );
    }
    async saveOccurrence(before: TaskOccurrence | null, after: TaskOccurrence) {
        const values = {
            id: after.id,
            spaceId: after.spaceId,
            recurrenceId: after.recurrenceId,
            scheduledDate: after.scheduledDate,
            status: after.status,
            version: after.version,
            snapshot: after,
        };
        if (!before) {
            await this.provider.get().insert(TaskOccurrenceOrmEntity, values);
            return;
        }
        const result = await this.provider.get().update(
            TaskOccurrenceOrmEntity,
            {
                id: before.id,
                spaceId: before.spaceId,
                version: before.version,
            },
            values,
        );
        if (result.affected !== 1)
            throw new RoutineError('CONCURRENT_MODIFICATION');
    }
    async occurrences(
        spaceId: string,
        recurrenceId: string,
        from: string,
        to: string,
    ) {
        return (
            await this.provider
                .get()
                .createQueryBuilder(TaskOccurrenceOrmEntity, 'o')
                .where(
                    'o.spaceId=:spaceId AND o.recurrenceId=:recurrenceId AND o.scheduledDate BETWEEN :from AND :to',
                    { spaceId, recurrenceId, from, to },
                )
                .getMany()
        ).map((o) => o.snapshot);
    }
}
