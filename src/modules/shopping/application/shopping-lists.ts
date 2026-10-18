import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
    renameList,
    archiveList,
    validateListName,
    type ShoppingList,
} from '../domain/shopping-list.js';
import { ShoppingError } from '../domain/shopping-error.js';
import { ShoppingCommands, shoppingAuthor } from './shopping-commands.js';
import { SHOPPING_STORE, type ShoppingStore } from './shopping-store.js';

@Injectable()
export class ShoppingLists {
    constructor(
        private readonly commands: ShoppingCommands,
        @Inject(SHOPPING_STORE) private readonly store: ShoppingStore,
    ) {}
    create(
        actor: string,
        space: string,
        key: string,
        input: { name?: string | null },
    ) {
        const name = input.name?.trim() ?? null;
        validateListName(name);
        return this.commands.execute(
            actor,
            space,
            key,
            'CREATE_SHOPPING_LIST',
            space,
            { name },
            async (context, now) => {
                const list: ShoppingList = {
                    id: randomUUID(),
                    spaceId: space,
                    name,
                    status: 'ACTIVE',
                    version: 1,
                    creator: shoppingAuthor(context, actor),
                    createdAt: now,
                    archivedAt: null,
                };
                await this.store.insert(list);
                await this.store.event({
                    id: randomUUID(),
                    spaceId: space,
                    aggregateId: list.id,
                    sequence: list.version,
                    type: 'CREATED',
                    actor: list.creator,
                    registeredAt: new Date(now),
                    data: { name },
                });
                return list;
            },
        );
    }
    rename(
        actor: string,
        space: string,
        id: string,
        key: string,
        input: { expectedVersion: number; name: string | null },
    ) {
        const name = input.name?.trim() ?? null;
        validateListName(name);
        return this.commands.execute(
            actor,
            space,
            key,
            'RENAME_SHOPPING_LIST',
            id,
            { expectedVersion: input.expectedVersion, name },
            async (context, now) => {
                const before = await this.store.find(space, id);
                if (before.version !== input.expectedVersion)
                    throw new ShoppingError('CONCURRENT_MODIFICATION');
                const after = renameList(before, name);
                await this.store.update(before, after);
                await this.store.event({
                    id: randomUUID(),
                    spaceId: space,
                    aggregateId: id,
                    sequence: after.version,
                    type: 'RENAMED',
                    actor: shoppingAuthor(context, actor),
                    registeredAt: new Date(now),
                    data: { before: before.name, after: name },
                });
                return after;
            },
        );
    }
    archive(
        actor: string,
        space: string,
        id: string,
        key: string,
        input: { expectedVersion: number },
    ) {
        return this.commands.execute(
            actor,
            space,
            key,
            'ARCHIVE_SHOPPING_LIST',
            id,
            input,
            async (context, now) => {
                const before = await this.store.find(space, id);
                if (before.version !== input.expectedVersion)
                    throw new ShoppingError('CONCURRENT_MODIFICATION');
                const after = archiveList(before, now);
                await this.store.update(before, after);
                await this.store.event({
                    id: randomUUID(),
                    spaceId: space,
                    aggregateId: id,
                    sequence: after.version,
                    type: 'ARCHIVED',
                    actor: shoppingAuthor(context, actor),
                    registeredAt: new Date(now),
                    data: { archivedAt: now },
                });
                return after;
            },
        );
    }
}
