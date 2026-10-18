import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { requireActiveList } from '../domain/shopping-list.js';
import { Quantity } from '../domain/quantity.js';
import { itemProgress } from '../domain/shopping-item.js';
import { purchaseView } from '../domain/purchase-record.js';
import {
    correctedPurchased,
    type PurchaseCorrection,
} from '../domain/purchase-correction.js';
import { ShoppingError } from '../domain/shopping-error.js';
import { ShoppingCommands, shoppingAuthor } from './shopping-commands.js';
import { SHOPPING_STORE, type ShoppingStore } from './shopping-store.js';

@Injectable()
export class ShoppingCorrections {
    constructor(
        private readonly commands: ShoppingCommands,
        @Inject(SHOPPING_STORE) private readonly store: ShoppingStore,
    ) {}
    correct(
        actor: string,
        space: string,
        listId: string,
        itemId: string,
        purchaseId: string,
        key: string,
        input: { expectedVersion: number; quantity: string },
    ) {
        const normalized = {
            expectedVersion: input.expectedVersion,
            quantity: Quantity.from(
                input.quantity,
                'quantity',
                true,
            ).toString(),
        };
        return this.commands.execute(
            actor,
            space,
            key,
            'CORRECT_SHOPPING_PURCHASE',
            `${listId}/${itemId}/${purchaseId}`,
            normalized,
            async (context, now) => {
                const before = await this.store.find(space, listId);
                requireActiveList(before);
                if (before.version !== input.expectedVersion)
                    throw new ShoppingError('CONCURRENT_MODIFICATION');
                const item = await this.store.findItem(space, listId, itemId);
                const purchase = await this.store.findPurchase(
                    space,
                    listId,
                    itemId,
                    purchaseId,
                );
                const purchased = correctedPurchased(
                    item.purchasedQuantity,
                    purchase.effectiveQuantity,
                    normalized.quantity,
                );
                const after = { ...before, version: before.version + 1 };
                const correction: PurchaseCorrection = {
                    id: randomUUID(),
                    listId,
                    itemId,
                    purchaseId,
                    previousQuantity: purchase.effectiveQuantity,
                    quantity: normalized.quantity,
                    unit: purchase.unit,
                    correctedBy: shoppingAuthor(context, actor),
                    correctedAt: now,
                    sequence: after.version,
                };
                await this.store.update(before, after);
                await this.store.insertCorrection(space, correction);
                await this.store.event({
                    id: randomUUID(),
                    spaceId: space,
                    aggregateId: listId,
                    sequence: after.version,
                    type: 'PURCHASE_CORRECTED',
                    actor: correction.correctedBy,
                    registeredAt: new Date(now),
                    data: { itemId, purchaseId, correction },
                });
                return {
                    id: listId,
                    version: after.version,
                    item: itemProgress(item, purchased),
                    purchase: purchaseView({
                        ...purchase,
                        effectiveQuantity: correction.quantity,
                    }),
                    correction,
                };
            },
        );
    }
}
