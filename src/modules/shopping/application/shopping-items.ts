import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { requireActiveList } from '../domain/shopping-list.js';
import { Quantity } from '../domain/quantity.js';
import {
    changeItemNeed,
    itemProgress,
    validateItem,
    removeItem,
    type ShoppingItem,
} from '../domain/shopping-item.js';
import { ShoppingError } from '../domain/shopping-error.js';
import { ShoppingCommands, shoppingAuthor } from './shopping-commands.js';
import { SHOPPING_STORE, type ShoppingStore } from './shopping-store.js';

@Injectable()
export class ShoppingItems {
    constructor(
        private readonly commands: ShoppingCommands,
        @Inject(SHOPPING_STORE) private readonly store: ShoppingStore,
    ) {}
    add(
        actor: string,
        space: string,
        listId: string,
        key: string,
        input: {
            expectedVersion: number;
            description: string;
            desiredQuantity: string;
            unit?: string | null;
        },
    ) {
        const normalized = {
            expectedVersion: input.expectedVersion,
            description: input.description.trim(),
            desiredQuantity: Quantity.from(
                input.desiredQuantity,
                'desiredQuantity',
            ).toString(),
            unit: input.unit?.trim() ?? null,
        };
        return this.commands.execute(
            actor,
            space,
            key,
            'ADD_SHOPPING_ITEM',
            listId,
            normalized,
            async (context, now) => {
                const before = await this.store.find(space, listId);
                requireActiveList(before);
                if (before.version !== input.expectedVersion)
                    throw new ShoppingError('CONCURRENT_MODIFICATION');
                const item: ShoppingItem = {
                    id: randomUUID(),
                    listId,
                    description: normalized.description,
                    desiredQuantity: normalized.desiredQuantity,
                    unit: normalized.unit,
                    creator: shoppingAuthor(context, actor),
                    createdAt: now,
                    removedAt: null,
                };
                validateItem(item);
                const after = { ...before, version: before.version + 1 };
                await this.store.update(before, after);
                await this.store.insertItem(space, item);
                await this.store.event({
                    id: randomUUID(),
                    spaceId: space,
                    aggregateId: listId,
                    sequence: after.version,
                    type: 'ITEM_ADDED',
                    actor: item.creator,
                    registeredAt: new Date(now),
                    data: { item },
                });
                return {
                    id: listId,
                    version: after.version,
                    item: itemProgress(item),
                };
            },
        );
    }
    changeNeed(
        actor: string,
        space: string,
        listId: string,
        itemId: string,
        key: string,
        input: {
            expectedVersion: number;
            desiredQuantity?: string;
            unit?: string | null;
        },
    ) {
        const normalized = {
            expectedVersion: input.expectedVersion,
            ...(input.desiredQuantity !== undefined
                ? {
                      desiredQuantity: Quantity.from(
                          input.desiredQuantity,
                          'desiredQuantity',
                      ).toString(),
                  }
                : {}),
            ...(input.unit !== undefined
                ? { unit: input.unit?.trim() ?? null }
                : {}),
        };
        return this.commands.execute(
            actor,
            space,
            key,
            'CHANGE_SHOPPING_ITEM_NEED',
            `${listId}/${itemId}`,
            normalized,
            async (context, now) => {
                const before = await this.store.find(space, listId);
                requireActiveList(before);
                if (before.version !== input.expectedVersion)
                    throw new ShoppingError('CONCURRENT_MODIFICATION');
                const oldItem = await this.store.findItem(
                    space,
                    listId,
                    itemId,
                );
                const item = changeItemNeed(
                    oldItem,
                    normalized,
                    oldItem.purchasedQuantity,
                );
                const after = { ...before, version: before.version + 1 };
                await this.store.update(before, after);
                await this.store.updateItem(space, item);
                await this.store.event({
                    id: randomUUID(),
                    spaceId: space,
                    aggregateId: listId,
                    sequence: after.version,
                    type: 'ITEM_NEED_CHANGED',
                    actor: shoppingAuthor(context, actor),
                    registeredAt: new Date(now),
                    data: {
                        itemId,
                        before: {
                            desiredQuantity: oldItem.desiredQuantity,
                            unit: oldItem.unit,
                        },
                        after: {
                            desiredQuantity: item.desiredQuantity,
                            unit: item.unit,
                        },
                    },
                });
                return {
                    id: listId,
                    version: after.version,
                    item: itemProgress(item, oldItem.purchasedQuantity),
                };
            },
        );
    }
    remove(
        actor: string,
        space: string,
        listId: string,
        itemId: string,
        key: string,
        input: { expectedVersion: number },
    ) {
        return this.commands.execute(
            actor,
            space,
            key,
            'REMOVE_SHOPPING_ITEM',
            `${listId}/${itemId}`,
            input,
            async (context, now) => {
                const before = await this.store.find(space, listId);
                requireActiveList(before);
                if (before.version !== input.expectedVersion)
                    throw new ShoppingError('CONCURRENT_MODIFICATION');
                const oldItem = await this.store.findItem(
                    space,
                    listId,
                    itemId,
                );
                const item = removeItem(oldItem, now);
                const after = { ...before, version: before.version + 1 };
                await this.store.update(before, after);
                await this.store.updateItem(space, item);
                await this.store.event({
                    id: randomUUID(),
                    spaceId: space,
                    aggregateId: listId,
                    sequence: after.version,
                    type: 'ITEM_REMOVED',
                    actor: shoppingAuthor(context, actor),
                    registeredAt: new Date(now),
                    data: { itemId, removedAt: now },
                });
                return {
                    id: listId,
                    version: after.version,
                    item: itemProgress(item, oldItem.purchasedQuantity),
                };
            },
        );
    }
}
