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
import { financeBrowser, sharedFinance } from './settlement-fixture.js';
import {
    prepareShoppingDatabase,
    shoppingApp,
    shoppingSnapshot,
} from './shopping-fixture.js';
import { createApiOpenApiDocument } from '../dist/composition/http/create-api-openapi-document.js';

describe('shopping item needs HTTP/PostgreSQL', () => {
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
    async function personalList() {
        const b = await financeBrowser(app),
            base = `/v2/spaces/${b.context.personalSpace.id}/shopping-lists`,
            list = (await b.post(base, {}).expect(201)).body;
        return { b, base, path: `${base}/${list.id}/items`, list };
    }

    it('stores exact fractional needs, trims informative units and preserves the personal creator', async () => {
        const { b, path, list } = await personalList();
        const added = (
            await b
                .post(path, {
                    expectedVersion: 1,
                    description: '  Arroz  ',
                    desiredQuantity: '1.250',
                    unit: '  kg  ',
                })
                .expect(201)
        ).body;
        expect(added).toMatchObject({
            id: list.id,
            version: 2,
            item: {
                listId: list.id,
                description: 'Arroz',
                desiredQuantity: '1.25',
                unit: 'kg',
                purchasedQuantity: '0',
                remainingQuantity: '1.25',
                status: 'PENDING',
                creator: { personId: b.context.person.id, memberId: null },
                createdAt: '2026-10-18T14:00:00.000Z',
            },
        });
        await b
            .post(path, {
                expectedVersion: 2,
                description: 'Quantidade mínima',
                desiredQuantity: '0.001',
            })
            .expect(201);
        const maximum = (
            await b
                .post(path, {
                    expectedVersion: 3,
                    description: 'Quantidade máxima',
                    desiredQuantity: '999999999999.999',
                })
                .expect(201)
        ).body;
        expect(maximum.item).toMatchObject({
            desiredQuantity: '999999999999.999',
            remainingQuantity: '999999999999.999',
            unit: null,
        });
        const detail = await b.agent
            .get(`${path}/${added.item.id}`)
            .expect(200);
        expect(detail.headers['cache-control']).toBe('no-store');
        expect(detail.body).toMatchObject({
            id: list.id,
            version: 4,
            item: added.item,
        });
    });

    it('changes a need across members and records the actor without replacing the creator', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}/shopping-lists`,
            list = (await f.a.post(base, {}).expect(201)).body,
            path = `${base}/${list.id}/items`;
        const added = (
            await f.a
                .post(path, {
                    expectedVersion: 1,
                    description: 'Leite',
                    desiredQuantity: '1.5',
                    unit: 'litro',
                })
                .expect(201)
        ).body;
        const changed = (
            await f.b
                .post(`${path}/${added.item.id}/need`, {
                    expectedVersion: 2,
                    desiredQuantity: '2.75',
                    unit: null,
                })
                .expect(200)
        ).body;
        expect(changed).toMatchObject({
            id: list.id,
            version: 3,
            item: {
                ...added.item,
                desiredQuantity: '2.75',
                remainingQuantity: '2.75',
                unit: null,
            },
        });
        await f.b
            .post(`${path}/${added.item.id}/need`, {
                expectedVersion: 3,
                unit: 'caixa',
            })
            .expect(200);
        const history = (
            await f.a.agent.get(`${base}/${list.id}/history`).expect(200)
        ).body.items;
        expect(history).toMatchObject([
            { type: 'CREATED', sequence: 1 },
            {
                type: 'ITEM_ADDED',
                sequence: 2,
                actor: { personId: f.a.context.person.id, memberId: f.ma },
            },
            {
                type: 'ITEM_NEED_CHANGED',
                sequence: 3,
                actor: { personId: f.b.context.person.id, memberId: f.mb },
                data: {
                    itemId: added.item.id,
                    before: { desiredQuantity: '1.5', unit: 'litro' },
                    after: { desiredQuantity: '2.75', unit: null },
                },
            },
            { type: 'ITEM_NEED_CHANGED', sequence: 4 },
        ]);
        expect(
            (await f.a.agent.get(`${path}/${added.item.id}`).expect(200)).body
                .item,
        ).toMatchObject({
            creator: added.item.creator,
            desiredQuantity: '2.75',
            unit: 'caixa',
        });
    });

    it('keeps duplicate descriptions independent and replays only the same command', async () => {
        const { b, base, path, list } = await personalList(),
            key = randomUUID(),
            input = {
                expectedVersion: 1,
                description: 'Pão',
                desiredQuantity: '2',
            };
        const pair = await Promise.all([
            b.post(path, input, key),
            b.post(path, input, key),
        ]);
        expect(pair.map((r) => r.status)).toEqual([201, 201]);
        expect(pair[0].body).toEqual(pair[1].body);
        const duplicate = (
            await b.post(path, { ...input, expectedVersion: 2 }).expect(201)
        ).body;
        expect(duplicate.item.id).not.toBe(pair[0].body.item.id);
        const before = await shoppingSnapshot(db);
        expect((await b.post(path, input, key).expect(201)).body).toEqual(
            pair[0].body,
        );
        await b.post(path, { ...input, desiredQuantity: '3' }, key).expect(409);
        expect(await shoppingSnapshot(db)).toEqual(before);
        const other = (await b.post(base, {}).expect(201)).body;
        await b.post(`${base}/${other.id}/items`, input, key).expect(409);
        const page = (await b.agent.get(path).expect(200)).body;
        expect(page).toMatchObject({ id: list.id, version: 3, totalCount: 2 });
    });

    it('uses the list root version for competing changes on different items', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}/shopping-lists`,
            list = (await f.a.post(base, {}).expect(201)).body,
            path = `${base}/${list.id}/items`;
        const first = (
            await f.a
                .post(path, {
                    expectedVersion: 1,
                    description: 'A',
                    desiredQuantity: '1',
                })
                .expect(201)
        ).body.item;
        const second = (
            await f.a
                .post(path, {
                    expectedVersion: 2,
                    description: 'B',
                    desiredQuantity: '2',
                })
                .expect(201)
        ).body.item;
        const responses = await Promise.all([
            f.a.post(`${path}/${first.id}/need`, {
                expectedVersion: 3,
                desiredQuantity: '3',
            }),
            f.b.post(`${path}/${second.id}/need`, {
                expectedVersion: 3,
                desiredQuantity: '4',
            }),
        ]);
        expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(responses.find((r) => r.status === 409)!.body.code).toBe(
            'CONCURRENT_MODIFICATION',
        );
        const winner = responses.find((r) => r.status === 200)!.body.item,
            page = (await f.a.agent.get(path).expect(200)).body;
        expect(page.version).toBe(4);
        expect(page.items).toHaveLength(2);
        expect(
            page.items.find((item: { id: string }) => item.id === winner.id),
        ).toMatchObject(winner);
        const unchanged = winner.id === first.id ? second : first;
        expect(
            page.items.find((item: { id: string }) => item.id === unchanged.id),
        ).toMatchObject(unchanged);
        expect(
            (await f.a.agent.get(`${base}/${list.id}/history`).expect(200)).body
                .items,
        ).toHaveLength(4);
    });

    it('rejects invalid quantity syntax, scale, range and text bounds with no partial write', async () => {
        const { b, path } = await personalList(),
            before = await shoppingSnapshot(db);
        for (const desiredQuantity of [
            '0',
            '-1',
            '0.000',
            '0.0001',
            '1.2345',
            '1000000000000',
            '1e3',
            '1,5',
            'NaN',
            ' 1 ',
            1,
            null,
        ]) {
            const response = await b
                .post(path, {
                    expectedVersion: 1,
                    description: 'Inválida',
                    desiredQuantity,
                })
                .expect(400);
            expect(response.body).toMatchObject({
                code: 'VALIDATION_ERROR',
                message: 'Verifique os dados informados.',
            });
            expect(response.body.details.fields).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ field: 'desiredQuantity' }),
                ]),
            );
        }
        for (const invalid of [
            { description: '' },
            { description: ' ' },
            { description: 'x'.repeat(501) },
            { unit: '' },
            { unit: ' ' },
            { unit: 'x'.repeat(31) },
            { unit: 1 },
            { expectedVersion: 0 },
            { expectedVersion: 1.5 },
            { creator: 'forged' },
        ])
            await b
                .post(path, {
                    expectedVersion: 1,
                    description: 'Válida',
                    desiredQuantity: '1',
                    ...invalid,
                })
                .expect(400);
        expect(await shoppingSnapshot(db)).toEqual(before);
    });

    it('validates an empty need patch, preserves omitted fields and replays the exact result', async () => {
        const { b, path } = await personalList();
        const added = (
                await b
                    .post(path, {
                        expectedVersion: 1,
                        description: 'x'.repeat(500),
                        desiredQuantity: '0.125',
                        unit: 'u'.repeat(30),
                    })
                    .expect(201)
            ).body,
            needPath = `${path}/${added.item.id}/need`,
            before = await shoppingSnapshot(db);
        for (const input of [
            { expectedVersion: 2 },
            { expectedVersion: 2, desiredQuantity: '0' },
            { expectedVersion: 2, unit: '' },
            { desiredQuantity: '1' },
        ])
            await b.post(needPath, input).expect(400);
        expect(await shoppingSnapshot(db)).toEqual(before);
        const key = randomUUID(),
            input = { expectedVersion: 2, desiredQuantity: '0.75' },
            changed = (await b.post(needPath, input, key).expect(200)).body;
        expect(changed.item).toMatchObject({
            desiredQuantity: '0.75',
            unit: added.item.unit,
        });
        await b.post(needPath, { expectedVersion: 3, unit: null }).expect(200);
        const final = await shoppingSnapshot(db);
        expect((await b.post(needPath, input, key).expect(200)).body).toEqual(
            changed,
        );
        await b
            .post(needPath, { ...input, desiredQuantity: '1' }, key)
            .expect(409);
        expect(await shoppingSnapshot(db)).toEqual(final);
    });

    it('keeps global summaries across pages, scopes item cursors and performs no writes on GET', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}/shopping-lists`,
            list = (await f.a.post(base, {}).expect(201)).body,
            path = `${base}/${list.id}/items`;
        for (let i = 0; i < 3; i++)
            await f.a
                .post(path, {
                    expectedVersion: i + 1,
                    description: `Item ${i}`,
                    desiredQuantity: '1',
                })
                .expect(201);
        const other = (await f.a.post(base, {}).expect(201)).body,
            before = await shoppingSnapshot(db),
            first = (await f.a.agent.get(`${path}?limit=2`).expect(200)).body,
            second = (
                await f.a.agent
                    .get(`${path}?limit=2&cursor=${first.nextCursor}`)
                    .expect(200)
            ).body,
            summary = {
                activeItemCount: 3,
                pendingItemCount: 3,
                partiallyPurchasedItemCount: 0,
                purchasedItemCount: 0,
                actionableItemCount: 3,
                isComplete: false,
                canSuggestArchival: false,
            };
        expect(first).toMatchObject({
            id: list.id,
            version: 4,
            totalCount: 3,
            summary,
        });
        expect(first.items).toHaveLength(2);
        expect(second).toMatchObject({
            totalCount: 3,
            summary,
            nextCursor: null,
        });
        expect(
            new Set(
                [...first.items, ...second.items].map(
                    (item: { id: string }) => item.id,
                ),
            ).size,
        ).toBe(3);
        expect(
            (await f.a.agent.get(`${base}/${list.id}`).expect(200)).body,
        ).toMatchObject({ summary, items: { totalCount: 3 } });
        const lists = (await f.a.agent.get(base).expect(200)).body.items;
        expect(
            lists.find((item: { id: string }) => item.id === list.id),
        ).toMatchObject({ summary });
        for (const invalidPath of [
            `${path}?status=PENDING&cursor=${first.nextCursor}`,
            `${base}/${other.id}/items?cursor=${first.nextCursor}`,
            `${path}?cursor=invalid`,
            `${path}?limit=101`,
        ])
            await f.a.agent.get(invalidPath).expect(400);
        await f.b.agent.get(`${path}?cursor=${first.nextCursor}`).expect(400);
        expect(
            (await f.a.agent.get(`${path}?status=PURCHASED`).expect(200)).body
                .items,
        ).toEqual([]);
        expect(await shoppingSnapshot(db)).toEqual(before);
    });

    it('rejects cross-space and cross-list item access for queries and commands', async () => {
        const { b, base, path } = await personalList(),
            outsider = await financeBrowser(app),
            other = (await b.post(base, {}).expect(201)).body;
        const added = (
                await b
                    .post(path, {
                        expectedVersion: 1,
                        description: 'Privada',
                        desiredQuantity: '1',
                    })
                    .expect(201)
            ).body,
            before = await shoppingSnapshot(db);
        await outsider.agent.get(path).expect(404);
        await outsider.agent.get(`${path}/${added.item.id}`).expect(404);
        await outsider
            .post(`${path}/${added.item.id}/need`, {
                expectedVersion: 2,
                unit: 'kg',
            })
            .expect(404);
        await b.agent
            .get(`${base}/${other.id}/items/${added.item.id}`)
            .expect(404);
        await b
            .post(`${base}/${other.id}/items/${added.item.id}/need`, {
                expectedVersion: 1,
                unit: 'kg',
            })
            .expect(404);
        const outsiderPath = `/v2/spaces/${outsider.context.personalSpace.id}/shopping-lists`;
        await outsider.agent
            .get(`${outsiderPath}/${added.id}/items/${added.item.id}`)
            .expect(404);
        expect(await shoppingSnapshot(db)).toEqual(before);
    });

    it.each(['shopping_history', 'shopping_command_audit'])(
        'rolls back item additions and need changes when %s rejects a new fact',
        async (table) => {
            const { b, path } = await personalList();
            const added = (
                    await b
                        .post(path, {
                            expectedVersion: 1,
                            description: 'Original',
                            desiredQuantity: '1',
                        })
                        .expect(201)
                ).body,
                before = await shoppingSnapshot(db);
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            await db.query(
                `ALTER TABLE ${table} ADD CONSTRAINT test_reject_item CHECK (false) NOT VALID`,
            );
            try {
                await b
                    .post(path, {
                        expectedVersion: 2,
                        description: 'Rollback',
                        desiredQuantity: '2',
                    })
                    .expect(500);
                expect(await shoppingSnapshot(db)).toEqual(before);
                await b
                    .post(`${path}/${added.item.id}/need`, {
                        expectedVersion: 2,
                        desiredQuantity: '2',
                    })
                    .expect(500);
                expect(await shoppingSnapshot(db)).toEqual(before);
            } finally {
                await db.query(
                    `ALTER TABLE ${table} DROP CONSTRAINT test_reject_item`,
                );
            }
        },
    );

    it('registers item contracts in executable OpenAPI', () => {
        const doc = createApiOpenApiDocument(false),
            base = '/v2/spaces/{spaceId}/shopping-lists/{listId}/items';
        expect(doc.paths[base]?.post).toBeDefined();
        expect(doc.paths[base]?.get).toBeDefined();
        expect(doc.paths[`${base}/{itemId}`]?.get).toBeDefined();
        expect(doc.paths[`${base}/{itemId}/need`]?.post).toBeDefined();
    });
});
