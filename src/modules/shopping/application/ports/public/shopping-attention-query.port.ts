import type { PersonId } from '../../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../../spaces/domain/space/space-id.js';

export const SHOPPING_ATTENTION_QUERY_PORT = Symbol(
    'SHOPPING_ATTENTION_QUERY_PORT',
);
export class ShoppingAttentionUnavailableError extends Error {}
export interface ShoppingAttentionItem {
    id: string;
    description: string;
    unit: string | null;
    desiredQuantity: string;
    purchasedQuantity: string;
    remainingQuantity: string;
    status: 'PENDING' | 'PARTIALLY_PURCHASED';
}
export interface ShoppingAttentionList {
    id: string;
    name: string | null;
    status: 'ACTIVE';
    summary: {
        activeItemCount: number;
        actionableItemCount: number;
        isComplete: boolean;
    };
    pendingItems: {
        items: ShoppingAttentionItem[];
        totalCount: number;
        hasMore: boolean;
    };
}
export interface ShoppingAttentionRead {
    spaceId: string;
    actorMemberId: string | null;
    referenceDate: string;
    referenceInstant: string;
    items: ShoppingAttentionList[];
    totalCount: number;
    activeListCount: number;
}
export interface ShoppingAttentionQueryPort {
    read(
        actor: PersonId,
        space: SpaceId,
        instant: Date,
    ): Promise<ShoppingAttentionRead>;
}
