import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Logger, type INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    financeBrowser,
    financeSnapshot,
    sharedFinance,
} from './settlement-fixture.js';
import { routineSnapshot } from './routine-fixture.js';
import {
    prepareShoppingDatabase,
    shoppingApp,
    shoppingSnapshot,
} from './shopping-fixture.js';
import { createApiOpenApiDocument } from '../dist/composition/http/create-api-openapi-document.js';
import { EntityManagerProvider } from '../dist/shared/technical/database/typeorm/entity-manager.provider.js';
import {
    SHOPPING_STORE,
    type ShoppingStore,
} from '../dist/modules/shopping/application/shopping-store.js';

describe('purchase records HTTP/PostgreSQL', () => {
    let app: INestApplication<Server>, db: DataSource;
    beforeAll(prepareShoppingDatabase);
    beforeEach(async () => {
        ({ app, db } = await shoppingApp(
            () => new Date('2026-10-18T14:00:00Z'),
        ));
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await app?.close();
    });
    async function personalItem(desiredQuantity = '4') {
        const b = await financeBrowser(app),
            base = `/v2/spaces/${b.context.personalSpace.id}`,
            list = (await b.post(`${base}/shopping-lists`, {}).expect(201))
                .body,
            path = `${base}/shopping-lists/${list.id}/items`;
        const item = (
            await b
                .post(path, {
                    expectedVersion: 1,
                    description: 'Arroz',
                    desiredQuantity,
                    unit: 'kg',
                })
                .expect(201)
        ).body.item;
        return {
            b,
            base,
            list,
            path,
            item,
            purchases: `${path}/${item.id}/purchases`,
        };
    }

    it('accumulates two authors and keeps each purchase unit as registered', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}`,
            list = (await f.a.post(`${base}/shopping-lists`, {}).expect(201))
                .body,
            path = `${base}/shopping-lists/${list.id}/items`;
        const item = (
                await f.a
                    .post(path, {
                        expectedVersion: 1,
                        description: 'Leite',
                        desiredQuantity: '4',
                        unit: 'litro',
                    })
                    .expect(201)
            ).body.item,
            purchases = `${path}/${item.id}/purchases`;
        await f.a
            .post(`${base}/tasks`, { description: 'Ir ao mercado' })
            .expect(201);
        const finances = await financeSnapshot(db),
            routine = await routineSnapshot(db);
        const first = (
            await f.a
                .post(purchases, { expectedVersion: 2, quantity: '2' })
                .expect(201)
        ).body;
        expect(first).toMatchObject({
            id: list.id,
            version: 3,
            item: {
                purchasedQuantity: '2',
                remainingQuantity: '2',
                status: 'PARTIALLY_PURCHASED',
                creator: item.creator,
            },
            purchase: {
                listId: list.id,
                itemId: item.id,
                quantity: '2',
                effectiveQuantity: '2',
                unit: 'litro',
                registeredBy: {
                    personId: f.a.context.person.id,
                    memberId: f.ma,
                },
                registeredAt: '2026-10-18T14:00:00.000Z',
            },
        });
        await f.b
            .post(`${path}/${item.id}/need`, {
                expectedVersion: 3,
                unit: 'caixa',
            })
            .expect(200);
        const second = (
            await f.b
                .post(purchases, { expectedVersion: 4, quantity: '2' })
                .expect(201)
        ).body;
        expect(second).toMatchObject({
            id: list.id,
            version: 5,
            item: {
                purchasedQuantity: '4',
                remainingQuantity: '0',
                status: 'PURCHASED',
                unit: 'caixa',
            },
            purchase: {
                quantity: '2',
                unit: 'caixa',
                registeredBy: {
                    personId: f.b.context.person.id,
                    memberId: f.mb,
                },
            },
        });
        const records = (await f.a.agent.get(purchases).expect(200)).body.items;
        expect(records).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: first.purchase.id,
                    unit: 'litro',
                    registeredBy: first.purchase.registeredBy,
                }),
                expect.objectContaining({
                    id: second.purchase.id,
                    unit: 'caixa',
                    registeredBy: second.purchase.registeredBy,
                }),
            ]),
        );
        const detail = (
            await f.a.agent.get(`${base}/shopping-lists/${list.id}`).expect(200)
        ).body;
        expect(detail).toMatchObject({
            status: 'ACTIVE',
            summary: { isComplete: true, canSuggestArchival: true },
        });
        const history = (
            await f.a.agent
                .get(`${base}/shopping-lists/${list.id}/history`)
                .expect(200)
        ).body.items;
        expect(
            history.filter(
                (event: { type: string }) => event.type === 'PURCHASE_RECORDED',
            ),
        ).toMatchObject([
            {
                sequence: 3,
                actor: { personId: f.a.context.person.id },
                data: { itemId: item.id, purchase: { id: first.purchase.id } },
            },
            {
                sequence: 5,
                actor: { personId: f.b.context.person.id },
                data: { itemId: item.id, purchase: { id: second.purchase.id } },
            },
        ]);
        expect(await financeSnapshot(db)).toEqual(finances);
        expect(await routineSnapshot(db)).toEqual(routine);
        expect(
            (
                await db.query('SELECT status FROM spaces WHERE id=$1', [
                    f.space,
                ])
            )[0].status,
        ).toBe('ACTIVE');
    });

    it('adds decimal purchases exactly and shows the remaining thousandths', async () => {
        const { b, purchases } = await personalItem('0.301');
        await b
            .post(purchases, { expectedVersion: 2, quantity: '0.1' })
            .expect(201);
        const sum = (
            await b
                .post(purchases, { expectedVersion: 3, quantity: '0.2' })
                .expect(201)
        ).body;
        expect(sum.item).toMatchObject({
            purchasedQuantity: '0.3',
            remainingQuantity: '0.001',
            status: 'PARTIALLY_PURCHASED',
        });
        const final = (
            await b
                .post(purchases, { expectedVersion: 4, quantity: '0.001' })
                .expect(201)
        ).body;
        expect(final.item).toMatchObject({
            purchasedQuantity: '0.301',
            remainingQuantity: '0',
            status: 'PURCHASED',
        });
    });

    it('keeps excess purchases visible and validates only reductions below the purchased total', async () => {
        const { b, path, item, purchases } = await personalItem();
        const excess = (
            await b
                .post(purchases, { expectedVersion: 2, quantity: '5' })
                .expect(201)
        ).body;
        expect(excess.item).toMatchObject({
            desiredQuantity: '4',
            purchasedQuantity: '5',
            remainingQuantity: '0',
            status: 'PURCHASED',
        });
        const need = `${path}/${item.id}/need`;
        await b.post(need, { expectedVersion: 3, unit: 'pacote' }).expect(200);
        const increase = (
            await b
                .post(need, { expectedVersion: 4, desiredQuantity: '4.5' })
                .expect(200)
        ).body;
        expect(increase.item).toMatchObject({
            desiredQuantity: '4.5',
            purchasedQuantity: '5',
            remainingQuantity: '0',
            unit: 'pacote',
        });
        const before = await shoppingSnapshot(db);
        const refused = await b
            .post(need, { expectedVersion: 5, desiredQuantity: '3' })
            .expect(409);
        expect(refused.body.code).toBe('DESIRED_QUANTITY_BELOW_PURCHASED');
        expect(await shoppingSnapshot(db)).toEqual(before);
        const expanded = (
            await b
                .post(need, { expectedVersion: 5, desiredQuantity: '6' })
                .expect(200)
        ).body;
        expect(expanded.item).toMatchObject({
            purchasedQuantity: '5',
            remainingQuantity: '1',
            status: 'PARTIALLY_PURCHASED',
        });
        const equal = (
            await b
                .post(need, { expectedVersion: 6, desiredQuantity: '5' })
                .expect(200)
        ).body;
        expect(equal.item).toMatchObject({
            purchasedQuantity: '5',
            remainingQuantity: '0',
            status: 'PURCHASED',
        });
    });

    it('replays one purchase after later changes and rejects changed payloads or item targets', async () => {
        const { b, path, purchases } = await personalItem(),
            key = randomUUID(),
            input = { expectedVersion: 2, quantity: '2' };
        const pair = await Promise.all([
            b.post(purchases, input, key),
            b.post(purchases, input, key),
        ]);
        expect(pair.map((r) => r.status)).toEqual([201, 201]);
        expect(pair[0].body).toEqual(pair[1].body);
        await b
            .post(purchases, { expectedVersion: 3, quantity: '2' })
            .expect(201);
        const before = await shoppingSnapshot(db);
        expect((await b.post(purchases, input, key).expect(201)).body).toEqual(
            pair[0].body,
        );
        await b.post(purchases, { ...input, quantity: '1' }, key).expect(409);
        expect(await shoppingSnapshot(db)).toEqual(before);
        const other = (
            await b
                .post(path, {
                    expectedVersion: 4,
                    description: 'Outro',
                    desiredQuantity: '1',
                })
                .expect(201)
        ).body.item;
        await b.post(`${path}/${other.id}/purchases`, input, key).expect(409);
        expect((await b.agent.get(purchases).expect(200)).body.totalCount).toBe(
            2,
        );
    });

    it('uses the root version for concurrent partial purchases without losing the winning record', async () => {
        const { b, purchases } = await personalItem();
        const responses = await Promise.all([
            b.post(purchases, { expectedVersion: 2, quantity: '2' }),
            b.post(purchases, { expectedVersion: 2, quantity: '2' }),
        ]);
        expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(responses.find((r) => r.status === 409)!.body.code).toBe(
            'CONCURRENT_MODIFICATION',
        );
        expect((await b.agent.get(purchases).expect(200)).body).toMatchObject({
            version: 3,
            totalCount: 1,
        });
        const retried = (
            await b
                .post(purchases, { expectedVersion: 3, quantity: '2' })
                .expect(201)
        ).body;
        expect(retried).toMatchObject({
            version: 4,
            item: { purchasedQuantity: '4', remainingQuantity: '0' },
        });
        expect((await b.agent.get(purchases).expect(200)).body.totalCount).toBe(
            2,
        );
    });

    it('rejects invalid purchase quantities and accumulated overflow without writes', async () => {
        const { b, purchases } = await personalItem(),
            before = await shoppingSnapshot(db);
        for (const quantity of ['0', '-1', '0.0001', '1000000000000', 1]) {
            const response = await b
                .post(purchases, { expectedVersion: 2, quantity })
                .expect(400);
            expect(response.body.code).toBe('VALIDATION_ERROR');
            expect(response.body.details.fields).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ field: 'quantity' }),
                ]),
            );
        }
        expect(await shoppingSnapshot(db)).toEqual(before);
        await b
            .post(purchases, {
                expectedVersion: 2,
                quantity: '999999999999.999',
            })
            .expect(201);
        const maximum = await shoppingSnapshot(db);
        await b
            .post(purchases, { expectedVersion: 3, quantity: '0.001' })
            .expect(400);
        expect(await shoppingSnapshot(db)).toEqual(maximum);
    });

    it('pages actionable items before purchased items and keeps the summary global', async () => {
        const { b, base, path, list, item, purchases } = await personalItem();
        await b
            .post(purchases, { expectedVersion: 2, quantity: '4' })
            .expect(201);
        const partial = (
            await b
                .post(path, {
                    expectedVersion: 3,
                    description: 'Parcial',
                    desiredQuantity: '4',
                })
                .expect(201)
        ).body.item;
        await b
            .post(`${path}/${partial.id}/purchases`, {
                expectedVersion: 4,
                quantity: '1',
            })
            .expect(201);
        for (let i = 0; i < 2; i++)
            await b
                .post(path, {
                    expectedVersion: 5 + i,
                    description: `Pendente ${i}`,
                    desiredQuantity: '1',
                })
                .expect(201);
        const before = await shoppingSnapshot(db),
            first = (await b.agent.get(`${path}?limit=2`).expect(200)).body,
            second = (
                await b.agent
                    .get(`${path}?limit=2&cursor=${first.nextCursor}`)
                    .expect(200)
            ).body,
            summary = {
                activeItemCount: 4,
                pendingItemCount: 2,
                partiallyPurchasedItemCount: 1,
                purchasedItemCount: 1,
                actionableItemCount: 3,
                isComplete: false,
                canSuggestArchival: false,
            };
        expect(first).toMatchObject({ totalCount: 4, summary });
        expect(second).toMatchObject({
            totalCount: 4,
            summary,
            nextCursor: null,
        });
        const items = [...first.items, ...second.items];
        expect(
            new Set(items.map((entry: { id: string }) => entry.id)).size,
        ).toBe(4);
        expect(
            items
                .slice(0, 3)
                .every(
                    (entry: { status: string }) => entry.status !== 'PURCHASED',
                ),
        ).toBe(true);
        expect(items[3]).toMatchObject({ id: item.id, status: 'PURCHASED' });
        expect(
            (await b.agent.get(`${base}/shopping-lists/${list.id}`).expect(200))
                .body,
        ).toMatchObject({ summary });
        expect(
            (await b.agent.get(`${path}?status=PURCHASED`).expect(200)).body
                .items,
        ).toMatchObject([{ id: item.id }]);
        const actionable = (
            await b.agent.get(`${path}?status=PENDING`).expect(200)
        ).body.items;
        expect(actionable).toHaveLength(3);
        expect(
            actionable.some(
                (entry: { status: string }) =>
                    entry.status === 'PARTIALLY_PURCHASED',
            ),
        ).toBe(true);
        expect(await shoppingSnapshot(db)).toEqual(before);
    });

    it.each(['detail', 'item'])(
        'keeps version, desired quantity, purchased total and summary coherent in a %s snapshot',
        async (view) => {
            const { b, base, path, list, item } = await personalItem(),
                store = app.get<ShoppingStore>(SHOPPING_STORE),
                find = store.find.bind(store),
                provider = app.get(EntityManagerProvider);
            vi.spyOn(store, 'find').mockImplementationOnce(async (...args) => {
                const original = await find(...args),
                    manager = provider.get();
                expect(manager.queryRunner?.isTransactionActive).toBe(true);
                expect(
                    (await manager.query('SHOW transaction_read_only'))[0]
                        .transaction_read_only,
                ).toBe('on');
                await db.transaction(async (writer) => {
                    await writer.query(
                        'UPDATE shopping_lists SET version=version+1 WHERE id=$1',
                        [list.id],
                    );
                    await writer.query(
                        "UPDATE shopping_items SET desired_quantity='6' WHERE id=$1",
                        [item.id],
                    );
                    await writer.query(
                        'INSERT INTO shopping_purchase_records(id,space_id,list_id,item_id,quantity,unit,registered_by_person_id,registered_by_member_id,registered_by_display_name,registered_at) SELECT gen_random_uuid(),space_id,list_id,id,2,unit,creator_person_id,creator_member_id,creator_display_name,now() FROM shopping_items WHERE id=$1',
                        [item.id],
                    );
                });
                return original;
            });
            const url =
                    view === 'detail'
                        ? `${base}/shopping-lists/${list.id}`
                        : `${path}/${item.id}`,
                before = (await b.agent.get(url).expect(200)).body,
                beforeItem =
                    view === 'detail' ? before.items.items[0] : before.item;
            expect(before.version).toBe(2);
            expect(beforeItem).toMatchObject({
                desiredQuantity: '4',
                purchasedQuantity: '0',
                remainingQuantity: '4',
                status: 'PENDING',
            });
            if (view === 'detail')
                expect(before.summary).toMatchObject({
                    pendingItemCount: 1,
                    partiallyPurchasedItemCount: 0,
                });
            vi.restoreAllMocks();
            const after = (await b.agent.get(url).expect(200)).body,
                afterItem =
                    view === 'detail' ? after.items.items[0] : after.item;
            expect(after.version).toBe(3);
            expect(afterItem).toMatchObject({
                desiredQuantity: '6',
                purchasedQuantity: '2',
                remainingQuantity: '4',
                status: 'PARTIALLY_PURCHASED',
            });
            if (view === 'detail')
                expect(after.summary).toMatchObject({
                    pendingItemCount: 0,
                    partiallyPurchasedItemCount: 1,
                });
        },
    );

    it('paginates purchase records with scoped cursors and preserves all registered facts on reads', async () => {
        const { b, path, purchases } = await personalItem();
        for (let i = 0; i < 3; i++)
            await b
                .post(purchases, { expectedVersion: 2 + i, quantity: '0.5' })
                .expect(201);
        const other = (
                await b
                    .post(path, {
                        expectedVersion: 5,
                        description: 'Outro',
                        desiredQuantity: '1',
                    })
                    .expect(201)
            ).body.item,
            before = await shoppingSnapshot(db),
            first = (await b.agent.get(`${purchases}?limit=2`).expect(200))
                .body,
            second = (
                await b.agent
                    .get(`${purchases}?limit=2&cursor=${first.nextCursor}`)
                    .expect(200)
            ).body;
        expect(first.totalCount).toBe(3);
        expect(second.nextCursor).toBeNull();
        expect(
            new Set(
                [...first.items, ...second.items].map(
                    (entry: { id: string }) => entry.id,
                ),
            ).size,
        ).toBe(3);
        await b.agent
            .get(`${path}/${other.id}/purchases?cursor=${first.nextCursor}`)
            .expect(400);
        expect(await shoppingSnapshot(db)).toEqual(before);
    });

    it('isolates purchases by actor, list, item and space', async () => {
        const { b, base, path, list, purchases } = await personalItem(),
            outsider = await financeBrowser(app),
            other = (await b.post(`${base}/shopping-lists`, {}).expect(201))
                .body,
            item = purchases.split('/').at(-2)!,
            before = await shoppingSnapshot(db);
        await outsider.agent.get(purchases).expect(404);
        await outsider
            .post(purchases, { expectedVersion: 2, quantity: '1' })
            .expect(404);
        await b.agent
            .get(`${base}/shopping-lists/${other.id}/items/${item}/purchases`)
            .expect(404);
        await b
            .post(
                `${base}/shopping-lists/${other.id}/items/${item}/purchases`,
                { expectedVersion: 1, quantity: '1' },
            )
            .expect(404);
        await outsider.agent
            .get(
                `/v2/spaces/${outsider.context.personalSpace.id}/shopping-lists/${list.id}/items/${item}/purchases`,
            )
            .expect(404);
        expect(await shoppingSnapshot(db)).toEqual(before);
        expect(
            (await b.agent.get(`${path}/${item}`).expect(200)).body.item
                .purchasedQuantity,
        ).toBe('0');
    });

    it.each(['shopping_history', 'shopping_command_audit'])(
        'rolls back purchase facts, progress, root and receipts when %s rejects persistence',
        async (table) => {
            const { b, purchases } = await personalItem(),
                before = await shoppingSnapshot(db);
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            await db.query(
                `ALTER TABLE ${table} ADD CONSTRAINT test_reject_purchase CHECK (false) NOT VALID`,
            );
            try {
                await b
                    .post(purchases, { expectedVersion: 2, quantity: '2' })
                    .expect(500);
                expect(await shoppingSnapshot(db)).toEqual(before);
            } finally {
                await db.query(
                    `ALTER TABLE ${table} DROP CONSTRAINT test_reject_purchase`,
                );
            }
        },
    );

    it('registers purchase creation and history collection in executable OpenAPI', () => {
        const doc = createApiOpenApiDocument(false),
            path =
                '/v2/spaces/{spaceId}/shopping-lists/{listId}/items/{itemId}/purchases';
        expect(doc.paths[path]?.post).toBeDefined();
        expect(doc.paths[path]?.get).toBeDefined();
    });
});
