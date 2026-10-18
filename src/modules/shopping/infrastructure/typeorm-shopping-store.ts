import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManagerProvider } from '../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type {
    ShoppingHistoryEvent,
    ShoppingListKey,
    ShoppingItemKey,
    ShoppingStore,
} from '../application/shopping-store.js';
import type { ShoppingList } from '../domain/shopping-list.js';
import {
    shoppingSummary,
    type ShoppingItem,
    type ShoppingItemFilter,
    type ShoppingSummary,
} from '../domain/shopping-item.js';
import { ShoppingError } from '../domain/shopping-error.js';
import { Quantity } from '../domain/quantity.js';
import type { PurchaseRecord } from '../domain/purchase-record.js';
import type { PurchaseCorrection } from '../domain/purchase-correction.js';
import {
    effectivePurchaseJoinSql,
    effectivePurchaseQuantitySql,
} from './shopping-purchases.sql.js';
import {
    shoppingProgressSql,
    shoppingItemFilterSql,
    shoppingItemColumnsSql,
} from './shopping-items.sql.js';
import {
    ShoppingListOrmEntity,
    ShoppingItemOrmEntity,
    PurchaseRecordOrmEntity,
    PurchaseCorrectionOrmEntity,
    ShoppingHistoryOrmEntity,
    ShoppingReceiptOrmEntity,
    ShoppingAuditOrmEntity,
    rowToList,
    listToRow,
    itemToRow,
    rowToItem,
    purchaseToRow,
    rowToPurchase,
    correctionToRow,
    rowToCorrection,
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
    async findItem(spaceId: string, listId: string, id: string) {
        const row = await this.provider
            .get()
            .findOneBy(ShoppingItemOrmEntity, { spaceId, listId, id });
        if (!row) throw new ShoppingError('SHOPPING_ITEM_NOT_FOUND');
        const [total] = await this.provider
            .get()
            .query(
                `SELECT COALESCE(SUM(${effectivePurchaseQuantitySql}),0)::text AS quantity FROM shopping_purchase_records p ${effectivePurchaseJoinSql} WHERE p.space_id=$1 AND p.list_id=$2 AND p.item_id=$3`,
                [spaceId, listId, id],
            );
        return {
            ...rowToItem(row),
            purchasedQuantity: Quantity.from(
                total.quantity,
                'purchasedQuantity',
                true,
            ).toString(),
        };
    }
    async insertItem(space: string, item: ShoppingItem) {
        await this.provider
            .get()
            .insert(ShoppingItemOrmEntity, itemToRow(space, item));
    }
    async updateItem(spaceId: string, item: ShoppingItem) {
        const changed = await this.provider.get().update(
            ShoppingItemOrmEntity,
            { spaceId, listId: item.listId, id: item.id },
            {
                desiredQuantity: item.desiredQuantity,
                unit: item.unit,
                removedAt: item.removedAt ? new Date(item.removedAt) : null,
            },
        );
        if (changed.affected !== 1)
            throw new ShoppingError('SHOPPING_ITEM_NOT_FOUND');
    }
    async summary(
        spaceId: string,
        lists: string[],
    ): Promise<Map<string, ShoppingSummary>> {
        if (!lists.length) return new Map();
        const rows: {
            listId: string;
            active: string;
            pending: string;
            partial: string;
            purchased: string;
        }[] = await this.provider.get().query(
            `${shoppingProgressSql} SELECT list_id AS "listId",COUNT(*) FILTER (WHERE removed_at IS NULL) AS active,
                COUNT(*) FILTER (WHERE removed_at IS NULL AND purchased_quantity=0) AS pending,
                COUNT(*) FILTER (WHERE removed_at IS NULL AND purchased_quantity>0 AND purchased_quantity<desired_quantity) AS partial,
                COUNT(*) FILTER (WHERE removed_at IS NULL AND purchased_quantity>=desired_quantity) AS purchased
            FROM item_progress GROUP BY list_id`,
            [spaceId, lists],
        );
        const result = new Map(lists.map((id) => [id, shoppingSummary()]));
        for (const row of rows)
            result.set(
                row.listId,
                shoppingSummary(
                    Number(row.active),
                    Number(row.pending),
                    Number(row.partial),
                    Number(row.purchased),
                ),
            );
        return result;
    }
    async items(
        spaceId: string,
        listId: string,
        status: ShoppingItemFilter,
        after: ShoppingItemKey | null,
        limit: number,
    ) {
        const [count] = await this.provider
            .get()
            .query(
                `${shoppingProgressSql} SELECT COUNT(*)::integer AS count FROM item_progress WHERE ${shoppingItemFilterSql}`,
                [spaceId, [listId], status],
            );
        const rows: (ShoppingItemOrmEntity & { purchasedQuantity: string })[] =
            await this.provider.get().query(
                `${shoppingProgressSql} SELECT ${shoppingItemColumnsSql} FROM item_progress
            WHERE ${shoppingItemFilterSql} AND ($4::integer IS NULL OR (item_group,created_at,id)>($4,$5::timestamptz,$6::uuid))
            ORDER BY item_group,created_at,id LIMIT $7`,
                [
                    spaceId,
                    [listId],
                    status,
                    after?.group ?? null,
                    after?.createdAt ?? null,
                    after?.id ?? null,
                    limit,
                ],
            );
        return {
            items: rows.map((row) => ({
                ...rowToItem(row),
                purchasedQuantity: Quantity.from(
                    row.purchasedQuantity,
                    'purchasedQuantity',
                    true,
                ).toString(),
            })),
            totalCount: count.count,
        };
    }
    async insertPurchase(space: string, purchase: PurchaseRecord) {
        await this.provider
            .get()
            .insert(PurchaseRecordOrmEntity, purchaseToRow(space, purchase));
    }
    async findPurchase(
        spaceId: string,
        listId: string,
        itemId: string,
        id: string,
    ) {
        const row = await this.provider
            .get()
            .findOneBy(PurchaseRecordOrmEntity, {
                spaceId,
                listId,
                itemId,
                id,
            });
        if (!row) throw new ShoppingError('SHOPPING_PURCHASE_NOT_FOUND');
        const correction = await this.provider
            .get()
            .findOne(PurchaseCorrectionOrmEntity, {
                where: { spaceId, listId, itemId, purchaseId: id },
                order: { sequence: 'DESC' },
            });
        return {
            ...rowToPurchase(row),
            effectiveQuantity: Quantity.from(
                correction?.quantity ?? row.quantity,
                'quantity',
                true,
            ).toString(),
        };
    }
    async insertCorrection(space: string, correction: PurchaseCorrection) {
        await this.provider
            .get()
            .insert(
                PurchaseCorrectionOrmEntity,
                correctionToRow(space, correction),
            );
    }
    async corrections(
        spaceId: string,
        listId: string,
        itemId: string,
        purchaseId: string,
        after: number,
        limit: number,
    ) {
        const query = this.provider
            .get()
            .createQueryBuilder(PurchaseCorrectionOrmEntity, 'c')
            .where(
                'c.spaceId=:spaceId AND c.listId=:listId AND c.itemId=:itemId AND c.purchaseId=:purchaseId',
                { spaceId, listId, itemId, purchaseId },
            );
        const totalCount = await query.clone().getCount();
        const rows = await query
            .andWhere('c.sequence>:after', { after })
            .orderBy('c.sequence', 'ASC')
            .addOrderBy('c.id', 'ASC')
            .take(limit)
            .getMany();
        return { items: rows.map(rowToCorrection), totalCount };
    }
    async purchases(
        spaceId: string,
        listId: string,
        itemId: string,
        after: ShoppingListKey | null,
        limit: number,
    ) {
        const query = this.provider
            .get()
            .createQueryBuilder(PurchaseRecordOrmEntity, 'p')
            .where(
                'p.spaceId=:spaceId AND p.listId=:listId AND p.itemId=:itemId',
                { spaceId, listId, itemId },
            );
        const totalCount = await query.clone().getCount();
        if (after)
            query.andWhere('(p.registeredAt,p.id)>(:createdAt,:id)', {
                createdAt: new Date(after.createdAt),
                id: after.id,
            });
        const rows = await query
            .orderBy('p.registeredAt', 'ASC')
            .addOrderBy('p.id', 'ASC')
            .take(limit)
            .getMany();
        const corrections: { purchaseId: string; quantity: string }[] =
            rows.length
                ? await this.provider
                      .get()
                      .query(
                          `SELECT DISTINCT ON (purchase_id) purchase_id AS "purchaseId",quantity FROM shopping_purchase_corrections WHERE space_id=$1 AND list_id=$2 AND item_id=$3 AND purchase_id=ANY($4::uuid[]) ORDER BY purchase_id,sequence DESC`,
                          [spaceId, listId, itemId, rows.map((row) => row.id)],
                      )
                : [];
        const effective = new Map(
            corrections.map((c) => [c.purchaseId, c.quantity]),
        );
        return {
            items: rows.map((row) => ({
                ...rowToPurchase(row),
                effectiveQuantity: Quantity.from(
                    effective.get(row.id) ?? row.quantity,
                    'quantity',
                    true,
                ).toString(),
            })),
            totalCount,
        };
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
        return {
            items: rows.map(rowToList),
            totalCount,
            summaries: await this.summary(
                spaceId,
                rows.map((row) => row.id),
            ),
        };
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
