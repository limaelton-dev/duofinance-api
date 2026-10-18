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
describe('CARD-036 task maintenance HTTP/PostgreSQL', () => {
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
    it('moves dates across attention groups and urgency independently, preserving before and after', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}/tasks`,
            t = (
                await f.a
                    .post(base, {
                        description: 'Prazo',
                        assigneeMemberId: f.mb,
                        deadline: { date: '2026-10-17', time: '10:00' },
                    })
                    .expect(201)
            ).body,
            path = `${base}/${t.id}`;
        await f.b
            .post(`${path}/deadline`, {
                expectedVersion: 1,
                deadline: { date: '2026-10-19' },
            })
            .expect(200);
        expect(
            (await f.a.agent.get(path).expect(200)).body.conditions,
        ).toMatchObject({ overdue: false, upcoming: true });
        await f.a
            .post(`${path}/deadline`, { expectedVersion: 2, deadline: null })
            .expect(200);
        expect(
            (await f.a.agent.get(path).expect(200)).body.conditions,
        ).toMatchObject({ noDeadline: true, overdue: false });
        await f.a
            .post(`${path}/deadline`, {
                expectedVersion: 3,
                deadline: { date: '2026-10-18', time: '10:00' },
            })
            .expect(200);
        await f.a
            .post(`${path}/deadline`, {
                expectedVersion: 4,
                deadline: { date: '2026-10-18' },
            })
            .expect(200);
        const current = (
            await f.a
                .post(`${path}/urgency`, {
                    expectedVersion: 5,
                    urgency: 'URGENT',
                })
                .expect(200)
        ).body;
        expect(current).toMatchObject({
            deadline: { date: '2026-10-18', time: null },
            urgency: 'URGENT',
            assignee: { memberId: f.mb },
            creator: t.creator,
            completion: null,
        });
        const h = (await f.a.agent.get(`${path}/history`).expect(200)).body
            .items;
        expect(h[1]).toMatchObject({
            actorId: f.b.context.person.id,
            data: {
                before: { date: '2026-10-17', time: '10:00' },
                after: { date: '2026-10-19', time: null },
            },
        });
        expect(h[2].data.after).toBeNull();
        expect(h[5].data).toEqual({ before: 'NORMAL', after: 'URGENT' });
    });
    it('requires reopening before maintenance and keeps the original completion deadline', async () => {
        const b = await financeBrowser(app),
            base = `/v2/spaces/${b.context.personalSpace.id}/tasks`,
            t = (
                await b
                    .post(base, {
                        description: 'Concluída',
                        deadline: { date: '2026-10-17' },
                    })
                    .expect(201)
            ).body,
            path = `${base}/${t.id}`;
        await b.post(`${path}/complete`, { expectedVersion: 1 }).expect(200);
        for (const [action, field] of [
            ['deadline', { deadline: null }],
            ['urgency', { urgency: 'HIGH' }],
            ['cancel', {}],
        ] as const)
            await b
                .post(`${path}/${action}`, { expectedVersion: 2, ...field })
                .expect(409);
        await b.post(`${path}/reopen`, { expectedVersion: 2 }).expect(200);
        await b
            .post(`${path}/deadline`, { expectedVersion: 3, deadline: null })
            .expect(200);
        expect(
            (await b.agent.get(`${path}/history`).expect(200)).body.items[1]
                .data.deadline,
        ).toEqual({ date: '2026-10-17', time: null });
    });
    it('cancels a pending urgent overdue task without deletion or generic reactivation', async () => {
        const b = await financeBrowser(app),
            base = `/v2/spaces/${b.context.personalSpace.id}`,
            t = (
                await b
                    .post(`${base}/tasks`, {
                        description: 'Dispensada',
                        urgency: 'URGENT',
                        deadline: { date: '2026-10-17' },
                    })
                    .expect(201)
            ).body,
            path = `${base}/tasks/${t.id}`,
            key = randomUUID();
        const result = (
            await b
                .post(`${path}/cancel`, { expectedVersion: 1 }, key)
                .expect(200)
        ).body;
        expect(result.status).toBe('CANCELLED');
        expect(
            (
                await b
                    .post(`${path}/cancel`, { expectedVersion: 1 }, key)
                    .expect(200)
            ).body,
        ).toEqual(result);
        expect(
            (await b.agent.get(`${base}/tasks`).expect(200)).body.items,
        ).toEqual([]);
        expect(
            (await b.agent.get(`${base}/today`).expect(200)).body.routine.data
                .counts.totalCount,
        ).toBe(0);
        expect(
            (await b.agent.get(`${base}/tasks?status=CANCELLED`).expect(200))
                .body.items,
        ).toHaveLength(1);
        for (const action of ['reopen', 'complete', 'cancel'])
            await b
                .post(`${path}/${action}`, { expectedVersion: 2 })
                .expect(409);
        expect(
            (await b.agent.get(path).expect(200)).body.allowedActions,
        ).toEqual([]);
        expect((await db.query('SELECT * FROM routine_tasks')).length).toBe(1);
    });
    it.each(['deadline', 'cancel', 'urgency'])(
        'does not lose a concurrent %s change',
        async (action) => {
            const f = await sharedFinance(app),
                base = `/v2/spaces/${f.space}/tasks`,
                t = (
                    await f.a.post(base, { description: 'Disputa' }).expect(201)
                ).body,
                path = `${base}/${t.id}`;
            const input =
                action === 'deadline'
                    ? { deadline: null }
                    : action === 'urgency'
                      ? { urgency: 'URGENT' }
                      : {};
            const second = action === 'urgency' ? 'assignment' : 'complete',
                secondInput =
                    second === 'assignment' ? { assigneeMemberId: f.mb } : {};
            const results = await Promise.all([
                f.a.post(`${path}/${action}`, { expectedVersion: 1, ...input }),
                f.b.post(`${path}/${second}`, {
                    expectedVersion: 1,
                    ...secondInput,
                }),
            ]);
            expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
            expect(
                (await f.a.agent.get(`${path}/history`).expect(200)).body.items,
            ).toHaveLength(2);
        },
    );
    it('validates nested input and rolls back all facts on audit failure with a safe retry', async () => {
        const b = await financeBrowser(app),
            base = `/v2/spaces/${b.context.personalSpace.id}/tasks`,
            t = (await b.post(base, { description: 'Validação' }).expect(201))
                .body,
            path = `${base}/${t.id}`;
        for (const body of [
            { expectedVersion: 1, deadline: { time: '12:00' } },
            { expectedVersion: 1, deadline: { date: '2026-10-18', extra: 1 } },
            { expectedVersion: 1, deadline: null, assigneeMemberId: null },
        ]) {
            const r = await b.post(`${path}/deadline`, body).expect(400);
            expect(r.body.details.fields[0].field).toBeTruthy();
        }
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        const before = await routineSnapshot(db),
            key = randomUUID(),
            input = { expectedVersion: 1, urgency: 'URGENT' };
        await db.query(
            "ALTER TABLE routine_command_audit ADD CONSTRAINT test_reject_audit CHECK (action <> 'URGENCY_TASK')",
        );
        try {
            await b.post(`${path}/urgency`, input, key).expect(500);
            expect(await routineSnapshot(db)).toEqual(before);
        } finally {
            await db.query(
                'ALTER TABLE routine_command_audit DROP CONSTRAINT test_reject_audit',
            );
        }
        await b.post(`${path}/urgency`, input, key).expect(200);
        await b
            .post(`${path}/urgency`, { ...input, urgency: 'HIGH' }, key)
            .expect(409);
    });
});
