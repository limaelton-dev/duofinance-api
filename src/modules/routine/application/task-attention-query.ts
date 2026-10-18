import { Inject, Injectable } from '@nestjs/common';
import {
    ROUTINE_CLOCK,
    type RoutineClock,
    routineReference,
} from './routine-clock.js';
import { TaskQueries, taskView } from './task-queries.js';
import {
    TASK_ATTENTION_READER,
    type TaskAttentionReader,
    type TaskListFilters,
} from './task-attention-reader.js';
import { cursorScope, decodeCursor, encodeCursor } from './routine-cursor.js';
import { RoutineError } from '../domain/routine-error.js';
import { taskAttention } from '../domain/task-attention.js';
import { validDate } from '../domain/task.js';
export function attentionView(
    task: Parameters<typeof taskView>[0],
    reference: ReturnType<typeof routineReference>,
    canWrite = true,
) {
    return {
        ...taskView(task, canWrite),
        conditions: taskAttention(task, reference),
    };
}
@Injectable()
export class TaskAttentionQuery {
    constructor(
        private readonly queries: TaskQueries,
        @Inject(TASK_ATTENTION_READER)
        private readonly reader: TaskAttentionReader,
        @Inject(ROUTINE_CLOCK) private readonly clock: RoutineClock,
    ) {}
    async list(
        actor: string,
        space: string,
        q: TaskListFilters & { limit: number; cursor?: string },
        instant?: Date,
    ) {
        const { cursor, limit, ...filters } = q;
        const scope = cursorScope({ actor, space, ...filters });
        const key = decodeCursor(scope, cursor);
        let reference = routineReference(instant ?? this.clock.now());
        let after: string | null = null;
        if (key !== null) {
            if (
                typeof key !== 'object' ||
                !key ||
                !('instant' in key) ||
                !('sortKey' in key) ||
                typeof key.instant !== 'string' ||
                !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
                    key.instant,
                ) ||
                !validDate(key.instant.slice(0, 10)) ||
                typeof key.sortKey !== 'string' ||
                !/^[0-3]:[0-3]:\d{4}-\d{2}-\d{2}:([01]\d|2[0-3]):[0-5]\d:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/\d{4}-\d{2}-\d{2})?$/.test(
                    key.sortKey,
                ) ||
                !Number.isFinite(Date.parse(key.instant)) ||
                new Date(key.instant).toISOString() !== key.instant
            )
                throw new RoutineError('VALIDATION_ERROR', 'cursor');
            reference = routineReference(new Date(key.instant));
            if (!validDate(reference.referenceDate))
                throw new RoutineError('VALIDATION_ERROR', 'cursor');
            after = key.sortKey;
            if (
                !validDate(after.split(':')[2]) ||
                (after.includes('/') && !validDate(after.split('/')[1]))
            )
                throw new RoutineError('VALIDATION_ERROR', 'cursor');
        }
        return this.queries.read(
            actor,
            space,
            async () => {
                const result = await this.reader.read(
                    space,
                    actor,
                    filters,
                    reference,
                    after,
                    limit + 1,
                );
                const rows = result.rows.slice(0, limit);
                return {
                    ...reference,
                    items: rows.map((row) =>
                        attentionView(row.task, reference),
                    ),
                    counts: result.counts,
                    nextCursor:
                        result.rows.length > limit
                            ? encodeCursor(scope, {
                                  instant: reference.referenceInstant,
                                  sortKey: rows.at(-1)!.sortKey,
                              })
                            : null,
                };
            },
            (page, context) => ({
                ...page,
                items: page.items.map((task) =>
                    attentionView(task, reference, context.status === 'ACTIVE'),
                ),
            }),
        );
    }
}
