import { Inject, Injectable } from '@nestjs/common';
import type { PersonId } from '../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../spaces/domain/space/space-id.js';
import {
    ROUTINE_ATTENTION_QUERY,
    RoutineAttentionUnavailableError,
    type RoutineAttentionQueryPort,
} from './ports/public/routine-attention-query.port.js';
import type {
    RoutineTodayQueryPort,
    RoutineTodayRead,
} from './ports/public/routine-today-query.port.js';
import { TaskAttentionQuery, attentionView } from './task-attention-query.js';
import { TaskQueries } from './task-queries.js';
import { routineReference } from './routine-clock.js';

@Injectable()
export class RoutineTodayQuery implements RoutineTodayQueryPort {
    constructor(
        @Inject(ROUTINE_ATTENTION_QUERY)
        private readonly legacy: RoutineAttentionQueryPort,
        private readonly query: TaskAttentionQuery,
        private readonly queries: TaskQueries,
    ) {}
    read(actor: PersonId, space: SpaceId, instant: Date) {
        const reference = routineReference(instant);
        const load = (attention?: 'NEEDS_ATTENTION' | 'TODAY') =>
            this.query.list(
                actor.value,
                space.value,
                {
                    status: 'PENDING',
                    scope: 'ALL',
                    limit: 4,
                    ...(attention ? { attention } : {}),
                },
                instant,
            );
        return this.queries.read(
            actor.value,
            space.value,
            async (): Promise<RoutineTodayRead> => {
                const legacy = await this.legacy.read(actor, space, instant);
                const attention = await load('NEEDS_ATTENTION'),
                    today = await load('TODAY'),
                    tasks = await load();
                const preview = (page: typeof tasks) => ({
                    items: page.items,
                    totalCount: page.counts.totalCount,
                });
                return {
                    spaceId: space.value,
                    actorMemberId: null,
                    referenceDate: reference.referenceDate,
                    referenceInstant: reference.referenceInstant,
                    legacy,
                    attention: preview(attention),
                    today: preview(today),
                    tasks: preview(tasks),
                };
            },
            (result, context) => {
                const present = (items: typeof result.tasks.items) =>
                    items.map((item) =>
                        attentionView(
                            item,
                            reference,
                            context.status === 'ACTIVE',
                        ),
                    );
                return {
                    ...result,
                    actorMemberId: context.actorMemberId,
                    legacy: {
                        ...result.legacy,
                        items: present(result.legacy.items),
                    },
                    attention: {
                        ...result.attention,
                        items: present(result.attention.items),
                    },
                    today: {
                        ...result.today,
                        items: present(result.today.items),
                    },
                    tasks: {
                        ...result.tasks,
                        items: present(result.tasks.items),
                    },
                };
            },
            new RoutineAttentionUnavailableError(),
        );
    }
}
