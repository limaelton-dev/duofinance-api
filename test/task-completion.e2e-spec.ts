import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Logger, type INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import {
    beforeAll,
    beforeEach,
    afterEach,
    describe,
    it,
    expect,
    vi,
} from 'vitest';
import { financeBrowser, sharedFinance } from './settlement-fixture.js';
import {
    routineApp,
    prepareRoutineDatabase,
    routineSnapshot,
} from './routine-fixture.js';
describe('task completion HTTP/PostgreSQL', () => {
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
    it('lets A complete a task of B, reopens and preserves each completion with its responsibility', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}`,
            t = (
                await f.a
                    .post(`${base}/tasks`, {
                        description: 'Rotina',
                        assigneeMemberId: f.mb,
                        deadline: { date: '2026-10-17' },
                    })
                    .expect(201)
            ).body,
            path = `${base}/tasks/${t.id}`;
        const completed = (
            await f.a
                .post(`${path}/complete`, { expectedVersion: 1 })
                .expect(200)
        ).body;
        expect(completed).toMatchObject({
            assignee: { memberId: f.mb },
            completion: {
                executor: { memberId: f.ma },
                assignee: { memberId: f.mb },
                completedAt: '2026-10-18T14:00:00.000Z',
            },
            version: 2,
        });
        expect(
            (await f.a.agent.get(`${base}/tasks`).expect(200)).body.items,
        ).toEqual([]);
        expect(
            (await f.a.agent.get(`${base}/tasks?status=COMPLETED`).expect(200))
                .body.items,
        ).toHaveLength(1);
        expect(
            (await f.a.agent.get(`${base}/today`).expect(200)).body.routine.data
                .counts.totalCount,
        ).toBe(0);
        await f.b.post(`${path}/reopen`, { expectedVersion: 2 }).expect(200);
        expect((await f.b.agent.get(path).expect(200)).body).toMatchObject({
            status: 'PENDING',
            completion: null,
            conditions: { overdue: true },
            urgency: 'NORMAL',
        });
        await f.b
            .post(`${path}/assignment`, {
                expectedVersion: 3,
                assigneeMemberId: f.ma,
            })
            .expect(200);
        await f.b.post(`${path}/complete`, { expectedVersion: 4 }).expect(200);
        const history = (await f.a.agent.get(`${path}/history`).expect(200))
            .body.items;
        expect(history.map((e: { type: string }) => e.type)).toEqual([
            'CREATED',
            'COMPLETED',
            'REOPENED',
            'ASSIGNED',
            'COMPLETED',
        ]);
        expect(history[1].data.after).toMatchObject({
            executor: { memberId: f.ma },
            assignee: { memberId: f.mb },
        });
        expect(history[4].data.after).toMatchObject({
            executor: { memberId: f.mb },
            assignee: { memberId: f.ma },
        });
        const first = (
            await f.a.agent.get(`${path}/history?limit=2`).expect(200)
        ).body;
        expect(
            (
                await f.a.agent
                    .get(`${path}/history?limit=2&cursor=${first.nextCursor}`)
                    .expect(200)
            ).body.items[0].type,
        ).toBe('REOPENED');
    });
    it('replays an old result after reopen without adding another fact and rejects invalid new transitions', async () => {
        const b = await financeBrowser(app),
            base = `/v2/spaces/${b.context.personalSpace.id}/tasks`,
            t = (await b.post(base, { description: 'Pessoal' }).expect(201))
                .body,
            path = `${base}/${t.id}`,
            key = randomUUID();
        const result = (
            await b
                .post(`${path}/complete`, { expectedVersion: 1 }, key)
                .expect(200)
        ).body;
        await b.post(`${path}/complete`, { expectedVersion: 2 }).expect(409);
        await b.post(`${path}/reopen`, { expectedVersion: 2 }).expect(200);
        expect(
            (
                await b
                    .post(`${path}/complete`, { expectedVersion: 1 }, key)
                    .expect(200)
            ).body,
        ).toEqual(result);
        await b.post(`${path}/reopen`, { expectedVersion: 3 }).expect(409);
        expect((await b.agent.get(path).expect(200)).body.version).toBe(3);
        expect((await db.query('SELECT * FROM routine_history')).length).toBe(
            3,
        );
    });
    it('allows one completion per version and conflicts with a concurrent reopen', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}/tasks`,
            t = (
                await f.a.post(base, { description: 'Concorrente' }).expect(201)
            ).body,
            path = `${base}/${t.id}`;
        const results = await Promise.all([
            f.a.post(`${path}/complete`, { expectedVersion: 1 }),
            f.b.post(`${path}/complete`, { expectedVersion: 1 }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        const race = await Promise.all([
            f.a.post(`${path}/reopen`, { expectedVersion: 2 }),
            f.b.post(`${path}/complete`, { expectedVersion: 2 }),
        ]);
        expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
        expect((await f.a.agent.get(path).expect(200)).body).toMatchObject({
            status: 'PENDING',
            version: 3,
            completion: null,
        });
    });
    it('refuses other spaces and forged executor or time and protects personal ownership', async () => {
        const a = await financeBrowser(app),
            b = await financeBrowser(app),
            base = `/v2/spaces/${a.context.personalSpace.id}/tasks`,
            t = (await a.post(base, { description: 'Privada' }).expect(201))
                .body;
        await b
            .post(`${base}/${t.id}/complete`, { expectedVersion: 1 })
            .expect(404);
        await b
            .post(
                `/v2/spaces/${b.context.personalSpace.id}/tasks/${t.id}/complete`,
                { expectedVersion: 1 },
            )
            .expect(404);
        for (const extra of [
            { executor: a.context.person.id },
            { completedAt: '2020-01-01T00:00:00Z' },
        ])
            await a
                .post(`${base}/${t.id}/complete`, {
                    expectedVersion: 1,
                    ...extra,
                })
                .expect(400);
        expect(
            (await a.agent.get(`${base}/${t.id}`).expect(200)).body.status,
        ).toBe('PENDING');
    });
    it('rolls back completion and reopens if audit persistence fails', async () => {
        const b = await financeBrowser(app),
            base = `/v2/spaces/${b.context.personalSpace.id}/tasks`,
            t = (await b.post(base, { description: 'Atômica' }).expect(201))
                .body,
            path = `${base}/${t.id}`;
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        for (const [action, expectedVersion] of [
            ['complete', 1],
            ['reopen', 2],
        ] as const) {
            const before = await routineSnapshot(db);
            await db.query(
                `ALTER TABLE routine_command_audit ADD CONSTRAINT test_reject_audit CHECK (action <> '${action.toUpperCase()}_TASK')`,
            );
            try {
                await b
                    .post(`${path}/${action}`, { expectedVersion })
                    .expect(500);
                expect(await routineSnapshot(db)).toEqual(before);
            } finally {
                await db.query(
                    'ALTER TABLE routine_command_audit DROP CONSTRAINT test_reject_audit',
                );
            }
            await b.post(`${path}/${action}`, { expectedVersion }).expect(200);
        }
    });
});
