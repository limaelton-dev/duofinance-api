import type { PersonId } from '../../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../../spaces/domain/space/space-id.js';
import type { TaskAttentionQuery } from '../../task-attention-query.js';
export const ROUTINE_ATTENTION_QUERY = Symbol('ROUTINE_ATTENTION_QUERY');
export class RoutineAttentionUnavailableError extends Error {}
export interface RoutineAttentionQueryPort {
    read(
        actor: PersonId,
        space: SpaceId,
        instant: Date,
    ): Promise<{
        items: Awaited<ReturnType<TaskAttentionQuery['list']>>['items'];
        counts: Awaited<ReturnType<TaskAttentionQuery['list']>>['counts'];
        hasMore: boolean;
        referenceDate: string;
        referenceInstant: string;
    }>;
}
