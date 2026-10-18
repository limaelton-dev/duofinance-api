import type { ShoppingAuthor, ShoppingList } from '../domain/shopping-list.js';
import type {
    ShoppingItem,
    ShoppingItemFilter,
    ShoppingSummary,
} from '../domain/shopping-item.js';

export const SHOPPING_STORE = Symbol('SHOPPING_STORE');
export interface ShoppingHistoryEvent {
    id: string;
    spaceId: string;
    aggregateId: string;
    sequence: number;
    type: string;
    actor: ShoppingAuthor;
    registeredAt: Date;
    data: object;
}
export interface ShoppingListKey {
    createdAt: string;
    id: string;
}
export interface ShoppingStore {
    find(space: string, id: string): Promise<ShoppingList>;
    insert(list: ShoppingList): Promise<void>;
    update(before: ShoppingList, after: ShoppingList): Promise<void>;
    findItem(space: string, list: string, id: string): Promise<ShoppingItem>;
    insertItem(space: string, item: ShoppingItem): Promise<void>;
    updateItem(space: string, item: ShoppingItem): Promise<void>;
    summary(
        space: string,
        lists: string[],
    ): Promise<Map<string, ShoppingSummary>>;
    items(
        space: string,
        list: string,
        status: ShoppingItemFilter,
        after: ShoppingListKey | null,
        limit: number,
    ): Promise<{ items: ShoppingItem[]; totalCount: number }>;
    list(
        space: string,
        status: 'ACTIVE' | 'ARCHIVED' | 'ALL',
        after: ShoppingListKey | null,
        limit: number,
    ): Promise<{
        items: ShoppingList[];
        totalCount: number;
        summaries: Map<string, ShoppingSummary>;
    }>;
    event(event: ShoppingHistoryEvent): Promise<void>;
    history(
        space: string,
        id: string,
        after: number,
        limit: number,
    ): Promise<ShoppingHistoryEvent[]>;
    lockReceipt(actor: string, operation: string, key: string): Promise<void>;
    receipt(
        actor: string,
        operation: string,
        key: string,
    ): Promise<{ digest: string; result: object } | null>;
    finish(input: {
        actorId: string;
        spaceId: string;
        operation: string;
        key: string;
        digest: string;
        result: object;
        aggregateId: string;
        registeredAt: Date;
    }): Promise<void>;
    snapshot<T>(work: () => Promise<T>): Promise<T>;
}
