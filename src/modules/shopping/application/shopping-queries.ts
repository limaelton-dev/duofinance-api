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
} from './shopping-store.js';
import { cursorScope, decodeCursor, encodeCursor } from './shopping-cursor.js';
import { ShoppingError } from '../domain/shopping-error.js';
import type { ShoppingList } from '../domain/shopping-list.js';

export function shoppingListView(list: ShoppingList, canWrite = true) {
    return {
        ...list,
        summary: {
            activeItemCount: 0,
            pendingItemCount: 0,
            partiallyPurchasedItemCount: 0,
            purchasedItemCount: 0,
            actionableItemCount: 0,
            isComplete: true,
            canSuggestArchival: false,
        },
        allowedActions: canWrite && list.status === 'ACTIVE' ? ['RENAME'] : [],
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
            () => this.store.find(space, id),
            (list, context) => ({
                ...shoppingListView(list, context.status === 'ACTIVE'),
                items: { items: [], nextCursor: null },
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
                        shoppingListView(list, context.status === 'ACTIVE'),
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
