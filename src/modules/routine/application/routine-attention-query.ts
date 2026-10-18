import { Injectable } from '@nestjs/common';
import type { PersonId } from '../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../spaces/domain/space/space-id.js';
import type { RoutineAttentionQueryPort } from './ports/public/routine-attention-query.port.js';
import { TaskAttentionQuery } from './task-attention-query.js';
@Injectable()
export class RoutineAttentionQuery implements RoutineAttentionQueryPort {
    constructor(private readonly query: TaskAttentionQuery) {}
    async read(actor: PersonId, space: SpaceId, instant: Date) {
        const page = await this.query.list(
            actor.value,
            space.value,
            {
                limit: 4,
                status: 'PENDING',
                scope: 'ALL',
                attention: 'ATTENTION',
            },
            instant,
        );
        return {
            items: page.items,
            counts: page.counts,
            hasMore: page.nextCursor !== null,
            referenceDate: page.referenceDate,
            referenceInstant: page.referenceInstant,
        };
    }
}
