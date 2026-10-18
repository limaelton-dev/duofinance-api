import type { ShoppingAuthor, ShoppingList } from '../domain/shopping-list.js';
import type {
    ShoppingItem,
    ShoppingItemState,
    ShoppingItemFilter,
    ShoppingSummary,
} from '../domain/shopping-item.js';
import type {
    PurchaseRecord,
    PurchaseRecordState,
} from '../domain/purchase-record.js';
import type { PurchaseCorrection } from '../domain/purchase-correction.js';

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
export interface ShoppingItemKey extends ShoppingListKey {
    group: number;
}
export interface ShoppingStore {
    find(space: string, id: string): Promise<ShoppingList>;
    lockList(space: string, id: string): Promise<ShoppingList>;
    insert(list: ShoppingList): Promise<void>;
    update(before: ShoppingList, after: ShoppingList): Promise<void>;
    findItem(
        space: string,
        list: string,
        id: string,
    ): Promise<ShoppingItemState>;
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
        after: ShoppingItemKey | null,
        limit: number,
    ): Promise<{ items: ShoppingItemState[]; totalCount: number }>;
    insertPurchase(space: string, purchase: PurchaseRecord): Promise<void>;
    findPurchase(
        space: string,
        list: string,
        item: string,
        id: string,
    ): Promise<PurchaseRecordState>;
    insertCorrection(
        space: string,
        correction: PurchaseCorrection,
    ): Promise<void>;
    corrections(
        space: string,
        list: string,
        item: string,
        purchase: string,
        after: number,
        limit: number,
    ): Promise<{ items: PurchaseCorrection[]; totalCount: number }>;
    purchases(
        space: string,
        list: string,
        item: string,
        after: ShoppingListKey | null,
        limit: number,
    ): Promise<{ items: PurchaseRecordState[]; totalCount: number }>;
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
