import type { ShoppingAuthor } from './shopping-list.js';
import { Quantity } from './quantity.js';
import { ShoppingError } from './shopping-error.js';

export interface PurchaseCorrection {
    id: string;
    listId: string;
    itemId: string;
    purchaseId: string;
    previousQuantity: string;
    quantity: string;
    unit: string | null;
    correctedBy: ShoppingAuthor;
    correctedAt: string;
    sequence: number;
}
export function correctedPurchased(
    current: string,
    previous: string,
    next: string,
): string {
    const total = Quantity.from(current, 'purchasedQuantity', true);
    const old = Quantity.from(previous, 'quantity', true);
    if (old.scaledUnits > total.scaledUnits)
        throw new ShoppingError('VALIDATION_ERROR', 'quantity');
    return total
        .subtractFloor(old)
        .add(Quantity.from(next, 'quantity', true))
        .toString();
}
