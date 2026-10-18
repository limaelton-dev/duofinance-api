import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManagerProvider } from '../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type {
    HistoryEvent,
    RoutineStore,
} from '../application/routine-store.js';
import type { Task } from '../domain/task.js';
import { RoutineError } from '../domain/routine-error.js';
import {
    TaskOrmEntity,
    RoutineHistoryOrmEntity,
    RoutineReceiptOrmEntity,
    RoutineAuditOrmEntity,
    rowToTask,
    taskToRow,
} from './routine.orm-entity.js';
@Injectable()
export class TypeOrmRoutineStore implements RoutineStore {
    constructor(private readonly provider: EntityManagerProvider) {}
    snapshot<T>(work: () => Promise<T>) {
        return this.provider.readSnapshot(work);
    }
    async find(spaceId: string, id: string) {
        const row = await this.provider
            .get()
            .findOneBy(TaskOrmEntity, { spaceId, id });
        if (!row) throw new RoutineError('TASK_NOT_FOUND');
        return rowToTask(row);
    }
    async insert(task: Task) {
        await this.provider.get().insert(TaskOrmEntity, taskToRow(task));
    }
    async update(before: Task, after: Task) {
        const changed = await this.provider.get().update(
            TaskOrmEntity,
            {
                spaceId: before.spaceId,
                id: before.id,
                version: before.version,
            },
            taskToRow(after),
        );
        if (changed.affected !== 1)
            throw new RoutineError('CONCURRENT_MODIFICATION');
    }
    async event(event: HistoryEvent) {
        await this.provider.get().insert(RoutineHistoryOrmEntity, event);
    }
    history(
        spaceId: string,
        aggregateId: string,
        after: number,
        limit: number,
    ) {
        return this.provider
            .get()
            .createQueryBuilder(RoutineHistoryOrmEntity, 'h')
            .where(
                'h.spaceId=:spaceId AND h.aggregateId=:aggregateId AND h.sequence>:after',
                { spaceId, aggregateId, after },
            )
            .orderBy('h.sequence', 'ASC')
            .take(limit)
            .getMany();
    }
    async lockReceipt(actor: string, operation: string, key: string) {
        await this.provider
            .get()
            .query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
                `${actor}:${operation}:${key}`,
            ]);
    }
    async receipt(actorId: string, operation: string, key: string) {
        return this.provider
            .get()
            .findOneBy(RoutineReceiptOrmEntity, { actorId, operation, key });
    }
    async finish(input: Parameters<RoutineStore['finish']>[0]) {
        const {
            actorId,
            operation,
            key,
            digest,
            result,
            spaceId,
            aggregateId,
            registeredAt,
        } = input;
        await this.provider.get().insert(RoutineReceiptOrmEntity, {
            actorId,
            operation,
            key,
            digest,
            result,
        });
        await this.provider.get().insert(RoutineAuditOrmEntity, {
            id: randomUUID(),
            actorId,
            spaceId,
            action: operation,
            key,
            aggregateId,
            registeredAt,
        });
    }
}
