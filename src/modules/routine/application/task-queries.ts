import { Inject, Injectable } from '@nestjs/common';
import {
    SPACE_PARTICIPANTS_PORT,
    type SpaceParticipantsPort,
    type SpaceParticipantsContext,
} from '../../spaces/application/ports/public/space-participants.port.js';
import { PersonId } from '../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../spaces/domain/space/space-id.js';
import { SpacesDomainError } from '../../spaces/domain/errors/spaces-domain.error.js';
import { ROUTINE_STORE, type RoutineStore } from './routine-store.js';
import { cursorScope, decodeCursor, encodeCursor } from './routine-cursor.js';
import { RoutineError } from '../domain/routine-error.js';
import type { TaskItem } from '../domain/task-item.js';
import {
    ROUTINE_CLOCK,
    type RoutineClock,
    routineReference,
} from './routine-clock.js';
import { taskAttention } from '../domain/task-attention.js';
import { isPostgresqlUnavailable } from '../../../shared/technical/database/postgresql-unavailable.js';
import {
    SHOPPING_LISTS_PORT,
    type ShoppingListsPort,
} from '../../shopping/application/ports/public/shopping-lists.port.js';
export function taskView(task: TaskItem, canWrite = true) {
    const view = {
        ...task,
        kind: task.kind ?? ('ONE_OFF' as const),
        allowedActions: !canWrite
            ? []
            : task.status === 'PENDING'
              ? task.kind === 'OCCURRENCE'
                  ? ['COMPLETE', 'SKIP']
                  : ['ASSIGN', 'COMPLETE', 'DEADLINE', 'URGENCY', 'CANCEL']
              : task.status === 'COMPLETED'
                ? ['REOPEN']
                : [],
    };
    if (canWrite && task.kind !== 'OCCURRENCE')
        view.allowedActions.push(
            'LINK_SHOPPING_LIST',
            ...(task.shoppingListId ? ['UNLINK_SHOPPING_LIST'] : []),
        );
    return view;
}
@Injectable()
export class TaskQueries {
    constructor(
        @Inject(SPACE_PARTICIPANTS_PORT)
        private readonly participants: SpaceParticipantsPort,
        @Inject(ROUTINE_STORE) private readonly store: RoutineStore,
        @Inject(ROUTINE_CLOCK) private readonly clock: RoutineClock,
        @Inject(SHOPPING_LISTS_PORT)
        private readonly shopping: ShoppingListsPort,
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
        unavailableError?: Error,
    ) {
        const authorized = await this.context(actor, space);
        let outcome: { ok: true; result: T } | { ok: false; error: unknown };
        try {
            outcome = { ok: true, result: await this.store.snapshot(work) };
        } catch (error) {
            outcome = {
                ok: false,
                error:
                    unavailableError && isPostgresqlUnavailable(error)
                        ? unavailableError
                        : error,
            };
        }
        const confirmed = await this.context(actor, space);
        if (
            confirmed.actorMemberId !== authorized.actorMemberId ||
            confirmed.type !== authorized.type
        )
            throw new SpacesDomainError('SPACE_NOT_FOUND');
        if (!outcome.ok) throw outcome.error;
        return present(outcome.result, confirmed);
    }
    detail(actor: string, space: string, id: string) {
        const reference = routineReference(this.clock.now());
        return this.read(
            actor,
            space,
            async () => {
                const task = await this.store.find(space, id);
                return {
                    ...taskView(task),
                    shoppingList: task.shoppingListId
                        ? await this.shopping.reference(
                              PersonId.from(actor),
                              SpaceId.from(space),
                              task.shoppingListId,
                          )
                        : null,
                    ...reference,
                    conditions: taskAttention(task, reference),
                };
            },
            (task, context) => ({
                ...task,
                ...taskView(task, context.status === 'ACTIVE'),
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
