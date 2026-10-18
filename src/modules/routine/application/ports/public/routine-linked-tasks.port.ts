import type { PersonId } from '../../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../../spaces/domain/space/space-id.js';

export const ROUTINE_LINKED_TASKS_PORT = Symbol('ROUTINE_LINKED_TASKS_PORT');
export interface LinkedTaskReference {
    id: string;
    description: string;
    status: 'PENDING' | 'COMPLETED' | 'CANCELLED';
    createdAt: string;
    shoppingListId: string;
}
export interface RoutineLinkedTasksPort {
    read(
        actor: PersonId,
        space: SpaceId,
        listId: string,
        query: { limit: number; cursor?: string },
    ): Promise<{
        items: LinkedTaskReference[];
        totalCount: number;
        nextCursor: string | null;
    }>;
}
