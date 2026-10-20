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
import { financeBrowser } from './settlement-fixture.js';
import {
    prepareShoppingDatabase,
    shoppingApp,
    shoppingSnapshot,
} from './shopping-fixture.js';

describe('item removal and list archival HTTP/PostgreSQL', () => {
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
    async function fixture(quantity: string | null = null) {
        const b = await financeBrowser(app),
            base = `/v2/spaces/${b.context.personalSpace.id}/shopping-lists`,
            list = (await b.post(base, {}).expect(201)).body,
            listPath = `${base}/${list.id}`,
            path = `${listPath}/items`,
            item = (
                await b
                    .post(path, {
                        expectedVersion: 1,
                        description: 'Arroz',
                        desiredQuantity: '4',
                        unit: 'kg',
                    })
                    .expect(201)
            ).body.item;
        const purchase =
            quantity === null
                ? null
                : (
                      await b
                          .post(`${path}/${item.id}/purchases`, {
                              expectedVersion: 2,
                              quantity,
                          })
                          .expect(201)
                  ).body.purchase;
        return {
            b,
            base,
            list,
            listPath,
            path,
            item,
            purchase,
            version: quantity === null ? 2 : 3,
        };
    }

    it.each([null, '3', '5'])(
        'removes an item with purchase quantity %s without erasing facts and excludes it from active summaries',
        async (quantity) => {
            const { b, list, listPath, path, item, purchase } =
                await fixture(quantity);
            let version = quantity === null ? 2 : 3;
            if (purchase) {
                await b
                    .post(
                        `${path}/${item.id}/purchases/${purchase.id}/corrections`,
                        {
                            expectedVersion: version++,
                            quantity: quantity === '3' ? '2' : '4',
                        },
                    )
                    .expect(200);
            }
            const active = (
                    await b
                        .post(path, {
                            expectedVersion: version++,
                            description: 'Pendente',
                            desiredQuantity: '1',
                        })
                        .expect(201)
                ).body.item,
                facts = () =>
                    Promise.all(
                        [
                            'shopping_purchase_records',
                            'shopping_purchase_corrections',
                        ].map((table) =>
                            db.query(`SELECT * FROM ${table} ORDER BY id`),
                        ),
                    ),
                beforeFacts = await facts();
            const removed = (
                await b
                    .post(`${path}/${item.id}/removal`, {
                        expectedVersion: version,
                    })
                    .expect(200)
            ).body;
            expect(removed).toMatchObject({
                id: list.id,
                version: version + 1,
                item: {
                    id: item.id,
                    status: 'REMOVED',
                    desiredQuantity: '4',
                    creator: item.creator,
                    purchasedQuantity:
                        quantity === null ? '0' : quantity === '3' ? '2' : '4',
                    removedAt: '2026-10-18T14:00:00.000Z',
                },
            });
            expect(await facts()).toEqual(beforeFacts);
            const page = (await b.agent.get(path).expect(200)).body;
            expect(page.items).toMatchObject([
                { id: active.id, status: 'PENDING' },
            ]);
            expect(page.summary).toMatchObject({
                activeItemCount: 1,
                pendingItemCount: 1,
                purchasedItemCount: 0,
                actionableItemCount: 1,
                isComplete: false,
            });
            expect(
                (await b.agent.get(`${path}?status=REMOVED`).expect(200)).body
                    .items,
            ).toMatchObject([{ id: item.id, status: 'REMOVED' }]);
            expect(
                (await b.agent.get(`${path}?status=PURCHASED`).expect(200)).body
                    .items,
            ).toEqual([]);
            expect(
                (await b.agent.get(`${path}/${item.id}`).expect(200)).body.item
                    .allowedActions,
            ).toEqual([]);
            await b.agent.get(`${path}/${item.id}/purchases`).expect(200);
            if (purchase)
                await b.agent
                    .get(
                        `${path}/${item.id}/purchases/${purchase.id}/corrections`,
                    )
                    .expect(200);
            const history = (
                await b.agent.get(`${listPath}/history`).expect(200)
            ).body.items;
            expect(history.at(-1)).toMatchObject({
                type: 'ITEM_REMOVED',
                sequence: version + 1,
                actor: { personId: b.context.person.id, memberId: null },
                data: {
                    itemId: item.id,
                    removedAt: '2026-10-18T14:00:00.000Z',
                },
            });
        },
    );

    it('paginates ALL across actionable, purchased and removed groups with no writes on GET', async () => {
        const { b, path, item } = await fixture('4');
        const removed = (
            await b
                .post(path, {
                    expectedVersion: 3,
                    description: 'Removido',
                    desiredQuantity: '1',
                })
                .expect(201)
        ).body.item;
        await b
            .post(`${path}/${removed.id}/removal`, { expectedVersion: 4 })
            .expect(200);
        const pending = (
                await b
                    .post(path, {
                        expectedVersion: 5,
                        description: 'Pendente',
                        desiredQuantity: '1',
                    })
                    .expect(201)
            ).body.item,
            before = await shoppingSnapshot(db),
            items: { id: string; status: string }[] = [];
        let cursor: string | null = null;
        do {
            const page: {
                items: { id: string; status: string }[];
                totalCount: number;
                summary: Record<string, unknown>;
                nextCursor: string | null;
            } = (
                await b.agent
                    .get(
                        `${path}?status=ALL&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
                    )
                    .expect(200)
            ).body;
            expect(page.totalCount).toBe(3);
            expect(page.summary).toMatchObject({
                activeItemCount: 2,
                actionableItemCount: 1,
                purchasedItemCount: 1,
            });
            items.push(...page.items);
            cursor = page.nextCursor;
        } while (cursor);
        expect(items).toMatchObject([
            { id: pending.id, status: 'PENDING' },
            { id: item.id, status: 'PURCHASED' },
            { id: removed.id, status: 'REMOVED' },
        ]);
        expect(await shoppingSnapshot(db)).toEqual(before);
    });

    it.each(['EMPTY', 'INCOMPLETE', 'COMPLETE'])(
        'archives an explicitly selected %s list and records the actor',
        async (state) => {
            const b = await financeBrowser(app),
                base = `/v2/spaces/${b.context.personalSpace.id}/shopping-lists`,
                list = (await b.post(base, {}).expect(201)).body,
                path = `${base}/${list.id}`;
            let version = 1;
            if (state !== 'EMPTY') {
                const item = (
                    await b
                        .post(`${path}/items`, {
                            expectedVersion: version++,
                            description: 'Arroz',
                            desiredQuantity: '1',
                        })
                        .expect(201)
                ).body.item;
                if (state === 'COMPLETE')
                    await b
                        .post(`${path}/items/${item.id}/purchases`, {
                            expectedVersion: version++,
                            quantity: '1',
                        })
                        .expect(201);
            }
            const active = (await b.agent.get(path).expect(200)).body;
            expect(active.status).toBe('ACTIVE');
            expect(active.summary.canSuggestArchival).toBe(
                state === 'COMPLETE',
            );
            const key = randomUUID(),
                input = { expectedVersion: version },
                archived = (
                    await b.post(`${path}/archival`, input, key).expect(200)
                ).body;
            expect(archived).toMatchObject({
                id: list.id,
                version: version + 1,
                status: 'ARCHIVED',
                archivedAt: '2026-10-18T14:00:00.000Z',
            });
            const before = await shoppingSnapshot(db);
            expect(
                (await b.post(`${path}/archival`, input, key).expect(200)).body,
            ).toEqual(archived);
            const detail = (await b.agent.get(path).expect(200)).body;
            expect(detail).toMatchObject({
                status: 'ARCHIVED',
                allowedActions: [],
                summary: { canSuggestArchival: false },
            });
            expect(
                (await b.agent.get(`${base}?status=ACTIVE`).expect(200)).body
                    .items,
            ).toEqual([]);
            expect(
                (await b.agent.get(`${base}?status=ARCHIVED`).expect(200)).body
                    .items,
            ).toMatchObject([
                { id: list.id, summary: { canSuggestArchival: false } },
            ]);
            const history = (await b.agent.get(`${path}/history`).expect(200))
                .body.items;
            expect(history.at(-1)).toMatchObject({
                type: 'ARCHIVED',
                sequence: version + 1,
                actor: { personId: b.context.person.id },
            });
            expect(await shoppingSnapshot(db)).toEqual(before);
        },
    );

    it('keeps an archived list readable and blocks every new maintenance command', async () => {
        const { b, listPath, path, item, purchase } = await fixture('2');
        await b
            .post(`${listPath}/archival`, { expectedVersion: 3 })
            .expect(200);
        const before = await shoppingSnapshot(db);
        for (const [url, input] of [
            [`${listPath}/name`, { expectedVersion: 4, name: 'Outro' }],
            [
                path,
                {
                    expectedVersion: 4,
                    description: 'Outro',
                    desiredQuantity: '1',
                },
            ],
            [`${path}/${item.id}/need`, { expectedVersion: 4, unit: 'pacote' }],
            [
                `${path}/${item.id}/purchases`,
                { expectedVersion: 4, quantity: '1' },
            ],
            [
                `${path}/${item.id}/purchases/${purchase.id}/corrections`,
                { expectedVersion: 4, quantity: '0' },
            ],
            [`${path}/${item.id}/removal`, { expectedVersion: 4 }],
            [`${listPath}/archival`, { expectedVersion: 4 }],
        ] as const)
            await b.post(url, input).expect(409);
        for (const url of [
            listPath,
            path,
            `${path}/${item.id}`,
            `${path}/${item.id}/purchases`,
            `${path}/${item.id}/purchases/${purchase.id}/corrections`,
            `${listPath}/history`,
        ])
            await b.agent.get(url).expect(200);
        await b
            .post(`${listPath}/reopening`, { expectedVersion: 4 })
            .expect(404);
        await b
            .post(`${path}/${item.id}/reactivation`, { expectedVersion: 4 })
            .expect(404);
        expect(
            (await b.agent.get(`${path}/${item.id}`).expect(200)).body.item
                .allowedActions,
        ).toEqual([]);
        expect(
            (await b.agent.get(path).expect(200)).body.summary
                .canSuggestArchival,
        ).toBe(false);
        expect(await shoppingSnapshot(db)).toEqual(before);
    });

    it('replays removal once and blocks later mutation of the removed item', async () => {
        const { b, path, item, purchase } = await fixture('2'),
            removal = `${path}/${item.id}/removal`,
            key = randomUUID(),
            input = { expectedVersion: 3 };
        const pair = await Promise.all([
            b.post(removal, input, key),
            b.post(removal, input, key),
        ]);
        expect(pair.map((r) => r.status)).toEqual([200, 200]);
        expect(pair[0].body).toEqual(pair[1].body);
        const before = await shoppingSnapshot(db);
        await b.post(removal, { expectedVersion: 4 }).expect(409);
        await b
            .post(`${path}/${item.id}/need`, {
                expectedVersion: 4,
                desiredQuantity: '5',
            })
            .expect(409);
        await b
            .post(`${path}/${item.id}/purchases`, {
                expectedVersion: 4,
                quantity: '1',
            })
            .expect(409);
        await b
            .post(`${path}/${item.id}/purchases/${purchase.id}/corrections`, {
                expectedVersion: 4,
                quantity: '0',
            })
            .expect(409);
        await b.post(removal, { expectedVersion: 4 }, key).expect(409);
        expect(await shoppingSnapshot(db)).toEqual(before);
    });

    it('serializes archival against a competing purchase on the root version', async () => {
        const { b, listPath, path, item } = await fixture();
        const pair = await Promise.all([
            b.post(`${listPath}/archival`, { expectedVersion: 2 }),
            b.post(`${path}/${item.id}/purchases`, {
                expectedVersion: 2,
                quantity: '4',
            }),
        ]);
        expect(pair.filter((r) => r.status === 409)).toHaveLength(1);
        expect(
            pair.filter((r) => r.status === 200 || r.status === 201),
        ).toHaveLength(1);
        const root = (await b.agent.get(listPath).expect(200)).body;
        expect(root.version).toBe(3);
        expect(root.status).toBe(
            pair[0].status === 200 ? 'ARCHIVED' : 'ACTIVE',
        );
        expect(
            (await b.agent.get(`${path}/${item.id}/purchases`).expect(200)).body
                .totalCount,
        ).toBe(pair[1].status === 201 ? 1 : 0);
    });

    it.each(['purchase', 'correction'])(
        'serializes removal against a competing %s',
        async (operation) => {
            const { b, path, item, purchase } = await fixture('2'),
                otherPath =
                    operation === 'purchase'
                        ? `${path}/${item.id}/purchases`
                        : `${path}/${item.id}/purchases/${purchase.id}/corrections`;
            const pair = await Promise.all([
                b.post(`${path}/${item.id}/removal`, { expectedVersion: 3 }),
                b.post(otherPath, { expectedVersion: 3, quantity: '1' }),
            ]);
            expect(pair.filter((r) => r.status === 409)).toHaveLength(1);
            const winner = pair.find(
                (r) => r.status === 200 || r.status === 201,
            )!;
            expect(winner.body.version).toBe(4);
            expect(
                (await b.agent.get(`${path}/${item.id}`).expect(200)).body,
            ).toMatchObject({ version: 4, item: winner.body.item });
        },
    );

    it('rejects removal and archival addressed through another parent context', async () => {
        const { b, base, listPath, path, item } = await fixture(),
            outsider = await financeBrowser(app),
            other = (await b.post(base, {}).expect(201)).body,
            before = await shoppingSnapshot(db);
        await outsider
            .post(`${listPath}/archival`, { expectedVersion: 2 })
            .expect(404);
        await outsider
            .post(`${path}/${item.id}/removal`, { expectedVersion: 2 })
            .expect(404);
        await b
            .post(`${base}/${other.id}/items/${item.id}/removal`, {
                expectedVersion: 1,
            })
            .expect(404);
        expect(await shoppingSnapshot(db)).toEqual(before);
    });

    it.each(['shopping_history', 'shopping_command_audit'])(
        'rolls back removal and archival when %s fails',
        async (table) => {
            const { b, listPath, path, item } = await fixture('2'),
                before = await shoppingSnapshot(db);
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            await db.query(
                `ALTER TABLE ${table} ADD CONSTRAINT test_reject_removal CHECK (false) NOT VALID`,
            );
            try {
                await b
                    .post(`${path}/${item.id}/removal`, { expectedVersion: 3 })
                    .expect(500);
                expect(await shoppingSnapshot(db)).toEqual(before);
                await b
                    .post(`${listPath}/archival`, { expectedVersion: 3 })
                    .expect(500);
                expect(await shoppingSnapshot(db)).toEqual(before);
            } finally {
                await db.query(
                    `ALTER TABLE ${table} DROP CONSTRAINT test_reject_removal`,
                );
            }
        },
    );
});
