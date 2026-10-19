import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { requireActiveList } from '../domain/shopping-list.js';
import { Quantity } from '../domain/quantity.js';
import { itemProgress, requireActiveItem } from '../domain/shopping-item.js';
import {
    purchasedAfter,
    purchaseView,
    type PurchaseRecord,
} from '../domain/purchase-record.js';
import { ShoppingError } from '../domain/shopping-error.js';
import { ShoppingCommands, shoppingAuthor } from './shopping-commands.js';
import { SHOPPING_STORE, type ShoppingStore } from './shopping-store.js';

@Injectable()
export class ShoppingPurchases {
    constructor(
        private readonly commands: ShoppingCommands,
        @Inject(SHOPPING_STORE) private readonly store: ShoppingStore,
    ) {}
    record(
        actor: string,
        space: string,
        listId: string,
        itemId: string,
        key: string,
        input: { expectedVersion: number; quantity: string },
    ) {
        const normalized = {
            expectedVersion: input.expectedVersion,
            quantity: Quantity.from(input.quantity).toString(),
        };
        return this.commands.execute(
            actor,
            space,
            key,
            'RECORD_SHOPPING_PURCHASE',
            `${listId}/${itemId}`,
            normalized,
            async (context, now) => {
                const before = await this.store.find(space, listId);
                requireActiveList(before);
                if (before.version !== input.expectedVersion)
                    throw new ShoppingError('CONCURRENT_MODIFICATION');
                const item = await this.store.findItem(space, listId, itemId);
                requireActiveItem(item);
                const purchased = purchasedAfter(
                    item.purchasedQuantity,
                    normalized.quantity,
                );
                const purchase: PurchaseRecord = {
                    id: randomUUID(),
                    listId,
                    itemId,
                    quantity: normalized.quantity,
                    unit: item.unit,
                    registeredBy: shoppingAuthor(context, actor),
                    registeredAt: now,
                };
                const after = { ...before, version: before.version + 1 };
                await this.store.update(before, after);
                await this.store.insertPurchase(space, purchase);
                await this.store.event({
                    id: randomUUID(),
                    spaceId: space,
                    aggregateId: listId,
                    sequence: after.version,
                    type: 'PURCHASE_RECORDED',
                    actor: purchase.registeredBy,
                    registeredAt: new Date(now),
                    data: { itemId, purchase },
                });
                return {
                    id: listId,
                    version: after.version,
                    item: itemProgress(item, purchased),
                    purchase: purchaseView(purchase),
                };
            },
        );
    }
}
