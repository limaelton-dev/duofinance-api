import { Inject, Injectable } from '@nestjs/common';
import { TaskQueries, taskView } from './task-queries.js';
import {
    ROUTINE_CLOCK,
    type RoutineClock,
    routineReference,
} from './routine-clock.js';
import { ROUTINE_STORE, type RoutineStore } from './routine-store.js';
import {
    TASK_RECURRENCE_STORE,
    type TaskRecurrenceStore,
} from './task-recurrence-store.js';
import {
    cursorScope,
    decodeCursor,
    encodeCursor,
    isRoutineId,
} from './routine-cursor.js';
import { RoutineError } from '../domain/routine-error.js';
import {
    addDays,
    eligibleOccurrence,
    occurrenceSnapshot,
    type TaskRecurrence,
    type TaskOccurrence,
} from '../domain/task-recurrence.js';
import { validDate } from '../domain/task.js';
import { taskAttention } from '../domain/task-attention.js';
export function projectedItem(
    recurrence: TaskRecurrence,
    date: string,
    persisted: TaskOccurrence | null,
) {
    const value =
        persisted ??
        occurrenceSnapshot(
            recurrence,
            date,
            `${recurrence.id}/${date}`,
            recurrence.createdAt,
        );
    return {
        ...value,
        kind: 'OCCURRENCE' as const,
        version: persisted?.version ?? null,
        recurrenceVersion: recurrence.version,
        materialized: persisted !== null,
    };
}
@Injectable()
export class TaskRecurrenceQueries {
    constructor(
        private readonly queries: TaskQueries,
        @Inject(ROUTINE_CLOCK) private readonly clock: RoutineClock,
        @Inject(ROUTINE_STORE) private readonly historyStore: RoutineStore,
        @Inject(TASK_RECURRENCE_STORE)
        private readonly store: TaskRecurrenceStore,
    ) {}
    list(actor: string, space: string, q: { limit: number; cursor?: string }) {
        const scope = cursorScope({ actor, space, type: 'RECURRENCES' }),
            key = decodeCursor(scope, q.cursor);
        if (key !== null && !isRoutineId(key))
            throw new RoutineError('VALIDATION_ERROR', 'cursor');
        return this.queries.read(actor, space, async () => {
            const rows = await this.store.page(
                space,
                key as string | null,
                q.limit + 1,
            );
            return {
                items: rows.slice(0, q.limit),
                nextCursor:
                    rows.length > q.limit
                        ? encodeCursor(scope, rows[q.limit - 1].id)
                        : null,
            };
        });
    }
    detail(actor: string, space: string, id: string) {
        return this.queries.read(actor, space, () =>
            this.store.find(space, id),
        );
    }
    private async occurrence(space: string, id: string, date: string) {
        const recurrence = await this.store.find(space, id),
            persisted = await this.store.occurrence(space, id, date);
        if (!persisted && !eligibleOccurrence(recurrence, date))
            throw new RoutineError('OCCURRENCE_NOT_FOUND');
        return projectedItem(recurrence, date, persisted);
    }
    occurrenceDetail(actor: string, space: string, id: string, date: string) {
        const reference = routineReference(this.clock.now());
        return this.queries.read(
            actor,
            space,
            async () => {
                const item = await this.occurrence(space, id, date);
                return {
                    ...taskView(item),
                    ...reference,
                    conditions: taskAttention(item, reference),
                };
            },
            (item, context) => ({
                ...item,
                ...taskView(item, context.status === 'ACTIVE'),
            }),
        );
    }
    occurrences(
        actor: string,
        space: string,
        id: string,
        q: { limit: number; cursor?: string; from?: string; to?: string },
    ) {
        const reference = routineReference(this.clock.now());
        const scope = cursorScope({
                actor,
                space,
                id,
                from: q.from ?? null,
                to: q.to ?? null,
                type: 'OCCURRENCES',
            }),
            key = decodeCursor(scope, q.cursor);
        if (
            key !== null &&
            (typeof key !== 'object' ||
                !key ||
                !('from' in key) ||
                !('to' in key) ||
                !('after' in key) ||
                typeof key.from !== 'string' ||
                typeof key.to !== 'string' ||
                typeof key.after !== 'string' ||
                ![key.from, key.to, key.after].every(validDate))
        )
            throw new RoutineError('VALIDATION_ERROR', 'cursor');
        const cursor = key as {
            from: string;
            to: string;
            after: string;
        } | null;
        const from = cursor?.from ?? q.from ?? reference.referenceDate,
            to = cursor?.to ?? q.to ?? addDays(from, 365);
        if (
            from > to ||
            new Date(to).getTime() - new Date(from).getTime() > 365 * 86400000
        )
            throw new RoutineError('VALIDATION_ERROR', 'to');
        return this.queries.read(
            actor,
            space,
            async () => {
                const recurrence = await this.store.find(space, id),
                    persisted = await this.store.occurrences(
                        space,
                        id,
                        from,
                        to,
                    ),
                    byDate = new Map(
                        persisted.map((item) => [item.scheduledDate, item]),
                    );
                const dates: string[] = [];
                for (let date = from; date <= to; date = addDays(date, 1)) {
                    if (
                        (!cursor || date > cursor.after) &&
                        (byDate.has(date) ||
                            eligibleOccurrence(recurrence, date))
                    )
                        dates.push(date);
                    if (date === '9999-12-31') break;
                }
                const page = dates.slice(0, q.limit),
                    items = page.map((date) => {
                        const item = projectedItem(
                            recurrence,
                            date,
                            byDate.get(date) ?? null,
                        );
                        return {
                            ...taskView(item),
                            conditions: taskAttention(item, reference),
                        };
                    });
                return {
                    ...reference,
                    window: { from, to },
                    items,
                    nextCursor:
                        dates.length > q.limit
                            ? encodeCursor(scope, {
                                  from,
                                  to,
                                  after: page.at(-1)!,
                              })
                            : null,
                };
            },
            (page, context) => ({
                ...page,
                items: page.items.map((item) => ({
                    ...item,
                    ...taskView(item, context.status === 'ACTIVE'),
                })),
            }),
        );
    }
    history(
        actor: string,
        space: string,
        id: string,
        q: { limit: number; cursor?: string },
        date?: string,
    ) {
        const scope = cursorScope({
                actor,
                space,
                id,
                date: date ?? null,
                type: 'RECURRENCE_HISTORY',
            }),
            key = decodeCursor(scope, q.cursor);
        if (key !== null && (!Number.isSafeInteger(key) || Number(key) < 1))
            throw new RoutineError('VALIDATION_ERROR', 'cursor');
        return this.queries.read(actor, space, async () => {
            const recurrence = await this.store.find(space, id);
            let aggregateId = id;
            if (date) {
                const persisted = await this.store.occurrence(space, id, date);
                if (!persisted) {
                    if (!eligibleOccurrence(recurrence, date))
                        throw new RoutineError('OCCURRENCE_NOT_FOUND');
                    return { items: [], nextCursor: null };
                }
                aggregateId = persisted.id;
            }
            const rows = await this.historyStore.history(
                space,
                aggregateId,
                Number(key ?? 0),
                q.limit + 1,
            );
            return {
                items: rows.slice(0, q.limit),
                nextCursor:
                    rows.length > q.limit
                        ? encodeCursor(scope, rows[q.limit - 1].sequence)
                        : null,
            };
        });
    }
}
