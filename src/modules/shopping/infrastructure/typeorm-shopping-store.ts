import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManagerProvider } from '../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type {
    ShoppingHistoryEvent,
    ShoppingListKey,
    ShoppingStore,
} from '../application/shopping-store.js';
import type { ShoppingList } from '../domain/shopping-list.js';
import { ShoppingError } from '../domain/shopping-error.js';
import {
    ShoppingListOrmEntity,
    ShoppingHistoryOrmEntity,
    ShoppingReceiptOrmEntity,
    ShoppingAuditOrmEntity,
    rowToList,
    listToRow,
} from './shopping.orm-entity.js';

@Injectable()
export class TypeOrmShoppingStore implements ShoppingStore {
    constructor(private readonly provider: EntityManagerProvider) {}
    snapshot<T>(work: () => Promise<T>) {
        return this.provider.readSnapshot(work);
    }
    async find(spaceId: string, id: string) {
        const row = await this.provider
            .get()
            .findOneBy(ShoppingListOrmEntity, { spaceId, id });
        if (!row) throw new ShoppingError('SHOPPING_LIST_NOT_FOUND');
        return rowToList(row);
    }
    async insert(list: ShoppingList) {
        await this.provider
            .get()
            .insert(ShoppingListOrmEntity, listToRow(list));
    }
    async update(before: ShoppingList, after: ShoppingList) {
        const changed = await this.provider.get().update(
            ShoppingListOrmEntity,
            {
                spaceId: before.spaceId,
                id: before.id,
                version: before.version,
            },
            listToRow(after),
        );
        if (changed.affected !== 1)
            throw new ShoppingError('CONCURRENT_MODIFICATION');
    }
    async list(
        spaceId: string,
        status: 'ACTIVE' | 'ARCHIVED' | 'ALL',
        after: ShoppingListKey | null,
        limit: number,
    ) {
        const query = this.provider
            .get()
            .createQueryBuilder(ShoppingListOrmEntity, 'l')
            .where('l.spaceId=:spaceId', { spaceId });
        if (status !== 'ALL') query.andWhere('l.status=:status', { status });
        const totalCount = await query.clone().getCount();
        if (after)
            query.andWhere('(l.createdAt,l.id)>(:createdAt,:id)', {
                createdAt: new Date(after.createdAt),
                id: after.id,
            });
        const rows = await query
            .orderBy('l.createdAt', 'ASC')
            .addOrderBy('l.id', 'ASC')
            .take(limit)
            .getMany();
        return { items: rows.map(rowToList), totalCount };
    }
    async event(event: ShoppingHistoryEvent) {
        const { actor, ...rest } = event;
        await this.provider.get().insert(ShoppingHistoryOrmEntity, {
            ...rest,
            actorId: actor.personId,
            actorMemberId: actor.memberId,
            actorDisplayName: actor.displayName,
        });
    }
    async history(
        spaceId: string,
        aggregateId: string,
        after: number,
        limit: number,
    ) {
        const rows = await this.provider
            .get()
            .createQueryBuilder(ShoppingHistoryOrmEntity, 'h')
            .where(
                'h.spaceId=:spaceId AND h.aggregateId=:aggregateId AND h.sequence>:after',
                { spaceId, aggregateId, after },
            )
            .orderBy('h.sequence', 'ASC')
            .addOrderBy('h.id', 'ASC')
            .take(limit)
            .getMany();
        return rows.map(
            ({ actorId, actorMemberId, actorDisplayName, ...rest }) => ({
                ...rest,
                actor: {
                    personId: actorId,
                    memberId: actorMemberId,
                    displayName: actorDisplayName,
                },
            }),
        );
    }
    async lockReceipt(actor: string, operation: string, key: string) {
        await this.provider
            .get()
            .query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
                `shopping:${actor}:${operation}:${key}`,
            ]);
    }
    receipt(actorId: string, operation: string, key: string) {
        return this.provider
            .get()
            .findOneBy(ShoppingReceiptOrmEntity, { actorId, operation, key });
    }
    async finish(input: Parameters<ShoppingStore['finish']>[0]) {
        const {
            actorId,
            operation,
            key,
            digest,
            result,
            spaceId,
            aggregateId,
            registeredAt,
        } = input;
        await this.provider.get().insert(ShoppingReceiptOrmEntity, {
            actorId,
            operation,
            key,
            digest,
            result,
        });
        await this.provider.get().insert(ShoppingAuditOrmEntity, {
            id: randomUUID(),
            actorId,
            spaceId,
            action: operation,
            key,
            aggregateId,
            registeredAt,
        });
    }
}
