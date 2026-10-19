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
    sharedFinance,
    rewindFinanceMigrationsTo,
} from './settlement-fixture.js';
import {
    prepareShoppingDatabase,
    shoppingApp,
    shoppingSnapshot,
} from './shopping-fixture.js';
import {
    SHOPPING_STORE,
    type ShoppingStore,
} from '../dist/modules/shopping/application/shopping-store.js';
import { EntityManagerProvider } from '../dist/shared/technical/database/typeorm/entity-manager.provider.js';
import migrationSource from '../dist/shared/technical/database/typeorm/data-source.js';

describe('CARD-041 purchase corrections HTTP/PostgreSQL', () => {
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
    async function recordsFor(
        b: Awaited<ReturnType<typeof financeBrowser>>,
        space = b.context.personalSpace.id as string,
        quantities = ['2', '2'],
    ) {
        const base = `/v2/spaces/${space}/shopping-lists`,
            list = (await b.post(base, {}).expect(201)).body,
            path = `${base}/${list.id}/items`,
            item = (
                await b
                    .post(path, {
                        expectedVersion: 1,
                        description: 'Arroz',
                        desiredQuantity: '4',
                        unit: 'kg',
                    })
                    .expect(201)
            ).body.item,
            purchases = `${path}/${item.id}/purchases`,
            records: {
                id: string;
                quantity: string;
                unit: string;
                registeredBy: object;
                registeredAt: string;
            }[] = [];
        for (let i = 0; i < quantities.length; i++)
            records.push(
                (
                    await b
                        .post(purchases, {
                            expectedVersion: 2 + i,
                            quantity: quantities[i],
                        })
                        .expect(201)
                ).body.purchase,
            );
        return {
            b,
            base,
            list,
            path,
            item,
            purchases,
            records,
            corrections: `${purchases}/${records[0].id}/corrections`,
        };
    }
    async function personalRecords(quantities = ['2', '2']) {
        return recordsFor(await financeBrowser(app), undefined, quantities);
    }

    it('appends authored corrections to one record, preserves original purchases and computes the latest effective total', async () => {
        const f = await sharedFinance(app),
            fixture = await recordsFor(f.a, f.space, ['2']),
            { base, list, path, item, purchases, records, corrections } =
                fixture;
        const second = (
            await f.b
                .post(purchases, { expectedVersion: 3, quantity: '2' })
                .expect(201)
        ).body.purchase;
        await f.b
            .post(`${path}/${item.id}/need`, {
                expectedVersion: 4,
                unit: 'pacote',
            })
            .expect(200);
        const first = (
            await f.b
                .post(corrections, { expectedVersion: 5, quantity: '1' })
                .expect(200)
        ).body;
        expect(first).toMatchObject({
            id: list.id,
            version: 6,
            item: {
                purchasedQuantity: '3',
                remainingQuantity: '1',
                status: 'PARTIALLY_PURCHASED',
            },
            purchase: { ...records[0], quantity: '2', effectiveQuantity: '1' },
            correction: {
                listId: list.id,
                itemId: item.id,
                purchaseId: records[0].id,
                previousQuantity: '2',
                quantity: '1',
                unit: 'kg',
                sequence: 6,
                correctedBy: {
                    personId: f.b.context.person.id,
                    memberId: f.mb,
                },
                correctedAt: '2026-10-18T14:00:00.000Z',
            },
        });
        const zero = (
            await f.a
                .post(corrections, { expectedVersion: 6, quantity: '0' })
                .expect(200)
        ).body;
        expect(zero).toMatchObject({
            version: 7,
            item: { purchasedQuantity: '2', remainingQuantity: '2' },
            correction: {
                previousQuantity: '1',
                quantity: '0',
                sequence: 7,
                correctedBy: { personId: f.a.context.person.id },
            },
        });
        const read = (await f.a.agent.get(purchases).expect(200)).body.items;
        expect(read).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    ...records[0],
                    quantity: '2',
                    effectiveQuantity: '0',
                }),
                expect.objectContaining({ ...second, effectiveQuantity: '2' }),
            ]),
        );
        const history = (
            await f.a.agent.get(`${base}/${list.id}/history`).expect(200)
        ).body.items;
        expect(
            history.filter(
                (event: { type: string }) =>
                    event.type === 'PURCHASE_CORRECTED',
            ),
        ).toMatchObject([
            {
                sequence: 6,
                actor: { personId: f.b.context.person.id },
                data: {
                    itemId: item.id,
                    purchaseId: records[0].id,
                    correction: { previousQuantity: '2', quantity: '1' },
                },
            },
            {
                sequence: 7,
                actor: { personId: f.a.context.person.id },
                data: { correction: { previousQuantity: '1', quantity: '0' } },
            },
        ]);
        const added = (
            await f.b
                .post(purchases, { expectedVersion: 7, quantity: '0.5' })
                .expect(201)
        ).body;
        expect(added.item).toMatchObject({
            purchasedQuantity: '2.5',
            remainingQuantity: '1.5',
        });
    });

    it('allows excess correction and uses corrected totals when changing the desired need', async () => {
        const { b, corrections, path, item } = await personalRecords();
        const excess = (
            await b
                .post(corrections, { expectedVersion: 4, quantity: '5' })
                .expect(200)
        ).body;
        expect(excess.item).toMatchObject({
            purchasedQuantity: '7',
            remainingQuantity: '0',
            status: 'PURCHASED',
        });
        await b
            .post(corrections, { expectedVersion: 5, quantity: '0.5' })
            .expect(200);
        const reduced = (
            await b
                .post(`${path}/${item.id}/need`, {
                    expectedVersion: 6,
                    desiredQuantity: '2.5',
                })
                .expect(200)
        ).body;
        expect(reduced.item).toMatchObject({
            desiredQuantity: '2.5',
            purchasedQuantity: '2.5',
            remainingQuantity: '0',
            status: 'PURCHASED',
        });
        const before = await shoppingSnapshot(db);
        await b
            .post(`${path}/${item.id}/need`, {
                expectedVersion: 7,
                desiredQuantity: '2.499',
            })
            .expect(409);
        expect(await shoppingSnapshot(db)).toEqual(before);
    });

    it('substitutes effective quantities instead of accumulating corrections and rejects total overflow', async () => {
        const { b, corrections, purchases } = await personalRecords([
            '2',
            '0.001',
        ]);
        const fractional = (
            await b
                .post(corrections, { expectedVersion: 4, quantity: '0.100' })
                .expect(200)
        ).body;
        expect(fractional.item).toMatchObject({
            purchasedQuantity: '0.101',
            remainingQuantity: '3.899',
        });
        await b
            .post(corrections, {
                expectedVersion: 5,
                quantity: '999999999999.998',
            })
            .expect(200);
        const before = await shoppingSnapshot(db);
        await b
            .post(corrections, {
                expectedVersion: 6,
                quantity: '999999999999.999',
            })
            .expect(400);
        await b
            .post(purchases, { expectedVersion: 6, quantity: '0.001' })
            .expect(400);
        expect(await shoppingSnapshot(db)).toEqual(before);
        expect((await b.agent.get(purchases).expect(200)).body.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    quantity: '2',
                    effectiveQuantity: '999999999999.998',
                }),
            ]),
        );
    });

    it('replays the exact correction after a later correction and rejects a key reused for another payload or record', async () => {
        const { b, purchases, records, corrections } = await personalRecords(),
            key = randomUUID(),
            input = { expectedVersion: 4, quantity: '1' };
        const pair = await Promise.all([
            b.post(corrections, input, key),
            b.post(corrections, input, key),
        ]);
        expect(pair.map((r) => r.status)).toEqual([200, 200]);
        expect(pair[0].body).toEqual(pair[1].body);
        await b
            .post(corrections, { expectedVersion: 5, quantity: '0' })
            .expect(200);
        const before = await shoppingSnapshot(db);
        expect(
            (await b.post(corrections, input, key).expect(200)).body,
        ).toEqual(pair[0].body);
        await b
            .post(corrections, { ...input, quantity: '1.5' }, key)
            .expect(409);
        await b
            .post(`${purchases}/${records[1].id}/corrections`, input, key)
            .expect(409);
        expect(await shoppingSnapshot(db)).toEqual(before);
        expect(
            (await b.agent.get(corrections).expect(200)).body.totalCount,
        ).toBe(2);
    });

    it('serializes competing corrections and a concurrent new purchase on the list root version', async () => {
        const { b, corrections, purchases, path, item } =
            await personalRecords();
        const sameRecord = await Promise.all([
            b.post(corrections, { expectedVersion: 4, quantity: '1' }),
            b.post(corrections, { expectedVersion: 4, quantity: '0' }),
        ]);
        expect(sameRecord.map((r) => r.status).sort()).toEqual([200, 409]);
        const next = await Promise.all([
            b.post(corrections, { expectedVersion: 5, quantity: '0.5' }),
            b.post(purchases, { expectedVersion: 5, quantity: '0.5' }),
        ]);
        expect(next.filter((r) => r.status === 409)).toHaveLength(1);
        const winner = next.find((r) => r.status === 200 || r.status === 201)!;
        expect(winner.body.version).toBe(6);
        expect(
            (await b.agent.get(`${path}/${item.id}`).expect(200)).body,
        ).toMatchObject({ version: 6, item: winner.body.item });
        expect(
            (await b.agent.get(corrections).expect(200)).body.totalCount,
        ).toBe(winner.status === 200 ? 2 : 1);
        expect((await b.agent.get(purchases).expect(200)).body.totalCount).toBe(
            winner.status === 201 ? 3 : 2,
        );
    });

    it('validates corrections as non-negative exact decimals without changing the original record', async () => {
        const { b, corrections } = await personalRecords(),
            before = await shoppingSnapshot(db);
        for (const quantity of [
            '-1',
            '0.0001',
            '1000000000000',
            '1e3',
            0,
            null,
        ])
            await b
                .post(corrections, { expectedVersion: 4, quantity })
                .expect(400);
        await b.post(corrections, { quantity: '0' }).expect(400);
        expect(await shoppingSnapshot(db)).toEqual(before);
    });

    it('paginates correction history with actor and purchase scoped cursors and makes no writes on GET', async () => {
        const f = await sharedFinance(app),
            { base, list, purchases, records, corrections } = await recordsFor(
                f.a,
                f.space,
            );
        for (let i = 0; i < 3; i++)
            await f.a
                .post(corrections, {
                    expectedVersion: 4 + i,
                    quantity: String(i),
                })
                .expect(200);
        const before = await shoppingSnapshot(db),
            first = (await f.a.agent.get(`${corrections}?limit=2`).expect(200))
                .body,
            second = (
                await f.a.agent
                    .get(`${corrections}?limit=2&cursor=${first.nextCursor}`)
                    .expect(200)
            ).body;
        expect(first).toMatchObject({
            id: list.id,
            version: 7,
            purchaseId: records[0].id,
            totalCount: 3,
        });
        expect(
            [...first.items, ...second.items].map(
                (fact: { sequence: number }) => fact.sequence,
            ),
        ).toEqual([5, 6, 7]);
        expect(second.nextCursor).toBeNull();
        await f.a.agent
            .get(
                `${purchases}/${records[1].id}/corrections?cursor=${first.nextCursor}`,
            )
            .expect(400);
        await f.b.agent
            .get(`${corrections}?cursor=${first.nextCursor}`)
            .expect(400);
        await f.a.agent.get(`${base}/${list.id}/history`).expect(200);
        await f.a.agent.get(purchases).expect(200);
        expect(await shoppingSnapshot(db)).toEqual(before);
    });

    it('rejects cross-space, cross-list, cross-item and unknown purchase identifiers', async () => {
        const { b, base, list, path, purchases, records, corrections } =
                await personalRecords(),
            outsider = await financeBrowser(app),
            otherList = (await b.post(base, {}).expect(201)).body,
            otherItem = (
                await b
                    .post(path, {
                        expectedVersion: 4,
                        description: 'Outro',
                        desiredQuantity: '1',
                    })
                    .expect(201)
            ).body.item,
            before = await shoppingSnapshot(db);
        const badPaths = [
            `${base}/${otherList.id}/items/${otherItem.id}/purchases/${records[0].id}/corrections`,
            `${path}/${otherItem.id}/purchases/${records[0].id}/corrections`,
            `${purchases}/${randomUUID()}/corrections`,
        ];
        for (const wrong of badPaths) {
            await b.agent.get(wrong).expect(404);
            await b
                .post(wrong, {
                    expectedVersion: wrong.includes(otherList.id) ? 1 : 5,
                    quantity: '0',
                })
                .expect(404);
        }
        await outsider.agent.get(corrections).expect(404);
        await outsider
            .post(corrections, { expectedVersion: 5, quantity: '0' })
            .expect(404);
        await outsider.agent
            .get(
                `/v2/spaces/${outsider.context.personalSpace.id}/shopping-lists/${list.id}/items/${otherItem.id}/purchases/${records[0].id}/corrections`,
            )
            .expect(404);
        expect(await shoppingSnapshot(db)).toEqual(before);
    });

    it('reads root, summary and effective quantities on one snapshot during a concurrent correction', async () => {
        const { b, base, list, purchases, records } = await personalRecords(),
            store = app.get<ShoppingStore>(SHOPPING_STORE),
            find = store.find.bind(store),
            provider = app.get(EntityManagerProvider);
        vi.spyOn(store, 'find').mockImplementationOnce(async (...args) => {
            const original = await find(...args),
                manager = provider.get();
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
                    'INSERT INTO shopping_purchase_corrections(id,space_id,list_id,item_id,purchase_id,previous_quantity,quantity,unit,sequence,corrected_by_person_id,corrected_by_member_id,corrected_by_display_name,corrected_at) SELECT gen_random_uuid(),space_id,list_id,item_id,id,quantity,0,unit,5,registered_by_person_id,registered_by_member_id,registered_by_display_name,now() FROM shopping_purchase_records WHERE id=$1',
                    [records[0].id],
                );
            });
            return original;
        });
        const before = (await b.agent.get(`${base}/${list.id}`).expect(200))
            .body;
        expect(before).toMatchObject({
            version: 4,
            summary: { purchasedItemCount: 1, actionableItemCount: 0 },
        });
        expect(before.items.items[0]).toMatchObject({
            purchasedQuantity: '4',
            remainingQuantity: '0',
            status: 'PURCHASED',
        });
        vi.restoreAllMocks();
        const after = (await b.agent.get(`${base}/${list.id}`).expect(200))
            .body;
        expect(after).toMatchObject({
            version: 5,
            summary: {
                purchasedItemCount: 0,
                partiallyPurchasedItemCount: 1,
                actionableItemCount: 1,
            },
        });
        expect(after.items.items[0]).toMatchObject({
            purchasedQuantity: '2',
            remainingQuantity: '2',
            status: 'PARTIALLY_PURCHASED',
        });
        expect((await b.agent.get(purchases).expect(200)).body.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: records[0].id,
                    quantity: '2',
                    effectiveQuantity: '0',
                }),
            ]),
        );
    });

    it.each(['shopping_history', 'shopping_command_audit'])(
        'rolls back correction facts, aggregate version, progress and receipt when %s fails',
        async (table) => {
            const { b, corrections } = await personalRecords(),
                before = await shoppingSnapshot(db);
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            await db.query(
                `ALTER TABLE ${table} ADD CONSTRAINT test_reject_correction CHECK (false) NOT VALID`,
            );
            try {
                await b
                    .post(corrections, { expectedVersion: 4, quantity: '1' })
                    .expect(500);
                expect(await shoppingSnapshot(db)).toEqual(before);
            } finally {
                await db.query(
                    `ALTER TABLE ${table} DROP CONSTRAINT test_reject_correction`,
                );
            }
        },
    );

    it('reapplies an empty correction migration and protects correction history from rollback', async () => {
        await migrationSource.initialize();
        try {
            await rewindFinanceMigrationsTo(
                migrationSource,
                'ShoppingPurchaseCorrections1792345722826',
            );
            await migrationSource.undoLastMigration();
            expect(
                (
                    await db.query(
                        "SELECT to_regclass('public.shopping_purchase_corrections') AS name",
                    )
                )[0].name,
            ).toBeNull();
            await migrationSource.runMigrations();
            const { b, corrections } = await personalRecords();
            await b
                .post(corrections, { expectedVersion: 4, quantity: '0' })
                .expect(200);
            await rewindFinanceMigrationsTo(
                migrationSource,
                'ShoppingPurchaseCorrections1792345722826',
            );
            const before = await shoppingSnapshot(db);
            await expect(migrationSource.undoLastMigration()).rejects.toThrow(
                /histórico/i,
            );
            expect(await shoppingSnapshot(db)).toEqual(before);
        } finally {
            await migrationSource.runMigrations();
            await migrationSource.destroy();
        }
    });
});
