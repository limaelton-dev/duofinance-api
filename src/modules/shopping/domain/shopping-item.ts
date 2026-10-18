import type { ShoppingAuthor } from './shopping-list.js';
import { ShoppingError } from './shopping-error.js';
import { Quantity } from './quantity.js';

export interface ShoppingItem {
    id: string;
    listId: string;
    description: string;
    desiredQuantity: string;
    unit: string | null;
    creator: ShoppingAuthor;
    createdAt: string;
}
export interface ShoppingItemState extends ShoppingItem {
    purchasedQuantity: string;
}
export type ShoppingItemFilter =
    'ACTIVE' | 'PENDING' | 'PURCHASED' | 'REMOVED' | 'ALL';
export interface ShoppingSummary {
    activeItemCount: number;
    pendingItemCount: number;
    partiallyPurchasedItemCount: number;
    purchasedItemCount: number;
    actionableItemCount: number;
    isComplete: boolean;
    canSuggestArchival: boolean;
}
export function shoppingSummary(
    activeItemCount = 0,
    pendingItemCount = activeItemCount,
    partiallyPurchasedItemCount = 0,
    purchasedItemCount = 0,
): ShoppingSummary {
    return {
        activeItemCount,
        pendingItemCount,
        partiallyPurchasedItemCount,
        purchasedItemCount,
        actionableItemCount: pendingItemCount + partiallyPurchasedItemCount,
        isComplete: pendingItemCount + partiallyPurchasedItemCount === 0,
        canSuggestArchival:
            activeItemCount > 0 &&
            pendingItemCount + partiallyPurchasedItemCount === 0,
    };
}
export function validateUnit(unit: string | null) {
    if (
        unit !== null &&
        (typeof unit !== 'string' ||
            !unit.length ||
            unit.length > 30 ||
            unit !== unit.trim())
    )
        throw new ShoppingError('VALIDATION_ERROR', 'unit');
}
export function validateItem(item: ShoppingItem) {
    if (
        !item.description ||
        item.description.length > 500 ||
        item.description !== item.description.trim()
    )
        throw new ShoppingError('VALIDATION_ERROR', 'description');
    Quantity.from(item.desiredQuantity, 'desiredQuantity');
    validateUnit(item.unit);
}
export function itemProgress(item: ShoppingItem, purchasedQuantity = '0') {
    const desired = Quantity.from(item.desiredQuantity, 'desiredQuantity');
    const purchased = Quantity.from(
        purchasedQuantity,
        'purchasedQuantity',
        true,
    );
    return {
        ...item,
        purchasedQuantity: purchased.toString(),
        remainingQuantity: desired.subtractFloor(purchased).toString(),
        status:
            purchased.scaledUnits === 0
                ? ('PENDING' as const)
                : purchased.scaledUnits < desired.scaledUnits
                  ? ('PARTIALLY_PURCHASED' as const)
                  : ('PURCHASED' as const),
    };
}
export function changeItemNeed(
    item: ShoppingItem,
    input: { desiredQuantity?: string; unit?: string | null },
    purchasedQuantity = '0',
): ShoppingItem {
    if (input.desiredQuantity === undefined && input.unit === undefined)
        throw new ShoppingError('VALIDATION_ERROR', 'body');
    const desired = Quantity.from(
        input.desiredQuantity ?? item.desiredQuantity,
        'desiredQuantity',
    );
    const purchased = Quantity.from(
        purchasedQuantity,
        'purchasedQuantity',
        true,
    );
    if (
        desired.scaledUnits <
            Quantity.from(item.desiredQuantity, 'desiredQuantity')
                .scaledUnits &&
        desired.scaledUnits < purchased.scaledUnits
    )
        throw new ShoppingError(
            'DESIRED_QUANTITY_BELOW_PURCHASED',
            'desiredQuantity',
        );
    const changed = {
        ...item,
        desiredQuantity: desired.toString(),
        unit: input.unit !== undefined ? input.unit : item.unit,
    };
    validateItem(changed);
    return changed;
}
