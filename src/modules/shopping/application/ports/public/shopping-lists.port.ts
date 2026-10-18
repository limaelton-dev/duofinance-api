import type { PersonId } from '../../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../../spaces/domain/space/space-id.js';

export const SHOPPING_LISTS_PORT = Symbol('SHOPPING_LISTS_PORT');
export interface ShoppingListReference {
    id: string;
    name: string | null;
    status: 'ACTIVE' | 'ARCHIVED';
    summary: {
        activeItemCount: number;
        actionableItemCount: number;
        isComplete: boolean;
    };
}
export interface ShoppingListsPort {
    lockActive(actor: PersonId, space: SpaceId, id: string): Promise<void>;
    reference(
        actor: PersonId,
        space: SpaceId,
        id: string,
    ): Promise<ShoppingListReference>;
}
