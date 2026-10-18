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
import { EntityManagerProvider } from '../dist/shared/technical/database/typeorm/entity-manager.provider.js';
import { createApiOpenApiDocument } from '../dist/composition/http/create-api-openapi-document.js';
import {
    SPACE_PARTICIPANTS_PORT,
    type SpaceParticipantsPort,
} from '../dist/modules/spaces/application/ports/public/space-participants.port.js';
import { SpacesDomainError } from '../dist/modules/spaces/domain/errors/spaces-domain.error.js';
import {
    SHOPPING_STORE,
    type ShoppingStore,
} from '../dist/modules/shopping/application/shopping-store.js';
import migrationSource from '../dist/shared/technical/database/typeorm/data-source.js';

describe('CARD-038 shopping lists HTTP/PostgreSQL', () => {
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

    it('creates personal lists with optional names, permits duplicate names and reads an empty detail', async () => {
        const b = await financeBrowser(app),
            base = `/v2/spaces/${b.context.personalSpace.id}/shopping-lists`;
        for (const input of [{}, { name: null }]) {
            const list = (await b.post(base, input).expect(201)).body;
            expect(list).toMatchObject({
                name: null,
                status: 'ACTIVE',
                version: 1,
                creator: { personId: b.context.person.id, memberId: null },
                createdAt: '2026-10-18T14:00:00.000Z',
            });
        }
        const named = (await b.post(base, { name: '  Feira  ' }).expect(201))
            .body;
        await b.post(base, { name: 'Feira' }).expect(201);
        expect(named.name).toBe('Feira');
        const detail = await b.agent.get(`${base}/${named.id}`).expect(200);
        expect(detail.headers['cache-control']).toBe('no-store');
        expect(detail.body).toMatchObject({
            id: named.id,
            summary: {
                activeItemCount: 0,
                pendingItemCount: 0,
                partiallyPurchasedItemCount: 0,
                purchasedItemCount: 0,
                actionableItemCount: 0,
                isComplete: true,
                canSuggestArchival: false,
            },
            items: { items: [], nextCursor: null },
        });
        expect((await b.agent.get(base).expect(200)).body.items).toHaveLength(
            4,
        );
    });

    it('lets either active member rename while preserving creator and recording the actor', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}/shopping-lists`;
        const list = (await f.a.post(base, { name: 'Mercado' }).expect(201))
            .body;
        expect(list.creator).toMatchObject({
            personId: f.a.context.person.id,
            memberId: f.ma,
        });
        const changed = (
            await f.b
                .post(`${base}/${list.id}/name`, {
                    expectedVersion: 1,
                    name: '  Semana  ',
                })
                .expect(200)
        ).body;
        expect(changed).toMatchObject({
            name: 'Semana',
            version: 2,
            creator: list.creator,
        });
        const events = (
            await f.a.agent.get(`${base}/${list.id}/history`).expect(200)
        ).body.items;
        expect(events).toMatchObject([
            {
                sequence: 1,
                type: 'CREATED',
                actor: { personId: f.a.context.person.id, memberId: f.ma },
            },
            {
                sequence: 2,
                type: 'RENAMED',
                actor: { personId: f.b.context.person.id, memberId: f.mb },
            },
        ]);
        await f.b
            .post(`${base}/${list.id}/name`, { expectedVersion: 2, name: null })
            .expect(200);
        expect(
            (await f.a.agent.get(`${base}/${list.id}`).expect(200)).body.name,
        ).toBeNull();
    });

    it('replays concurrent creation once and rejects key reuse across payload or destination', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}/shopping-lists`,
            key = randomUUID(),
            input = { name: 'Uma só' };
        const pair = await Promise.all([
            f.a.post(base, input, key),
            f.a.post(base, input, key),
        ]);
        expect(pair.map((r) => r.status)).toEqual([201, 201]);
        expect(pair[0].body).toEqual(pair[1].body);
        const before = await shoppingSnapshot(db);
        await f.a.post(base, { name: 'Outra' }, key).expect(409);
        await f.a
            .post(
                `/v2/spaces/${f.a.context.personalSpace.id}/shopping-lists`,
                input,
                key,
            )
            .expect(409);
        expect(await shoppingSnapshot(db)).toEqual(before);
        for (const table of [
            'shopping_lists',
            'shopping_history',
            'shopping_command_receipts',
            'shopping_command_audit',
        ])
            expect((await db.query(`SELECT * FROM ${table}`)).length).toBe(1);
    });

    it('replays a rename after another change but rejects a key reused for another list', async () => {
        const b = await financeBrowser(app),
            base = `/v2/spaces/${b.context.personalSpace.id}/shopping-lists`;
        const list = (await b.post(base, {}).expect(201)).body,
            other = (await b.post(base, {}).expect(201)).body,
            key = randomUUID(),
            input = { expectedVersion: 1, name: 'Primeiro nome' };
        const changed = (
            await b.post(`${base}/${list.id}/name`, input, key).expect(200)
        ).body;
        await b
            .post(`${base}/${list.id}/name`, {
                expectedVersion: 2,
                name: 'Nome atual',
            })
            .expect(200);
        const before = await shoppingSnapshot(db);
        expect(
            (await b.post(`${base}/${list.id}/name`, input, key).expect(200))
                .body,
        ).toEqual(changed);
        await b.post(`${base}/${other.id}/name`, input, key).expect(409);
        expect(await shoppingSnapshot(db)).toEqual(before);
        expect(
            (await b.agent.get(`${base}/${list.id}`).expect(200)).body,
        ).toMatchObject({ version: 3, name: 'Nome atual' });
    });

    it('allows one of two competing renames at the same root version', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}/shopping-lists`;
        const list = (await f.a.post(base, {}).expect(201)).body;
        const responses = await Promise.all([
            f.a.post(`${base}/${list.id}/name`, {
                expectedVersion: 1,
                name: 'A',
            }),
            f.b.post(`${base}/${list.id}/name`, {
                expectedVersion: 1,
                name: 'B',
            }),
        ]);
        expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(responses.find((r) => r.status === 409)!.body.code).toBe(
            'CONCURRENT_MODIFICATION',
        );
        expect((await db.query('SELECT * FROM shopping_history')).length).toBe(
            2,
        );
        expect(
            (await db.query('SELECT * FROM shopping_command_audit')).length,
        ).toBe(2);
    });

    it('isolates spaces and checks current membership before replay', async () => {
        const f = await sharedFinance(app),
            outsider = await financeBrowser(app),
            base = `/v2/spaces/${f.space}/shopping-lists`,
            key = randomUUID();
        const list = (
            await f.b.post(base, { name: 'Restrita' }, key).expect(201)
        ).body;
        const before = await shoppingSnapshot(db);
        await outsider.agent.get(base).expect(404);
        await outsider.agent.get(`${base}/${list.id}`).expect(404);
        await outsider.agent.get(`${base}/${list.id}/history`).expect(404);
        await outsider
            .post(`${base}/${list.id}/name`, {
                expectedVersion: 1,
                name: 'Inválido',
            })
            .expect(404);
        await f.a.agent
            .get(
                `/v2/spaces/${f.a.context.personalSpace.id}/shopping-lists/${list.id}`,
            )
            .expect(404);
        await db.query(
            'ALTER TABLE space_members DROP CONSTRAINT "CHK_space_members_status"',
        );
        try {
            await db.query(
                "UPDATE space_members SET status='INACTIVE' WHERE id=$1",
                [f.mb],
            );
            await f.b.agent.get(base).expect(404);
            await f.b.post(base, { name: 'Restrita' }, key).expect(404);
            expect(await shoppingSnapshot(db)).toEqual(before);
        } finally {
            await db.query(
                "UPDATE space_members SET status='ACTIVE' WHERE id=$1",
                [f.mb],
            );
            await db.query(
                'ALTER TABLE space_members ADD CONSTRAINT "CHK_space_members_status" CHECK (status=\'ACTIVE\')',
            );
        }
    });

    it.each(['CLOSING', 'CLOSED'])(
        'keeps authorized reads but blocks commands and replay in %s',
        async (status) => {
            const f = await sharedFinance(app),
                base = `/v2/spaces/${f.space}/shopping-lists`,
                key = randomUUID();
            const list = (await f.a.post(base, {}, key).expect(201)).body;
            await db.query('UPDATE spaces SET status=$1 WHERE id=$2', [
                status,
                f.space,
            ]);
            const before = await shoppingSnapshot(db);
            await f.a.agent.get(base).expect(200);
            await f.b.agent.get(`${base}/${list.id}`).expect(200);
            await f.a.agent.get(`${base}/${list.id}/history`).expect(200);
            await f.a.post(base, {}).expect(409);
            await f.a.post(base, {}, key).expect(409);
            await f.a
                .post(`${base}/${list.id}/name`, {
                    expectedVersion: 1,
                    name: 'Novo',
                })
                .expect(409);
            expect(await shoppingSnapshot(db)).toEqual(before);
        },
    );

    it.each([
        { name: '' },
        { name: ' ' },
        { name: 'x'.repeat(121) },
        { name: 1 },
        { creator: 'forged' },
        null,
    ])('returns field-level Portuguese validation for %j', async (input) => {
        const b = await financeBrowser(app);
        const response = await b
            .post(
                `/v2/spaces/${b.context.personalSpace.id}/shopping-lists`,
                input as unknown as object,
            )
            .expect(400);
        expect(response.body).toMatchObject({
            code: 'VALIDATION_ERROR',
            message: 'Verifique os dados informados.',
        });
        expect(response.body.details.fields[0].field).toBeTruthy();
    });

    it('validates rename versions and query bounds without mutation', async () => {
        const b = await financeBrowser(app),
            base = `/v2/spaces/${b.context.personalSpace.id}/shopping-lists`;
        const list = (await b.post(base, { name: 'x'.repeat(120) }).expect(201))
                .body,
            before = await shoppingSnapshot(db);
        for (const input of [
            { name: 'Nome' },
            { expectedVersion: 0, name: 'Nome' },
            { expectedVersion: 1.5, name: 'Nome' },
            { expectedVersion: 1 },
            { expectedVersion: 1, name: ' ' },
        ])
            await b.post(`${base}/${list.id}/name`, input).expect(400);
        for (const query of [
            'limit=0',
            'limit=101',
            'limit=1.5',
            'status=PENDING',
            'cursor=invalid',
        ])
            await b.agent.get(`${base}?${query}`).expect(400);
        expect(await shoppingSnapshot(db)).toEqual(before);
    });

    it('paginates lists and history, binds cursors to actor, space and filters, and never writes on GET', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}/shopping-lists`;
        for (let i = 0; i < 3; i++)
            await f.a.post(base, { name: `Lista ${i}` }).expect(201);
        const before = await shoppingSnapshot(db),
            first = (await f.a.agent.get(`${base}?limit=2`).expect(200)).body,
            second = (
                await f.a.agent
                    .get(`${base}?limit=2&cursor=${first.nextCursor}`)
                    .expect(200)
            ).body;
        expect(
            new Set(
                [...first.items, ...second.items].map(
                    (list: { id: string }) => list.id,
                ),
            ).size,
        ).toBe(3);
        expect(second.nextCursor).toBeNull();
        for (const path of [
            `${base}?status=ALL&cursor=${first.nextCursor}`,
            `/v2/spaces/${f.a.context.personalSpace.id}/shopping-lists?cursor=${first.nextCursor}`,
        ])
            await f.a.agent.get(path).expect(400);
        await f.b.agent.get(`${base}?cursor=${first.nextCursor}`).expect(400);
        expect(
            (await f.a.agent.get(`${base}?status=ARCHIVED`).expect(200)).body
                .items,
        ).toEqual([]);
        await f.a.agent.get(`${base}/${first.items[0].id}`).expect(200);
        await f.a.agent.get(`${base}/${first.items[0].id}/history`).expect(200);
        expect(await shoppingSnapshot(db)).toEqual(before);
        const list = first.items[0];
        await f.a
            .post(`${base}/${list.id}/name`, {
                expectedVersion: 1,
                name: 'Renomeada',
            })
            .expect(200);
        const history = (
            await f.a.agent
                .get(`${base}/${list.id}/history?limit=1`)
                .expect(200)
        ).body;
        const next = (
            await f.a.agent
                .get(
                    `${base}/${list.id}/history?limit=1&cursor=${history.nextCursor}`,
                )
                .expect(200)
        ).body;
        expect(
            [...history.items, ...next.items].map(
                (event: { sequence: number }) => event.sequence,
            ),
        ).toEqual([1, 2]);
        expect(next.nextCursor).toBeNull();
        await f.a.agent
            .get(
                `${base}/${first.items[1].id}/history?cursor=${history.nextCursor}`,
            )
            .expect(400);
    });

    it.each(['shopping_history', 'shopping_command_audit'])(
        'rolls back list, history, receipt and audit if %s rejects persistence',
        async (table) => {
            const b = await financeBrowser(app),
                base = `/v2/spaces/${b.context.personalSpace.id}/shopping-lists`,
                before = await shoppingSnapshot(db);
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            await db.query(
                `ALTER TABLE ${table} ADD CONSTRAINT test_reject_shopping CHECK (false)`,
            );
            try {
                await b.post(base, { name: 'Rollback' }).expect(500);
                expect(await shoppingSnapshot(db)).toEqual(before);
            } finally {
                await db.query(
                    `ALTER TABLE ${table} DROP CONSTRAINT test_reject_shopping`,
                );
            }
        },
    );

    it('reads count and page in one read-only snapshot while another connection changes the list', async () => {
        const b = await financeBrowser(app),
            base = `/v2/spaces/${b.context.personalSpace.id}/shopping-lists`;
        const list = (await b.post(base, { name: 'Antes' }).expect(201)).body,
            provider = app.get(EntityManagerProvider),
            get = provider.get.bind(provider);
        let armed = true,
            changed = false;
        vi.spyOn(provider, 'get').mockImplementation(() => {
            const manager = get();
            if (armed && manager.queryRunner?.isTransactionActive) {
                armed = false;
                const query = manager.queryRunner.query.bind(
                    manager.queryRunner,
                );
                vi.spyOn(manager.queryRunner, 'query').mockImplementation(
                    async (...args) => {
                        const result = await query(...args),
                            sql = String(args[0]).toLowerCase();
                        if (
                            !changed &&
                            sql.includes('count(') &&
                            sql.includes('shopping_lists')
                        ) {
                            changed = true;
                            expect(
                                (await query('SHOW transaction_read_only'))[0]
                                    .transaction_read_only,
                            ).toBe('on');
                            await db.query(
                                "UPDATE shopping_lists SET status='ARCHIVED', archived_at=now(), version=version+1 WHERE id=$1",
                                [list.id],
                            );
                        }
                        return result;
                    },
                );
            }
            return manager;
        });
        const page = (await b.agent.get(base).expect(200)).body;
        expect(changed).toBe(true);
        expect(page.totalCount).toBe(1);
        expect(page.items).toMatchObject([{ id: list.id, status: 'ACTIVE' }]);
        vi.restoreAllMocks();
        expect((await b.agent.get(base).expect(200)).body).toMatchObject({
            items: [],
            totalCount: 0,
        });
    });

    it('revalidates current access after reading before returning a page', async () => {
        const f = await sharedFinance(app),
            store = app.get<ShoppingStore>(SHOPPING_STORE),
            list = store.list.bind(store),
            participants = app.get<SpaceParticipantsPort>(
                SPACE_PARTICIPANTS_PORT,
            );
        vi.spyOn(store, 'list').mockImplementationOnce(async (...args) => {
            const result = await list(...args);
            vi.spyOn(participants, 'read').mockRejectedValue(
                new SpacesDomainError('SPACE_NOT_FOUND'),
            );
            return result;
        });
        await f.a.agent.get(`/v2/spaces/${f.space}/shopping-lists`).expect(404);
    });

    it('registers executable OpenAPI routes for creation, renaming and history', () => {
        const doc = createApiOpenApiDocument(false);
        expect(
            doc.paths['/v2/spaces/{spaceId}/shopping-lists']?.post,
        ).toBeDefined();
        expect(
            doc.paths['/v2/spaces/{spaceId}/shopping-lists/{listId}/name']
                ?.post,
        ).toBeDefined();
        expect(
            doc.paths['/v2/spaces/{spaceId}/shopping-lists/{listId}/history']
                ?.get,
        ).toBeDefined();
    });

    it('reapplies the empty migration, preserves legacy schema and protects shopping history', async () => {
        const legacySchema = () =>
            Promise.all([
                db.query(
                    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'shopping_%' AND tablename<>'migrations' ORDER BY tablename",
                ),
                db.query(
                    "SELECT c.relname AS table_name, k.conname, pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname NOT LIKE 'shopping_%' AND c.relname<>'migrations' ORDER BY c.relname,k.conname",
                ),
                db.query(
                    "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename NOT LIKE 'shopping_%' AND tablename<>'migrations' ORDER BY tablename,indexname",
                ),
            ]);
        await migrationSource.initialize();
        try {
            await rewindFinanceMigrationsTo(
                migrationSource,
                'ShoppingLists1792344857988',
            );
            const legacy = await legacySchema();
            await migrationSource.undoLastMigration();
            for (const table of [
                'shopping_lists',
                'shopping_history',
                'shopping_command_receipts',
                'shopping_command_audit',
            ])
                expect(
                    (
                        await db.query('SELECT to_regclass($1) AS name', [
                            `public.${table}`,
                        ])
                    )[0].name,
                ).toBeNull();
            expect(await legacySchema()).toEqual(legacy);
            await migrationSource.runMigrations();
            await rewindFinanceMigrationsTo(
                migrationSource,
                'ShoppingLists1792344857988',
            );
            expect(await legacySchema()).toEqual(legacy);
            await migrationSource.runMigrations();
            const b = await financeBrowser(app);
            await b
                .post(
                    `/v2/spaces/${b.context.personalSpace.id}/shopping-lists`,
                    {
                        name: 'Histórico preservado',
                    },
                )
                .expect(201);
            await rewindFinanceMigrationsTo(
                migrationSource,
                'ShoppingLists1792344857988',
            );
            const before = await shoppingSnapshot(db);
            await expect(migrationSource.undoLastMigration()).rejects.toThrow(
                /histórico/i,
            );
            expect(await shoppingSnapshot(db)).toEqual(before);
            expect(await legacySchema()).toEqual(legacy);
        } finally {
            await migrationSource.runMigrations();
            await migrationSource.destroy();
        }
    });
});
