import type { ShoppingAuthor } from './shopping-list.js';
import { Quantity } from './quantity.js';

export interface PurchaseRecord {
    id: string;
    listId: string;
    itemId: string;
    quantity: string;
    unit: string | null;
    registeredBy: ShoppingAuthor;
    registeredAt: string;
}
export interface PurchaseRecordState extends PurchaseRecord {
    effectiveQuantity: string;
}
export function purchaseView(
    purchase: PurchaseRecord & { effectiveQuantity?: string },
) {
    return {
        ...purchase,
        effectiveQuantity: purchase.effectiveQuantity ?? purchase.quantity,
    };
}
export function purchasedAfter(current: string, quantity: string): string {
    return Quantity.from(current, 'purchasedQuantity', true)
        .add(Quantity.from(quantity), 'quantity')
        .toString();
}
