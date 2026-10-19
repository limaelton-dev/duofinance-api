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
    prepareRoutineDatabase,
    routineApp,
    routineSnapshot,
} from './routine-fixture.js';
import migrationSource from '../dist/shared/technical/database/typeorm/data-source.js';
import { createApiOpenApiDocument } from '../dist/composition/http/create-api-openapi-document.js';
describe('CARD-033 tasks HTTP/PostgreSQL', () => {
    let app: INestApplication<Server>, db: DataSource;
    beforeAll(prepareRoutineDatabase);
    beforeEach(async () => {
        ({ app, db } = await routineApp(
            () => new Date('2026-10-18T14:00:00Z'),
        ));
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await app?.close();
    });
    it('creates a simple personal task owned by its person, with no member or executor', async () => {
        const b = await financeBrowser(app);
        const base = `/v2/spaces/${b.context.personalSpace.id}`;
        const task = (
            await b
                .post(`${base}/tasks`, { description: '  Lavar roupa  ' })
                .expect(201)
        ).body;
        expect(task).toMatchObject({
            description: 'Lavar roupa',
            status: 'PENDING',
            version: 1,
            urgency: 'NORMAL',
            deadline: null,
            creator: { personId: b.context.person.id, memberId: null },
            assignee: { personId: b.context.person.id, memberId: null },
            completion: null,
        });
        expect(
            (await b.agent.get(`${base}/routine-context`).expect(200)).body
                .participants,
        ).toHaveLength(1);
        expect(
            (await b.agent.get(`${base}/tasks`).expect(200)).body.items[0].id,
        ).toBe(task.id);
        const detail = await b.agent
            .get(`${base}/tasks/${task.id}`)
            .expect(200);
        expect(detail.headers['cache-control']).toBe('no-store');
        const history = (
            await b.agent.get(`${base}/tasks/${task.id}/history`).expect(200)
        ).body.items;
        expect(history).toMatchObject([
            { type: 'CREATED', actorId: b.context.person.id, sequence: 1 },
        ]);
    });
    it('assigns across members without approval, removes explicitly, and preserves creation', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}/tasks`;
        const t = (
            await f.a
                .post(base, {
                    description: 'Cozinha',
                    assigneeMemberId: f.mb,
                    urgency: 'URGENT',
                    deadline: { date: '2026-10-17', time: '10:00' },
                })
                .expect(201)
        ).body;
        const key = randomUUID(),
            input = { expectedVersion: 1, assigneeMemberId: f.ma };
        const changed = (
            await f.b.post(`${base}/${t.id}/assignment`, input, key).expect(200)
        ).body;
        await f.b
            .post(`${base}/${t.id}/assignment`, {
                expectedVersion: 2,
                assigneeMemberId: null,
            })
            .expect(200);
        expect(
            (
                await f.b
                    .post(`${base}/${t.id}/assignment`, input, key)
                    .expect(200)
            ).body,
        ).toEqual(changed);
        const detail = (await f.a.agent.get(`${base}/${t.id}`).expect(200))
            .body;
        expect(detail).toMatchObject({
            creator: { personId: f.a.context.person.id, memberId: f.ma },
            assignee: null,
            completion: null,
            urgency: 'URGENT',
            version: 3,
        });
        const events = (
            await f.a.agent.get(`${base}/${t.id}/history`).expect(200)
        ).body.items;
        expect(events[1]).toMatchObject({
            actorId: f.b.context.person.id,
            data: { before: { memberId: f.mb }, after: { memberId: f.ma } },
        });
    });
    it('replays concurrent creation and rejects key reuse across payload or destination', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}/tasks`,
            key = randomUUID(),
            input = { description: 'Uma só' };
        const pair = await Promise.all([
            f.a.post(base, input, key),
            f.a.post(base, input, key),
        ]);
        expect(pair.map((r) => r.status)).toEqual([201, 201]);
        expect(pair[0].body).toEqual(pair[1].body);
        await f.a.post(base, { description: 'Outra' }, key).expect(409);
        await f.a
            .post(
                `/v2/spaces/${f.a.context.personalSpace.id}/tasks`,
                input,
                key,
            )
            .expect(409);
        expect((await db.query('SELECT * FROM routine_tasks')).length).toBe(1);
        expect(
            (await db.query('SELECT * FROM routine_command_audit')).length,
        ).toBe(1);
    });
    it('uses a conditional version update for competing assignments', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}/tasks`;
        const t = (
            await f.a.post(base, { description: 'Concorrência' }).expect(201)
        ).body;
        const responses = await Promise.all([
            f.a.post(`${base}/${t.id}/assignment`, {
                expectedVersion: 1,
                assigneeMemberId: f.ma,
            }),
            f.b.post(`${base}/${t.id}/assignment`, {
                expectedVersion: 1,
                assigneeMemberId: f.mb,
            }),
        ]);
        expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(responses.find((r) => r.status === 409)!.body.code).toBe(
            'CONCURRENT_MODIFICATION',
        );
        expect((await db.query('SELECT * FROM routine_history')).length).toBe(
            2,
        );
    });
    it('isolates spaces and distinguishes member from person identities', async () => {
        const f = await sharedFinance(app),
            outsider = await financeBrowser(app),
            base = `/v2/spaces/${f.space}/tasks`;
        const t = (
            await f.a.post(base, { description: 'Restrita' }).expect(201)
        ).body;
        await outsider.agent.get(base).expect(404);
        await f.a.agent
            .get(`/v2/spaces/${f.a.context.personalSpace.id}/tasks/${t.id}`)
            .expect(404);
        await f.a
            .post(base, {
                description: 'Inválida',
                assigneeMemberId: f.b.context.person.id,
            })
            .expect(400);
        await f.a
            .post(base, {
                description: 'Inválida',
                assigneeMemberId: outsider.context.person.id,
            })
            .expect(400);
        await db.query(
            'ALTER TABLE space_members DROP CONSTRAINT "CHK_space_members_status"',
        );
        try {
            await db.query(
                "UPDATE space_members SET status='INACTIVE' WHERE id=$1",
                [f.mb],
            );
            await f.a
                .post(base, { description: 'Inválida', assigneeMemberId: f.mb })
                .expect(400);
            await f.b.agent.get(base).expect(404);
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
        'keeps authorized reads and replay but blocks new writes in %s',
        async (status) => {
            const f = await sharedFinance(app),
                base = `/v2/spaces/${f.space}/tasks`,
                key = randomUUID();
            const created = (
                await f.a
                    .post(base, { description: 'Anterior' }, key)
                    .expect(201)
            ).body;
            await db.query('UPDATE spaces SET status=$1 WHERE id=$2', [
                status,
                f.space,
            ]);
            const before = await routineSnapshot(db);
            await f.a.agent.get(base).expect(200);
            await f.a.post(base, { description: 'Nova' }).expect(409);
            expect(
                (
                    await f.a
                        .post(base, { description: 'Anterior' }, key)
                        .expect(201)
                ).body,
            ).toEqual(created);
            expect(await routineSnapshot(db)).toEqual(before);
        },
    );
    it.each([
        { description: '' },
        { description: 'x', deadline: { time: '10:00' } },
        { description: 'x', deadline: { date: '2026-02-29' } },
        { description: 'x', urgency: 'OVERDUE' },
        { description: 'x', executor: 'forged' },
        null,
    ])('returns useful Portuguese validation for %j', async (input) => {
        const b = await financeBrowser(app);
        const response = await b
            .post(
                `/v2/spaces/${b.context.personalSpace.id}/tasks`,
                input as unknown as object,
            )
            .expect(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
        expect(response.body.details.fields[0].field).toBeTruthy();
        expect(response.body.message).toBe('Verifique os dados informados.');
    });
    it('paginates tasks and history and rejects a cursor used for another destination', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}/tasks`;
        for (let i = 0; i < 3; i++)
            await f.a.post(base, { description: `Item ${i}` }).expect(201);
        const before = await routineSnapshot(db);
        const first = (await f.a.agent.get(`${base}?limit=2`).expect(200)).body;
        const second = (
            await f.a.agent
                .get(`${base}?limit=2&cursor=${first.nextCursor}`)
                .expect(200)
        ).body;
        expect(
            new Set([...first.items, ...second.items].map((t) => t.id)).size,
        ).toBe(3);
        expect(second.nextCursor).toBeNull();
        await f.a.agent
            .get(
                `/v2/spaces/${f.a.context.personalSpace.id}/tasks?cursor=${first.nextCursor}`,
            )
            .expect(400);
        await f.a.agent.get(`${base}?cursor=invalid`).expect(400);
        expect(await routineSnapshot(db)).toEqual(before);
    });
    it('rolls back task, history and receipt if audit persistence fails', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}/tasks`;
        const before = await routineSnapshot(db);
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        await db.query(
            "ALTER TABLE routine_command_audit ADD CONSTRAINT test_reject_audit CHECK (action <> 'CREATE_TASK')",
        );
        try {
            await f.a.post(base, { description: 'Rollback' }).expect(500);
            expect(await routineSnapshot(db)).toEqual(before);
        } finally {
            await db.query(
                'ALTER TABLE routine_command_audit DROP CONSTRAINT test_reject_audit',
            );
        }
    });
    it('registers the executable OpenAPI contracts', () => {
        const doc = createApiOpenApiDocument(false);
        expect(doc.paths['/v2/spaces/{spaceId}/tasks']?.post).toBeDefined();
        expect(doc.components?.schemas?.RoutineCreateTask).toBeDefined();
    });
    it('supports empty migration down/up and protects produced history', async () => {
        await migrationSource.initialize();
        try {
            await rewindFinanceMigrationsTo(
                migrationSource,
                'RoutineTasks1792336229574',
            );
            await migrationSource.undoLastMigration();
            expect(
                (
                    await db.query(
                        "SELECT to_regclass('public.routine_tasks') AS name",
                    )
                )[0].name,
            ).toBeNull();
            await migrationSource.runMigrations();
            const b = await financeBrowser(app);
            await b
                .post(`/v2/spaces/${b.context.personalSpace.id}/tasks`, {
                    description: 'Histórico',
                })
                .expect(201);
            await rewindFinanceMigrationsTo(
                migrationSource,
                'RoutineTasks1792336229574',
            );
            await expect(migrationSource.undoLastMigration()).rejects.toThrow(
                /histórico/i,
            );
        } finally {
            await migrationSource.runMigrations();
            await migrationSource.destroy();
        }
    });
});
