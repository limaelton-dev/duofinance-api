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
    competingFinanceCommands,
    rewindFinanceMigrationsTo,
} from './settlement-fixture.js';
import { routineSnapshot } from './routine-fixture.js';
import {
    prepareShoppingDatabase,
    shoppingApp,
    shoppingSnapshot,
} from './shopping-fixture.js';
import migrationSource from '../dist/shared/technical/database/typeorm/data-source.js';
import {
    ROUTINE_STORE,
    type RoutineStore,
} from '../dist/modules/routine/application/routine-store.js';

describe('CARD-043 task shopping-list links HTTP/PostgreSQL', () => {
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
    async function personal() {
        const b = await financeBrowser(app),
            base = `/v2/spaces/${b.context.personalSpace.id}`,
            list = (
                await b
                    .post(`${base}/shopping-lists`, { name: 'Mercado' })
                    .expect(201)
            ).body;
        return { b, base, list, listPath: `${base}/shopping-lists/${list.id}` };
    }

    it('creates tasks with an optional list and reads current shopping metadata without changing either module', async () => {
        const { b, base, list, listPath } = await personal();
        await b
            .post(`${listPath}/items`, {
                expectedVersion: 1,
                description: 'Arroz',
                desiredQuantity: '1',
            })
            .expect(201);
        const shopping = await shoppingSnapshot(db),
            bare = (
                await b
                    .post(`${base}/tasks`, { description: 'Sem lista' })
                    .expect(201)
            ).body,
            linked = (
                await b
                    .post(`${base}/tasks`, {
                        description: 'Comprar',
                        shoppingListId: list.id,
                    })
                    .expect(201)
            ).body;
        expect(bare.shoppingListId).toBeNull();
        expect(linked).toMatchObject({
            shoppingListId: list.id,
            status: 'PENDING',
            version: 1,
        });
        const routine = await routineSnapshot(db);
        expect(
            (await b.agent.get(`${base}/tasks/${bare.id}`).expect(200)).body
                .shoppingList,
        ).toBeNull();
        const detail = await b.agent
            .get(`${base}/tasks/${linked.id}`)
            .expect(200);
        expect(detail.headers['cache-control']).toBe('no-store');
        expect(detail.body.shoppingList).toMatchObject({
            id: list.id,
            name: 'Mercado',
            status: 'ACTIVE',
            summary: {
                activeItemCount: 1,
                actionableItemCount: 1,
                isComplete: false,
            },
        });
        expect(await shoppingSnapshot(db)).toEqual(shopping);
        expect(await routineSnapshot(db)).toEqual(routine);
    });

    it('keeps task completion, reopening, cancellation and shopping progress independent', async () => {
        const { b, base, list, listPath } = await personal(),
            item = (
                await b
                    .post(`${listPath}/items`, {
                        expectedVersion: 1,
                        description: 'Arroz',
                        desiredQuantity: '1',
                    })
                    .expect(201)
            ).body.item,
            first = (
                await b
                    .post(`${base}/tasks`, {
                        description: 'Primeira',
                        shoppingListId: list.id,
                    })
                    .expect(201)
            ).body,
            second = (
                await b
                    .post(`${base}/tasks`, {
                        description: 'Segunda',
                        shoppingListId: list.id,
                    })
                    .expect(201)
            ).body;
        const completed = (
            await b
                .post(`${base}/tasks/${first.id}/complete`, {
                    expectedVersion: 1,
                })
                .expect(200)
        ).body;
        expect(completed.status).toBe('COMPLETED');
        expect((await b.agent.get(listPath).expect(200)).body).toMatchObject({
            status: 'ACTIVE',
            summary: { actionableItemCount: 1 },
        });
        await b
            .post(`${listPath}/items/${item.id}/purchases`, {
                expectedVersion: 2,
                quantity: '1',
            })
            .expect(201);
        expect(
            (await b.agent.get(`${base}/tasks/${second.id}`).expect(200)).body
                .status,
        ).toBe('PENDING');
        expect(
            (
                await b
                    .post(`${base}/tasks/${first.id}/reopen`, {
                        expectedVersion: 2,
                    })
                    .expect(200)
            ).body,
        ).toMatchObject({ status: 'PENDING', shoppingListId: list.id });
        await b
            .post(`${base}/tasks/${second.id}/cancel`, { expectedVersion: 1 })
            .expect(200);
        expect((await b.agent.get(listPath).expect(200)).body).toMatchObject({
            status: 'ACTIVE',
            summary: { isComplete: true },
        });
    });

    it.each(['COMPLETED', 'CANCELLED'])(
        'changes and removes metadata on a %s task after its old list is archived without reopening it',
        async (status) => {
            const { b, base, list, listPath } = await personal(),
                next = (
                    await b
                        .post(`${base}/shopping-lists`, { name: 'Outra' })
                        .expect(201)
                ).body,
                task = (
                    await b
                        .post(`${base}/tasks`, {
                            description: 'Comprar',
                            shoppingListId: list.id,
                        })
                        .expect(201)
                ).body,
                path = `${base}/tasks/${task.id}`;
            const terminal = (
                await b
                    .post(
                        `${path}/${status === 'COMPLETED' ? 'complete' : 'cancel'}`,
                        { expectedVersion: 1 },
                    )
                    .expect(200)
            ).body;
            await b
                .post(`${listPath}/archival`, { expectedVersion: 1 })
                .expect(200);
            const changed = (
                await b
                    .post(`${path}/shopping-list`, {
                        expectedVersion: 2,
                        shoppingListId: next.id,
                    })
                    .expect(200)
            ).body;
            expect(changed).toMatchObject({
                status,
                version: 3,
                shoppingListId: next.id,
                completion: terminal.completion,
            });
            await b
                .post(`${base}/shopping-lists/${next.id}/archival`, {
                    expectedVersion: 1,
                })
                .expect(200);
            const unlinked = (
                await b
                    .post(`${path}/shopping-list/removal`, {
                        expectedVersion: 3,
                    })
                    .expect(200)
            ).body;
            expect(unlinked).toMatchObject({
                status,
                version: 4,
                shoppingListId: null,
                completion: terminal.completion,
            });
            const history = (await b.agent.get(`${path}/history`).expect(200))
                .body.items;
            expect(history.slice(-2)).toMatchObject([
                {
                    type: 'SHOPPING_LIST_CHANGED',
                    data: { before: list.id, after: next.id },
                },
                {
                    type: 'SHOPPING_LIST_CHANGED',
                    data: { before: next.id, after: null },
                },
            ]);
        },
    );

    it('refuses targets from another space, unknown lists and archived lists without partial writes', async () => {
        const { b, base, list, listPath } = await personal(),
            outsider = await financeBrowser(app),
            other = (
                await outsider
                    .post(
                        `/v2/spaces/${outsider.context.personalSpace.id}/shopping-lists`,
                        {},
                    )
                    .expect(201)
            ).body,
            task = (
                await b
                    .post(`${base}/tasks`, { description: 'Sem lista' })
                    .expect(201)
            ).body;
        await b
            .post(`${listPath}/archival`, { expectedVersion: 1 })
            .expect(200);
        const before = await routineSnapshot(db),
            shopping = await shoppingSnapshot(db);
        for (const [shoppingListId, code] of [
            [other.id, 404],
            [randomUUID(), 404],
            [list.id, 409],
        ] as const) {
            await b
                .post(`${base}/tasks`, {
                    description: 'Inválida',
                    shoppingListId,
                })
                .expect(code);
            await b
                .post(`${base}/tasks/${task.id}/shopping-list`, {
                    expectedVersion: 1,
                    shoppingListId,
                })
                .expect(code);
        }
        expect(await routineSnapshot(db)).toEqual(before);
        expect(await shoppingSnapshot(db)).toEqual(shopping);
    });

    it('paginates multiple linked tasks including terminal states and scopes the cursor', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}`,
            list = (await f.a.post(`${base}/shopping-lists`, {}).expect(201))
                .body,
            other = (await f.a.post(`${base}/shopping-lists`, {}).expect(201))
                .body,
            tasks: { id: string }[] = [];
        for (let i = 0; i < 3; i++)
            tasks.push(
                (
                    await f.a
                        .post(`${base}/tasks`, {
                            description: `Task ${i}`,
                            shoppingListId: list.id,
                        })
                        .expect(201)
                ).body,
            );
        await f.b
            .post(`${base}/tasks/${tasks[0].id}/complete`, {
                expectedVersion: 1,
            })
            .expect(200);
        await f.b
            .post(`${base}/tasks/${tasks[1].id}/cancel`, { expectedVersion: 1 })
            .expect(200);
        const before = await routineSnapshot(db),
            shopping = await shoppingSnapshot(db),
            path = `${base}/shopping-lists/${list.id}/tasks`,
            first = (await f.a.agent.get(`${path}?limit=2`).expect(200)).body,
            second = (
                await f.a.agent
                    .get(`${path}?limit=2&cursor=${first.nextCursor}`)
                    .expect(200)
            ).body;
        expect(first).toMatchObject({
            spaceId: f.space,
            shoppingListId: list.id,
            totalCount: 3,
        });
        expect(second.nextCursor).toBeNull();
        const all = [...first.items, ...second.items];
        expect(new Set(all.map((task: { id: string }) => task.id)).size).toBe(
            3,
        );
        expect(
            all.map((task: { status: string }) => task.status).sort(),
        ).toEqual(['CANCELLED', 'COMPLETED', 'PENDING']);
        await f.b.agent.get(`${path}?cursor=${first.nextCursor}`).expect(400);
        await f.a.agent
            .get(
                `${base}/shopping-lists/${other.id}/tasks?cursor=${first.nextCursor}`,
            )
            .expect(400);
        await f.a.agent
            .get(
                `/v2/spaces/${f.a.context.personalSpace.id}/shopping-lists/${list.id}/tasks`,
            )
            .expect(404);
        expect(await routineSnapshot(db)).toEqual(before);
        expect(await shoppingSnapshot(db)).toEqual(shopping);
    });

    it('keeps recurring tasks and occurrences outside the one-off link contract and never materializes on GET', async () => {
        const { b, base, list, listPath } = await personal(),
            input = {
                description: 'Recorrente',
                rule: { frequency: 'DAILY' },
                startsOn: '2026-10-18',
                endsOn: '2026-10-18',
            };
        await b
            .post(`${base}/task-recurrences`, {
                ...input,
                shoppingListId: list.id,
            })
            .expect(400);
        const recurrence = (
                await b.post(`${base}/task-recurrences`, input).expect(201)
            ).body,
            before = await routineSnapshot(db),
            shopping = await shoppingSnapshot(db),
            occurrencesPath = `${base}/task-recurrences/${recurrence.id}/occurrences`,
            projected = (
                await b.agent
                    .get(`${occurrencesPath}?from=2026-10-18&to=2026-10-18`)
                    .expect(200)
            ).body.items[0];
        expect(projected).not.toHaveProperty('shoppingListId');
        expect(projected.materialized).toBe(false);
        expect(
            (await b.agent.get(`${listPath}/tasks`).expect(200)).body.items,
        ).toEqual([]);
        expect(await routineSnapshot(db)).toEqual(before);
        expect(await shoppingSnapshot(db)).toEqual(shopping);
        await b
            .post(
                `${base}/tasks/${encodeURIComponent(projected.id)}/shopping-list`,
                { expectedVersion: 1, shoppingListId: list.id },
            )
            .expect(400);
        const materialized = (
            await b
                .post(`${occurrencesPath}/2026-10-18/complete`, {
                    expectedRecurrenceVersion: 1,
                    expectedOccurrenceVersion: null,
                })
                .expect(200)
        ).body;
        await b
            .post(`${base}/tasks/${materialized.id}/shopping-list`, {
                expectedVersion: 1,
                shoppingListId: list.id,
            })
            .expect(404);
        expect(
            (await b.agent.get(`${listPath}/tasks`).expect(200)).body
                .totalCount,
        ).toBe(0);
    });

    it('replays successful creation and linking before validating a target that was archived afterward', async () => {
        const { b, base, list, listPath } = await personal(),
            createKey = randomUUID(),
            create = {
                description: 'Criada com lista',
                shoppingListId: list.id,
            },
            created = (
                await b.post(`${base}/tasks`, create, createKey).expect(201)
            ).body,
            bare = (
                await b
                    .post(`${base}/tasks`, { description: 'Depois vinculada' })
                    .expect(201)
            ).body,
            key = randomUUID(),
            input = { expectedVersion: 1, shoppingListId: list.id },
            path = `${base}/tasks/${bare.id}/shopping-list`,
            linked = (await b.post(path, input, key).expect(200)).body;
        await b
            .post(`${listPath}/archival`, { expectedVersion: 1 })
            .expect(200);
        const before = await routineSnapshot(db),
            shopping = await shoppingSnapshot(db);
        expect(
            (await b.post(`${base}/tasks`, create, createKey).expect(201)).body,
        ).toEqual(created);
        expect((await b.post(path, input, key).expect(200)).body).toEqual(
            linked,
        );
        await b
            .post(path, { expectedVersion: 2, shoppingListId: list.id })
            .expect(409);
        await b
            .post(path, { ...input, shoppingListId: randomUUID() }, key)
            .expect(409);
        expect(await routineSnapshot(db)).toEqual(before);
        expect(await shoppingSnapshot(db)).toEqual(shopping);
    });

    it('uses the task root version for a link competing with task maintenance', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}`,
            list = (await f.a.post(`${base}/shopping-lists`, {}).expect(201))
                .body,
            task = (
                await f.a
                    .post(`${base}/tasks`, { description: 'Concorrente' })
                    .expect(201)
            ).body,
            shopping = await shoppingSnapshot(db),
            path = `${base}/tasks/${task.id}`;
        const responses = await Promise.all([
            f.a.post(`${path}/shopping-list`, {
                expectedVersion: 1,
                shoppingListId: list.id,
            }),
            f.b.post(`${path}/urgency`, {
                expectedVersion: 1,
                urgency: 'HIGH',
            }),
        ]);
        expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
        expect((await f.a.agent.get(path).expect(200)).body.version).toBe(2);
        expect(
            (await f.a.agent.get(`${path}/history`).expect(200)).body.items,
        ).toHaveLength(2);
        expect(await shoppingSnapshot(db)).toEqual(shopping);
    });

    it('serializes target validation with a concurrent list archival', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}`,
            list = (await f.a.post(`${base}/shopping-lists`, {}).expect(201))
                .body,
            task = (
                await f.a
                    .post(`${base}/tasks`, { description: 'Concorrente' })
                    .expect(201)
            ).body;
        const [link, archive] = await competingFinanceCommands(
            db,
            f.space,
            () =>
                Promise.all([
                    f.a.post(`${base}/tasks/${task.id}/shopping-list`, {
                        expectedVersion: 1,
                        shoppingListId: list.id,
                    }),
                    f.b.post(`${base}/shopping-lists/${list.id}/archival`, {
                        expectedVersion: 1,
                    }),
                ]),
        );
        expect(archive.status).toBe(200);
        expect([200, 409]).toContain(link.status);
        const detail = (
            await f.a.agent.get(`${base}/tasks/${task.id}`).expect(200)
        ).body;
        expect(detail.version).toBe(link.status === 200 ? 2 : 1);
        expect(detail.shoppingListId).toBe(
            link.status === 200 ? list.id : null,
        );
        if (link.status === 200)
            expect(detail.shoppingList.status).toBe('ARCHIVED');
    });

    it('reads linked shopping metadata on the same snapshot as the task while a list is archived', async () => {
        const { b, base, list, listPath } = await personal(),
            task = (
                await b
                    .post(`${base}/tasks`, {
                        description: 'Vinculada',
                        shoppingListId: list.id,
                    })
                    .expect(201)
            ).body,
            store = app.get<RoutineStore>(ROUTINE_STORE),
            find = store.find.bind(store);
        vi.spyOn(store, 'find').mockImplementationOnce(async (...args) => {
            const current = await find(...args);
            await db.query(
                "UPDATE shopping_lists SET status='ARCHIVED', archived_at=now(), version=version+1 WHERE id=$1",
                [list.id],
            );
            return current;
        });
        const first = (
            await b.agent.get(`${base}/tasks/${task.id}`).expect(200)
        ).body;
        expect(first.shoppingList).toMatchObject({
            id: list.id,
            status: 'ACTIVE',
        });
        vi.restoreAllMocks();
        expect(
            (await b.agent.get(`${base}/tasks/${task.id}`).expect(200)).body
                .shoppingList,
        ).toMatchObject({ id: list.id, status: 'ARCHIVED' });
        expect((await b.agent.get(listPath).expect(200)).body.status).toBe(
            'ARCHIVED',
        );
    });

    it.each(['routine_history', 'routine_command_audit'])(
        'rolls back task creation, link and unlink when %s rejects persistence',
        async (table) => {
            const { b, base, list } = await personal(),
                bare = (
                    await b
                        .post(`${base}/tasks`, { description: 'Sem lista' })
                        .expect(201)
                ).body,
                linked = (
                    await b
                        .post(`${base}/tasks`, {
                            description: 'Vinculada',
                            shoppingListId: list.id,
                        })
                        .expect(201)
                ).body,
                before = await routineSnapshot(db),
                shopping = await shoppingSnapshot(db);
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            await db.query(
                `ALTER TABLE ${table} ADD CONSTRAINT test_reject_link CHECK (false) NOT VALID`,
            );
            try {
                await b
                    .post(`${base}/tasks/${bare.id}/shopping-list`, {
                        expectedVersion: 1,
                        shoppingListId: list.id,
                    })
                    .expect(500);
                await b
                    .post(`${base}/tasks/${linked.id}/shopping-list/removal`, {
                        expectedVersion: 1,
                    })
                    .expect(500);
                await b
                    .post(`${base}/tasks`, {
                        description: 'Rollback',
                        shoppingListId: list.id,
                    })
                    .expect(500);
                expect(await routineSnapshot(db)).toEqual(before);
                expect(await shoppingSnapshot(db)).toEqual(shopping);
            } finally {
                await db.query(
                    `ALTER TABLE ${table} DROP CONSTRAINT test_reject_link`,
                );
            }
        },
    );

    it('upgrades legacy tasks with a nullable link, enforces the space FK and protects history even after unlinking', async () => {
        await migrationSource.initialize();
        try {
            await rewindFinanceMigrationsTo(
                migrationSource,
                'TaskShoppingLinks1792346372566',
            );
            const { b, base, list } = await personal(),
                task = (
                    await b
                        .post(`${base}/tasks`, { description: 'Legada' })
                        .expect(201)
                ).body;
            await migrationSource.undoLastMigration();
            expect(
                await db.query(
                    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='routine_tasks' AND column_name='shopping_list_id'",
                ),
            ).toEqual([]);
            expect(
                (
                    await db.query(
                        'SELECT description FROM routine_tasks WHERE id=$1',
                        [task.id],
                    )
                )[0].description,
            ).toBe('Legada');
            await migrationSource.runMigrations();
            expect(
                (
                    await db.query(
                        'SELECT shopping_list_id FROM routine_tasks WHERE id=$1',
                        [task.id],
                    )
                )[0].shopping_list_id,
            ).toBeNull();
            const outsider = await financeBrowser(app),
                other = (
                    await outsider
                        .post(
                            `/v2/spaces/${outsider.context.personalSpace.id}/shopping-lists`,
                            {},
                        )
                        .expect(201)
                ).body;
            await expect(
                db.query(
                    'UPDATE routine_tasks SET shopping_list_id=$1 WHERE id=$2',
                    [other.id, task.id],
                ),
            ).rejects.toThrow(/FK_routine_task_shopping_list/);
            await b
                .post(`${base}/tasks/${task.id}/shopping-list`, {
                    expectedVersion: 1,
                    shoppingListId: list.id,
                })
                .expect(200);
            await b
                .post(`${base}/tasks/${task.id}/shopping-list/removal`, {
                    expectedVersion: 2,
                })
                .expect(200);
            await rewindFinanceMigrationsTo(
                migrationSource,
                'TaskShoppingLinks1792346372566',
            );
            const before = await routineSnapshot(db);
            await expect(migrationSource.undoLastMigration()).rejects.toThrow(
                /histórico/i,
            );
            expect(await routineSnapshot(db)).toEqual(before);
        } finally {
            await migrationSource.runMigrations();
            await migrationSource.destroy();
        }
    });
});
