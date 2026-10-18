import { Inject, Injectable } from '@nestjs/common';
import {
    SPACE_PARTICIPANTS_PORT,
    type SpaceParticipantsPort,
    type SpaceParticipantsContext,
} from '../../spaces/application/ports/public/space-participants.port.js';
import { PersonId } from '../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../spaces/domain/space/space-id.js';
import { ROUTINE_STORE, type RoutineStore } from './routine-store.js';
import { cursorScope, decodeCursor, encodeCursor } from './routine-cursor.js';
import { RoutineError } from '../domain/routine-error.js';
import type { Task } from '../domain/task.js';
export function taskView(task: Task, canWrite = true) {
    return {
        ...task,
        kind: 'ONE_OFF' as const,
        allowedActions: canWrite && task.status === 'PENDING' ? ['ASSIGN'] : [],
    };
}
@Injectable()
export class TaskQueries {
    constructor(
        @Inject(SPACE_PARTICIPANTS_PORT)
        private readonly participants: SpaceParticipantsPort,
        @Inject(ROUTINE_STORE) private readonly store: RoutineStore,
    ) {}
    async context(actor: string, space: string) {
        return this.participants.read(
            PersonId.from(actor),
            SpaceId.from(space),
        );
    }
    async read<T>(
        actor: string,
        space: string,
        work: () => Promise<T>,
        present: (result: T, context: SpaceParticipantsContext) => T = (
            result,
        ) => result,
    ) {
        await this.context(actor, space);
        const result = await this.store.snapshot(work);
        const confirmed = await this.context(actor, space);
        return present(result, confirmed);
    }
    detail(actor: string, space: string, id: string) {
        return this.read(
            actor,
            space,
            async () => taskView(await this.store.find(space, id)),
            (task, context) => taskView(task, context.status === 'ACTIVE'),
        );
    }
    list(actor: string, space: string, q: { limit: number; cursor?: string }) {
        const scope = cursorScope({ actor, space, type: 'TASKS' });
        const after = decodeCursor(scope, q.cursor);
        if (
            after !== null &&
            (typeof after !== 'string' || !/^[0-9a-f-]{36}$/.test(after))
        )
            throw new RoutineError('VALIDATION_ERROR', 'cursor');
        return this.read(
            actor,
            space,
            async () => {
                const rows = await this.store.page(
                    space,
                    after as string | null,
                    q.limit + 1,
                );
                const items = rows
                    .slice(0, q.limit)
                    .map((task) => taskView(task));
                return {
                    items,
                    nextCursor:
                        rows.length > q.limit
                            ? encodeCursor(scope, items.at(-1)!.id)
                            : null,
                };
            },
            (page, context) => ({
                ...page,
                items: page.items.map((task) =>
                    taskView(task, context.status === 'ACTIVE'),
                ),
            }),
        );
    }
    history(
        actor: string,
        space: string,
        id: string,
        q: { limit: number; cursor?: string },
    ) {
        const scope = cursorScope({ actor, space, id, type: 'HISTORY' });
        const key = decodeCursor(scope, q.cursor);
        if (key !== null && (!Number.isSafeInteger(key) || Number(key) < 1))
            throw new RoutineError('VALIDATION_ERROR', 'cursor');
        return this.read(actor, space, async () => {
            await this.store.find(space, id);
            const rows = await this.store.history(
                space,
                id,
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
