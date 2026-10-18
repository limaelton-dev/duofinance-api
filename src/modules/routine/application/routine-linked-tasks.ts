import { Inject, Injectable } from '@nestjs/common';
import type { PersonId } from '../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../spaces/domain/space/space-id.js';
import { RoutineError } from '../domain/routine-error.js';
import { ROUTINE_STORE, type RoutineStore } from './routine-store.js';
import { TaskQueries } from './task-queries.js';
import {
    cursorScope,
    decodeCursor,
    encodeCursor,
    isRoutineId,
} from './routine-cursor.js';
import type { RoutineLinkedTasksPort } from './ports/public/routine-linked-tasks.port.js';

@Injectable()
export class RoutineLinkedTasks implements RoutineLinkedTasksPort {
    constructor(
        @Inject(ROUTINE_STORE) private readonly store: RoutineStore,
        private readonly queries: TaskQueries,
    ) {}
    read(
        actor: PersonId,
        space: SpaceId,
        listId: string,
        q: { limit: number; cursor?: string },
    ) {
        const scope = cursorScope({
            actor: actor.value,
            space: space.value,
            listId,
            order: 'LINKED_CREATED_ASC_ID_ASC',
        });
        const key = decodeCursor(scope, q.cursor);
        let after: { id: string; createdAt: string } | null = null;
        if (key !== null) {
            if (
                typeof key !== 'object' ||
                !('id' in key) ||
                !isRoutineId(key.id) ||
                !('createdAt' in key) ||
                typeof key.createdAt !== 'string' ||
                !Number.isFinite(new Date(key.createdAt).getTime()) ||
                new Date(key.createdAt).toISOString() !== key.createdAt
            )
                throw new RoutineError('VALIDATION_ERROR', 'cursor');
            after = { id: key.id, createdAt: key.createdAt };
        }
        return this.queries.read(actor.value, space.value, async () => {
            const page = await this.store.linkedTasks(
                space.value,
                listId,
                after,
                q.limit + 1,
            );
            return {
                items: page.items.slice(0, q.limit),
                totalCount: page.totalCount,
                nextCursor:
                    page.items.length > q.limit
                        ? encodeCursor(scope, {
                              createdAt: page.items[q.limit - 1].createdAt,
                              id: page.items[q.limit - 1].id,
                          })
                        : null,
            };
        });
    }
}
