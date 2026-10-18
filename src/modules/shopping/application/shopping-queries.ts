import { Inject, Injectable } from '@nestjs/common';
import {
    SPACE_PARTICIPANTS_PORT,
    type SpaceParticipantsPort,
    type SpaceParticipantsContext,
} from '../../spaces/application/ports/public/space-participants.port.js';
import { PersonId } from '../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../spaces/domain/space/space-id.js';
import { SpacesDomainError } from '../../spaces/domain/errors/spaces-domain.error.js';
import {
    SHOPPING_STORE,
    type ShoppingStore,
    type ShoppingListKey,
    type ShoppingItemKey,
} from './shopping-store.js';
import { cursorScope, decodeCursor, encodeCursor } from './shopping-cursor.js';
import { ShoppingError } from '../domain/shopping-error.js';
import type { ShoppingList } from '../domain/shopping-list.js';
import {
    itemProgress,
    shoppingSummary,
    type ShoppingItemState,
    type ShoppingItemFilter,
    type ShoppingSummary,
} from '../domain/shopping-item.js';
import { purchaseView } from '../domain/purchase-record.js';

export function shoppingListView(
    list: ShoppingList,
    canWrite = true,
    summary: ShoppingSummary = shoppingSummary(),
) {
    return {
        ...list,
        summary: {
            ...summary,
            canSuggestArchival:
                list.status === 'ACTIVE' && summary.canSuggestArchival,
        },
        allowedActions:
            canWrite && list.status === 'ACTIVE'
                ? ['RENAME', 'ADD_ITEM', 'ARCHIVE']
                : [],
    };
}
export function shoppingItemView(item: ShoppingItemState, canWrite = true) {
    return {
        ...itemProgress(item, item.purchasedQuantity),
        allowedActions:
            canWrite && item.removedAt === null
                ? ['CHANGE_NEED', 'RECORD_PURCHASE', 'REMOVE']
                : [],
    };
}
function itemScope(
    actor: string,
    space: string,
    list: string,
    status: ShoppingItemFilter,
) {
    return cursorScope({
        actor,
        space,
        list,
        status,
        order: 'GROUP_CREATED_ASC_ID_ASC',
    });
}
function itemPage(
    page: { items: ShoppingItemState[]; totalCount: number },
    scope: string,
    limit: number,
    canWrite: boolean,
) {
    return {
        items: page.items
            .slice(0, limit)
            .map((item) => shoppingItemView(item, canWrite)),
        totalCount: page.totalCount,
        nextCursor:
            page.items.length > limit
                ? encodeCursor(scope, {
                      createdAt: page.items[limit - 1].createdAt,
                      id: page.items[limit - 1].id,
                      group:
                          page.items[limit - 1].removedAt !== null
                              ? 2
                              : itemProgress(
                                      page.items[limit - 1],
                                      page.items[limit - 1].purchasedQuantity,
                                  ).status === 'PURCHASED'
                                ? 1
                                : 0,
                  })
                : null,
    };
}
function listKey(value: unknown): ShoppingListKey | null {
    if (value === null) return null;
    if (
        typeof value !== 'object' ||
        !('createdAt' in value) ||
        typeof value.createdAt !== 'string' ||
        !Number.isFinite(new Date(value.createdAt).getTime()) ||
        new Date(value.createdAt).toISOString() !== value.createdAt ||
        !('id' in value) ||
        typeof value.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            value.id,
        )
    )
        throw new ShoppingError('VALIDATION_ERROR', 'cursor');
    return { createdAt: value.createdAt, id: value.id };
}
function itemKey(value: unknown): ShoppingItemKey | null {
    const key = listKey(value);
    if (!key) return null;
    if (
        typeof value !== 'object' ||
        value === null ||
        !('group' in value) ||
        (value.group !== 0 && value.group !== 1 && value.group !== 2)
    )
        throw new ShoppingError('VALIDATION_ERROR', 'cursor');
    return { ...key, group: value.group };
}
@Injectable()
export class ShoppingQueries {
    constructor(
        @Inject(SPACE_PARTICIPANTS_PORT)
        private readonly participants: SpaceParticipantsPort,
        @Inject(SHOPPING_STORE) private readonly store: ShoppingStore,
    ) {}
    private context(actor: string, space: string) {
        return this.participants.read(
            PersonId.from(actor),
            SpaceId.from(space),
        );
    }
    async read<T, R = T>(
        actor: string,
        space: string,
        work: () => Promise<T>,
        present: (result: T, context: SpaceParticipantsContext) => R = (
            result,
        ) => result as unknown as R,
    ): Promise<R> {
        const authorized = await this.context(actor, space);
        let outcome: { ok: true; result: T } | { ok: false; error: unknown };
        try {
            outcome = { ok: true, result: await this.store.snapshot(work) };
        } catch (error) {
            outcome = { ok: false, error };
        }
        const confirmed = await this.context(actor, space);
        if (
            confirmed.actorMemberId !== authorized.actorMemberId ||
            confirmed.type !== authorized.type
        )
            throw new SpacesDomainError('SPACE_NOT_FOUND');
        if (!outcome.ok) throw outcome.error;
        return present(outcome.result, confirmed);
    }
    detail(actor: string, space: string, id: string) {
        return this.read(
            actor,
            space,
            async () => ({
                list: await this.store.find(space, id),
                summaries: await this.store.summary(space, [id]),
                items: await this.store.items(space, id, 'ACTIVE', null, 21),
            }),
            ({ list, summaries, items }, context) => ({
                ...shoppingListView(
                    list,
                    context.status === 'ACTIVE',
                    summaries.get(id),
                ),
                items: itemPage(
                    items,
                    itemScope(actor, space, id, 'ACTIVE'),
                    20,
                    context.status === 'ACTIVE' && list.status === 'ACTIVE',
                ),
            }),
        );
    }
    list(
        actor: string,
        space: string,
        q: {
            status: 'ACTIVE' | 'ARCHIVED' | 'ALL';
            limit: number;
            cursor?: string;
        },
    ) {
        const scope = cursorScope({
            actor,
            space,
            status: q.status,
            order: 'CREATED_ASC_ID_ASC',
        });
        const after = listKey(decodeCursor(scope, q.cursor));
        return this.read(
            actor,
            space,
            () => this.store.list(space, q.status, after, q.limit + 1),
            (page, context) => ({
                items: page.items
                    .slice(0, q.limit)
                    .map((list) =>
                        shoppingListView(
                            list,
                            context.status === 'ACTIVE',
                            page.summaries.get(list.id),
                        ),
                    ),
                totalCount: page.totalCount,
                nextCursor:
                    page.items.length > q.limit
                        ? encodeCursor(scope, {
                              createdAt: page.items[q.limit - 1].createdAt,
                              id: page.items[q.limit - 1].id,
                          })
                        : null,
            }),
        );
    }
    items(
        actor: string,
        space: string,
        id: string,
        q: { status: ShoppingItemFilter; limit: number; cursor?: string },
    ) {
        const scope = itemScope(actor, space, id, q.status);
        const after = itemKey(decodeCursor(scope, q.cursor));
        return this.read(
            actor,
            space,
            async () => ({
                list: await this.store.find(space, id),
                summaries: await this.store.summary(space, [id]),
                page: await this.store.items(
                    space,
                    id,
                    q.status,
                    after,
                    q.limit + 1,
                ),
            }),
            ({ list, summaries, page }, context) => ({
                id: list.id,
                version: list.version,
                summary: shoppingListView(
                    list,
                    context.status === 'ACTIVE',
                    summaries.get(id),
                ).summary,
                ...itemPage(
                    page,
                    scope,
                    q.limit,
                    context.status === 'ACTIVE' && list.status === 'ACTIVE',
                ),
            }),
        );
    }
    item(actor: string, space: string, id: string, item: string) {
        return this.read(
            actor,
            space,
            async () => ({
                list: await this.store.find(space, id),
                item: await this.store.findItem(space, id, item),
            }),
            ({ list, item }, context) => ({
                id: list.id,
                version: list.version,
                item: shoppingItemView(
                    item,
                    context.status === 'ACTIVE' && list.status === 'ACTIVE',
                ),
            }),
        );
    }
    purchases(
        actor: string,
        space: string,
        id: string,
        itemId: string,
        q: { limit: number; cursor?: string },
    ) {
        const scope = cursorScope({
            actor,
            space,
            id,
            itemId,
            order: 'PURCHASE_REGISTERED_ASC_ID_ASC',
        });
        const after = listKey(decodeCursor(scope, q.cursor));
        return this.read(actor, space, async () => {
            const list = await this.store.find(space, id);
            await this.store.findItem(space, id, itemId);
            const page = await this.store.purchases(
                space,
                id,
                itemId,
                after,
                q.limit + 1,
            );
            return {
                id,
                version: list.version,
                itemId,
                totalCount: page.totalCount,
                items: page.items.slice(0, q.limit).map(purchaseView),
                nextCursor:
                    page.items.length > q.limit
                        ? encodeCursor(scope, {
                              createdAt: page.items[q.limit - 1].registeredAt,
                              id: page.items[q.limit - 1].id,
                          })
                        : null,
            };
        });
    }
    corrections(
        actor: string,
        space: string,
        id: string,
        itemId: string,
        purchaseId: string,
        q: { limit: number; cursor?: string },
    ) {
        const scope = cursorScope({
            actor,
            space,
            id,
            itemId,
            purchaseId,
            order: 'CORRECTION_SEQUENCE_ASC',
        });
        const key = decodeCursor(scope, q.cursor);
        if (key !== null && (!Number.isSafeInteger(key) || Number(key) < 1))
            throw new ShoppingError('VALIDATION_ERROR', 'cursor');
        return this.read(actor, space, async () => {
            const list = await this.store.find(space, id);
            await this.store.findItem(space, id, itemId);
            await this.store.findPurchase(space, id, itemId, purchaseId);
            const page = await this.store.corrections(
                space,
                id,
                itemId,
                purchaseId,
                Number(key ?? 0),
                q.limit + 1,
            );
            return {
                id,
                version: list.version,
                purchaseId,
                totalCount: page.totalCount,
                items: page.items.slice(0, q.limit),
                nextCursor:
                    page.items.length > q.limit
                        ? encodeCursor(scope, page.items[q.limit - 1].sequence)
                        : null,
            };
        });
    }
    history(
        actor: string,
        space: string,
        id: string,
        q: { limit: number; cursor?: string },
    ) {
        const scope = cursorScope({ actor, space, id, type: 'HISTORY_ASC' });
        const key = decodeCursor(scope, q.cursor);
        if (key !== null && (!Number.isSafeInteger(key) || Number(key) < 1))
            throw new ShoppingError('VALIDATION_ERROR', 'cursor');
        return this.read(actor, space, async () => {
            await this.store.find(space, id);
            const rows = await this.store.history(
                space,
                id,
                Number(key ?? 0),
                q.limit + 1,
            );
            return {
                items: rows.slice(0, q.limit),
                nextCursor:
                    rows.length > q.limit
                        ? encodeCursor(scope, rows[q.limit - 1].sequence)
                        : null,
            };
        });
    }
}
