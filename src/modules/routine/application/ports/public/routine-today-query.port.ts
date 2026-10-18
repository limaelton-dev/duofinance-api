import type { PersonId } from '../../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../../spaces/domain/space/space-id.js';
import type { RoutineAttentionQueryPort } from './routine-attention-query.port.js';
import type { attentionView } from '../../task-attention-query.js';

export const ROUTINE_TODAY_QUERY_PORT = Symbol('ROUTINE_TODAY_QUERY_PORT');
export interface RoutinePreview {
    items: ReturnType<typeof attentionView>[];
    totalCount: number;
}
export interface RoutineTodayRead {
    spaceId: string;
    actorMemberId: string | null;
    referenceDate: string;
    referenceInstant: string;
    legacy: Awaited<ReturnType<RoutineAttentionQueryPort['read']>>;
    attention: RoutinePreview;
    today: RoutinePreview;
    tasks: RoutinePreview;
}
export interface RoutineTodayQueryPort {
    read(
        actor: PersonId,
        space: SpaceId,
        instant: Date,
    ): Promise<RoutineTodayRead>;
}
