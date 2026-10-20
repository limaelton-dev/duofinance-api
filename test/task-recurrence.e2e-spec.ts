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
import {
    isScheduled,
    addDays,
    type TaskRecurrenceRule,
} from '../dist/modules/routine/domain/task-recurrence.js';
import {
    calendarCountSql,
    calendarNthSql,
} from '../dist/modules/routine/infrastructure/task-calendar.sql.js';
const occurrenceInput = {
    expectedRecurrenceVersion: 1,
    expectedOccurrenceVersion: null,
};
const input = (rule: object = { frequency: 'DAILY' }, extra: object = {}) => ({
    description: 'Rotina repetida',
    rule,
    startsOn: '2026-10-13',
    deadline: { time: null },
    ...extra,
});
describe('recurring routine HTTP/PostgreSQL', () => {
    let app: INestApplication<Server>, db: DataSource, instant: string;
    beforeAll(prepareRoutineDatabase);
    beforeEach(async () => {
        instant = '2026-10-18T14:00:00Z';
        ({ app, db } = await routineApp(() => new Date(instant)));
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await app?.close();
    });
    async function personal() {
        const b = await financeBrowser(app);
        return { b, base: `/v2/spaces/${b.context.personalSpace.id}` };
    }
    it.each<[TaskRecurrenceRule, string[]]>([
        [
            { frequency: 'DAILY' },
            [
                '2026-10-13',
                '2026-10-14',
                '2026-10-15',
                '2026-10-16',
                '2026-10-17',
                '2026-10-18',
                '2026-10-19',
            ],
        ],
        [{ frequency: 'WEEKLY', weekday: 2 }, ['2026-10-13']],
        [
            { frequency: 'WEEKDAYS', weekdays: [2, 5] },
            ['2026-10-13', '2026-10-16'],
        ],
        [{ frequency: 'MONTHLY', day: 15 }, ['2026-10-15']],
        [{ frequency: 'ANNUAL', month: 10, day: 18 }, ['2026-10-18']],
    ])(
        'projects %j consistently through all readers without writing',
        async (rule, expected) => {
            const { b, base } = await personal(),
                r = (
                    await b
                        .post(
                            `${base}/task-recurrences`,
                            input(rule, { endsOn: '2026-10-19' }),
                        )
                        .expect(201)
                ).body,
                path = `${base}/task-recurrences/${r.id}`,
                before = await routineSnapshot(db);
            const page = (
                await b.agent
                    .get(`${path}/occurrences?from=2026-10-13&to=2026-10-19`)
                    .expect(200)
            ).body;
            expect(
                page.items.map(
                    (o: { scheduledDate: string }) => o.scheduledDate,
                ),
            ).toEqual(expected);
            expect(
                page.items.every(
                    (o: { materialized: boolean; version: unknown }) =>
                        !o.materialized && o.version === null,
                ),
            ).toBe(true);
            const list = (
                await b.agent
                    .get(`${base}/tasks?from=2026-10-13&to=2026-10-19`)
                    .expect(200)
            ).body;
            expect(
                list.items.map(
                    (o: { scheduledDate: string }) => o.scheduledDate,
                ),
            ).toEqual(expected);
            expect(list.counts.totalCount).toBe(expected.length);
            for (const date of expected) {
                const detail = (
                    await b.agent.get(`${path}/occurrences/${date}`).expect(200)
                ).body;
                expect(detail.creator).toEqual(r.creator);
                expect(
                    (
                        await b.agent
                            .get(`${path}/occurrences/${date}/history`)
                            .expect(200)
                    ).body.items,
                ).toEqual([]);
            }
            await b.agent.get(`${base}/today`).expect(200);
            expect(await routineSnapshot(db)).toEqual(before);
        },
    );
    it('keeps monthly day 31 and leap-day anchors, including SQL arithmetic counts and nth dates', async () => {
        const { b, base } = await personal();
        for (const [rule, start, dates] of [
            [
                { frequency: 'MONTHLY', day: 31 },
                '2026-01-31',
                ['2026-01-31', '2026-02-28', '2026-03-31'],
            ],
            [
                { frequency: 'ANNUAL', month: 2, day: 29 },
                '2024-02-29',
                [
                    '2024-02-29',
                    '2025-02-28',
                    '2026-02-28',
                    '2027-02-28',
                    '2028-02-29',
                ],
            ],
        ] as const) {
            const r = (
                await b
                    .post(
                        `${base}/task-recurrences`,
                        input(rule, { startsOn: start }),
                    )
                    .expect(201)
            ).body;
            for (const date of dates)
                expect(
                    (
                        await b.agent
                            .get(
                                `${base}/task-recurrences/${r.id}/occurrences/${date}`,
                            )
                            .expect(200)
                    ).body.scheduledDate,
                ).toBe(date);
        }
        const rules: TaskRecurrenceRule[] = [
            { frequency: 'DAILY' },
            { frequency: 'WEEKLY', weekday: 7 },
            { frequency: 'WEEKDAYS', weekdays: [1, 3, 7] },
            { frequency: 'MONTHLY', day: 31 },
            { frequency: 'ANNUAL', month: 2, day: 29 },
        ];
        for (const rule of rules)
            for (const [from, to] of [
                ['2023-12-20', '2025-03-05'],
                ['2024-02-29', '2024-02-29'],
                ['2026-10-31', '2026-10-01'],
            ]) {
                const dates: string[] = [];
                if (from <= to)
                    for (let date = from; date <= to; date = addDays(date, 1))
                        if (isScheduled(rule, date)) dates.push(date);
                const [count] = await db.query(
                    `SELECT ${calendarCountSql('$1', '$2', '$3')} count`,
                    [rule, from, to],
                );
                expect(count.count).toBe(dates.length);
                if (dates.length) {
                    const rows = await db.query(
                        `SELECT ${calendarNthSql('$1', '$2', 'n')}::text date FROM generate_series(0,$3::int) n`,
                        [rule, from, Math.min(10, dates.length - 1)],
                    );
                    expect(
                        rows.map((row: { date: string }) => row.date),
                    ).toEqual(dates.slice(0, 11));
                }
            }
    });
    it('paginates interleaved old rules and never cuts off unresolved history', async () => {
        const { b, base } = await personal();
        for (const description of ['A antiga', 'B antiga'])
            await b
                .post(
                    `${base}/task-recurrences`,
                    input(
                        { frequency: 'DAILY' },
                        {
                            description,
                            startsOn: '2000-01-01',
                            endsOn: '2000-01-12',
                        },
                    ),
                )
                .expect(201);
        let page = (
            await b.agent
                .get(`${base}/tasks?limit=3&attention=OVERDUE`)
                .expect(200)
        ).body;
        const ids: string[] = [],
            dates: string[] = [];
        expect(page.counts.totalCount).toBe(24);
        for (let i = 0; i < 10; i++) {
            ids.push(...page.items.map((o: { id: string }) => o.id));
            dates.push(
                ...page.items.map(
                    (o: { scheduledDate: string }) => o.scheduledDate,
                ),
            );
            if (!page.nextCursor) break;
            page = (
                await b.agent
                    .get(
                        `${base}/tasks?limit=3&attention=OVERDUE&cursor=${page.nextCursor}`,
                    )
                    .expect(200)
            ).body;
        }
        expect(new Set(ids).size).toBe(24);
        expect(ids).toHaveLength(24);
        expect(dates).toEqual([...dates].sort());
        expect(dates.at(-1)).toBe('2000-01-12');
        const summary = (await b.agent.get(`${base}/today`).expect(200)).body
            .routine.data;
        expect(summary.counts.totalCount).toBe(24);
        expect(summary.items).toHaveLength(4);
        expect(summary.hasMore).toBe(true);
    });
    it('retains an old pending Tuesday when Friday is completed, preserving assignee and executor history', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}`,
            r = (
                await f.a
                    .post(
                        `${base}/task-recurrences`,
                        input(
                            { frequency: 'WEEKDAYS', weekdays: [2, 5] },
                            { assigneeMemberId: f.mb, endsOn: '2026-10-20' },
                        ),
                    )
                    .expect(201)
            ).body,
            path = `${base}/task-recurrences/${r.id}`;
        const first = (
            await f.a
                .post(
                    `${path}/occurrences/2026-10-16/complete`,
                    occurrenceInput,
                )
                .expect(200)
        ).body;
        expect(first).toMatchObject({
            version: 1,
            assignee: { memberId: f.mb },
            completion: {
                executor: { memberId: f.ma },
                assignee: { memberId: f.mb },
            },
        });
        expect(
            (await f.a.agent.get(`${path}/occurrences/2026-10-13`).expect(200))
                .body,
        ).toMatchObject({
            status: 'PENDING',
            materialized: false,
            conditions: { overdue: true },
        });
        await f.b
            .post(`${path}/occurrences/2026-10-16/reopen`, {
                ...occurrenceInput,
                expectedOccurrenceVersion: 1,
            })
            .expect(200);
        await f.b
            .post(`${path}/occurrences/2026-10-16/complete`, {
                ...occurrenceInput,
                expectedOccurrenceVersion: 2,
            })
            .expect(200);
        const history = (
            await f.a.agent
                .get(`${path}/occurrences/2026-10-16/history`)
                .expect(200)
        ).body.items;
        expect(history.map((e: { type: string }) => e.type)).toEqual([
            'COMPLETED',
            'REOPENED',
            'COMPLETED',
        ]);
        expect(history[0].data.after.executor.memberId).toBe(f.ma);
        expect(history[2].data.after.executor.memberId).toBe(f.mb);
        const list = (
            await f.a.agent
                .get(`${base}/tasks?from=2026-10-13&to=2026-10-20&status=ALL`)
                .expect(200)
        ).body;
        expect(
            list.items.filter(
                (o: { scheduledDate: string }) =>
                    o.scheduledDate === '2026-10-16',
            ),
        ).toHaveLength(1);
        expect(
            (await db.query('SELECT * FROM routine_task_occurrences')).length,
        ).toBe(1);
    });
    it('continues across urgency groups and no-deadline identities without losing series', async () => {
        const { b, base } = await personal();
        for (const urgency of ['HIGH', 'LOW'])
            await b
                .post(
                    `${base}/task-recurrences`,
                    input(
                        { frequency: 'DAILY' },
                        {
                            startsOn: '2026-10-16',
                            endsOn: '2026-10-20',
                            urgency,
                        },
                    ),
                )
                .expect(201);
        let page = (await b.agent.get(`${base}/tasks?limit=2`).expect(200))
            .body;
        const items: { id: string; urgency: string; scheduledDate: string }[] =
            [];
        for (let i = 0; i < 10; i++) {
            items.push(...page.items);
            if (!page.nextCursor) break;
            page = (
                await b.agent
                    .get(`${base}/tasks?limit=2&cursor=${page.nextCursor}`)
                    .expect(200)
            ).body;
        }
        expect(items.map((o) => `${o.urgency}/${o.scheduledDate}`)).toEqual([
            'HIGH/2026-10-16',
            'HIGH/2026-10-17',
            'LOW/2026-10-16',
            'LOW/2026-10-17',
            'HIGH/2026-10-18',
            'LOW/2026-10-18',
            'HIGH/2026-10-19',
            'HIGH/2026-10-20',
            'LOW/2026-10-19',
            'LOW/2026-10-20',
        ]);
        for (let i = 0; i < 2; i++)
            await b
                .post(
                    `${base}/task-recurrences`,
                    input(
                        { frequency: 'DAILY' },
                        { startsOn: '2026-10-01', deadline: null },
                    ),
                )
                .expect(201);
        page = (
            await b.agent
                .get(`${base}/tasks?attention=NO_DEADLINE&limit=3`)
                .expect(200)
        ).body;
        const ids: string[] = [];
        for (let i = 0; i < 20; i++) {
            ids.push(...page.items.map((o: { id: string }) => o.id));
            if (!page.nextCursor) break;
            page = (
                await b.agent
                    .get(
                        `${base}/tasks?attention=NO_DEADLINE&limit=3&cursor=${page.nextCursor}`,
                    )
                    .expect(200)
            ).body;
        }
        expect(ids).toHaveLength(36);
        expect(new Set(ids).size).toBe(36);
    });
    it('validates malformed rule cursors and keeps civil extremes within the supported calendar', async () => {
        const { b, base } = await personal();
        for (let i = 0; i < 2; i++)
            await b.post(`${base}/task-recurrences`, input()).expect(201);
        const page = (
            await b.agent.get(`${base}/task-recurrences?limit=1`).expect(200)
        ).body;
        const invalid = JSON.parse(
            Buffer.from(page.nextCursor, 'base64url').toString(),
        );
        invalid.key = '-'.repeat(36);
        await b.agent
            .get(
                `${base}/task-recurrences?cursor=${Buffer.from(JSON.stringify(invalid)).toString('base64url')}`,
            )
            .expect(400);
        for (const query of ['to=0001-01-01', 'from=9999-12-31'])
            await b.agent.get(`${base}/tasks?${query}`).expect(200);
        await b.agent
            .get(
                `${base}/task-recurrences/${page.items[0].id}/occurrences?from=9999-12-31`,
            )
            .expect(200);
    });
    it('continues a one-item page through alternating materialized gaps', async () => {
        const { b, base } = await personal(),
            r = (
                await b
                    .post(
                        `${base}/task-recurrences`,
                        input({ frequency: 'DAILY' }, { endsOn: '2026-10-17' }),
                    )
                    .expect(201)
            ).body,
            path = `${base}/task-recurrences/${r.id}`;
        for (const date of ['2026-10-14', '2026-10-16'])
            await b
                .post(`${path}/occurrences/${date}/skip`, occurrenceInput)
                .expect(200);
        let page = (await b.agent.get(`${base}/tasks?limit=1`).expect(200))
            .body;
        const dates: string[] = [];
        for (let i = 0; i < 5; i++) {
            dates.push(
                ...page.items.map(
                    (o: { scheduledDate: string }) => o.scheduledDate,
                ),
            );
            if (!page.nextCursor) break;
            page = (
                await b.agent
                    .get(`${base}/tasks?limit=1&cursor=${page.nextCursor}`)
                    .expect(200)
            ).body;
        }
        expect(dates).toEqual(['2026-10-13', '2026-10-15', '2026-10-17']);
        expect(page.counts.totalCount).toBe(3);
    });
    it('skips only Saturday, preserves the series and does not manufacture overdue for no-deadline tasks', async () => {
        const { b, base } = await personal(),
            r = (
                await b
                    .post(
                        `${base}/task-recurrences`,
                        input(
                            { frequency: 'DAILY' },
                            { deadline: null, endsOn: '2026-10-20' },
                        ),
                    )
                    .expect(201)
            ).body,
            path = `${base}/task-recurrences/${r.id}`;
        await b
            .post(`${path}/occurrences/2026-10-17/skip`, occurrenceInput)
            .expect(200);
        expect(
            (await b.agent.get(`${path}/occurrences/2026-10-18`).expect(200))
                .body,
        ).toMatchObject({
            status: 'PENDING',
            deadline: null,
            conditions: { overdue: false },
        });
        expect(
            (await b.agent.get(`${base}/tasks?attention=OVERDUE`).expect(200))
                .body.counts.totalCount,
        ).toBe(0);
        const noDeadline = (
            await b.agent.get(`${base}/tasks?attention=NO_DEADLINE`).expect(200)
        ).body;
        expect(noDeadline.counts.totalCount).toBe(5);
        expect(
            noDeadline.items.every(
                (o: { scheduledDate: string }) =>
                    o.scheduledDate <= '2026-10-18',
            ),
        ).toBe(true);
        const future = (
            await b.agent
                .get(
                    `${base}/tasks?attention=NO_DEADLINE&from=2026-10-19&to=2026-10-19`,
                )
                .expect(200)
        ).body;
        expect(future.items).toHaveLength(1);
        await b
            .post(`${path}/occurrences/2026-10-17/reopen`, {
                ...occurrenceInput,
                expectedOccurrenceVersion: 1,
            })
            .expect(409);
        expect((await b.agent.get(path).expect(200)).body.status).toBe(
            'ACTIVE',
        );
    });
    it('cancels at the local day and preserves past virtual dates and already materialized future facts', async () => {
        const { b, base } = await personal(),
            r = (await b.post(`${base}/task-recurrences`, input()).expect(201))
                .body,
            path = `${base}/task-recurrences/${r.id}`;
        await b
            .post(`${path}/occurrences/2026-10-25/complete`, occurrenceInput)
            .expect(200);
        instant = '2026-10-19T01:00:00Z';
        const cancelled = (
            await b.post(`${path}/cancel`, { expectedVersion: 1 }).expect(200)
        ).body;
        expect(cancelled).toMatchObject({
            version: 2,
            status: 'CANCELLED',
            cancelledOn: '2026-10-18',
        });
        await b
            .post(`${path}/occurrences/2026-10-13/skip`, {
                ...occurrenceInput,
                expectedRecurrenceVersion: 2,
            })
            .expect(200);
        await b
            .post(`${path}/occurrences/2026-10-18/complete`, {
                ...occurrenceInput,
                expectedRecurrenceVersion: 2,
            })
            .expect(200);
        await b.agent.get(`${path}/occurrences/2026-10-19`).expect(404);
        await b
            .post(`${path}/occurrences/2026-10-19/complete`, {
                ...occurrenceInput,
                expectedRecurrenceVersion: 2,
            })
            .expect(404);
        await b
            .post(`${path}/occurrences/2026-10-25/reopen`, {
                expectedRecurrenceVersion: 2,
                expectedOccurrenceVersion: 1,
            })
            .expect(200);
        expect(
            (await b.agent.get(`${path}/occurrences/2026-10-25`).expect(200))
                .body.status,
        ).toBe('PENDING');
        const replacement = (
            await b
                .post(
                    `${base}/task-recurrences`,
                    input({ frequency: 'WEEKLY', weekday: 1 }),
                )
                .expect(201)
        ).body;
        expect(replacement.id).not.toBe(r.id);
        const history = (await b.agent.get(`${path}/history`).expect(200)).body
            .items;
        expect(history.map((e: { type: string }) => e.type)).toEqual([
            'RECURRENCE_CREATED',
            'RECURRENCE_CANCELLED',
        ]);
    });
    it('serializes competing materialization, replay and cancellation without incompatible facts', async () => {
        const { b, base } = await personal(),
            r = (await b.post(`${base}/task-recurrences`, input()).expect(201))
                .body,
            path = `${base}/task-recurrences/${r.id}`,
            key = randomUUID();
        const replay = await Promise.all([
            b.post(
                `${path}/occurrences/2026-10-17/complete`,
                occurrenceInput,
                key,
            ),
            b.post(
                `${path}/occurrences/2026-10-17/complete`,
                occurrenceInput,
                key,
            ),
        ]);
        expect(replay.map((r) => r.status)).toEqual([200, 200]);
        expect(replay[0].body).toEqual(replay[1].body);
        const race = await Promise.all([
            b.post(`${path}/occurrences/2026-10-16/complete`, occurrenceInput),
            b.post(`${path}/occurrences/2026-10-16/skip`, occurrenceInput),
        ]);
        expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
        const cutoff = await Promise.all([
            b.post(`${path}/cancel`, { expectedVersion: 1 }),
            b.post(`${path}/occurrences/2026-10-22/complete`, occurrenceInput),
        ]);
        expect(cutoff[0].status).toBe(200);
        expect([200, 409]).toContain(cutoff[1].status);
        const rows = await db.query(
            'SELECT scheduled_date::text date,status FROM routine_task_occurrences WHERE recurrence_id=$1 ORDER BY scheduled_date',
            [r.id],
        );
        expect(
            rows.filter((o: { date: string }) => o.date === '2026-10-17'),
        ).toHaveLength(1);
        expect(
            rows.filter((o: { date: string }) => o.date === '2026-10-22'),
        ).toHaveLength(cutoff[1].status === 200 ? 1 : 0);
        expect(
            (
                await b
                    .post(
                        `${path}/occurrences/2026-10-17/complete`,
                        occurrenceInput,
                        key,
                    )
                    .expect(200)
            ).body,
        ).toEqual(replay[0].body);
    });
    it('rolls back first materialization, history, receipt and audit on either failure point', async () => {
        const { b, base } = await personal(),
            r = (await b.post(`${base}/task-recurrences`, input()).expect(201))
                .body,
            path = `${base}/task-recurrences/${r.id}/occurrences/2026-10-17/skip`,
            key = randomUUID();
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        for (const [table, condition] of [
            ['routine_history', "type<>'SKIPPED'"],
            ['routine_command_audit', "action<>'SKIP_TASK_OCCURRENCE'"],
        ]) {
            const before = await routineSnapshot(db);
            await db.query(
                `ALTER TABLE ${table} ADD CONSTRAINT test_reject CHECK (${condition})`,
            );
            try {
                await b.post(path, occurrenceInput, key).expect(500);
                expect(await routineSnapshot(db)).toEqual(before);
            } finally {
                await db.query(
                    `ALTER TABLE ${table} DROP CONSTRAINT test_reject`,
                );
            }
        }
        await b.post(path, occurrenceInput, key).expect(200);
        expect(
            (await db.query('SELECT * FROM routine_task_occurrences')).length,
        ).toBe(1);
    });
    it('validates the rule, period, destination and expected tokens without exposing occurrence editors', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}`;
        for (const rule of [
            { frequency: 'WEEKDAYS', weekdays: [] },
            { frequency: 'WEEKDAYS', weekdays: [1, 1] },
            { frequency: 'ANNUAL', month: 4, day: 31 },
            { frequency: 'CRON', cron: '* * * * *' },
        ]) {
            const r = await f.a
                .post(`${base}/task-recurrences`, input(rule))
                .expect(400);
            expect(r.body.details.fields[0].field).toContain('rule');
        }
        const r = (
                await f.a
                    .post(
                        `${base}/task-recurrences`,
                        input({ frequency: 'WEEKLY', weekday: 2 }),
                    )
                    .expect(201)
            ).body,
            path = `${base}/task-recurrences/${r.id}`;
        await f.a.agent
            .get(`${path}/occurrences?from=2025-01-01&to=2026-10-18`)
            .expect(400);
        await f.a.agent
            .get(`${base}/tasks?from=2025-01-01&to=2026-10-18`)
            .expect(400);
        await f.a
            .post(`${path}/occurrences/2026-10-14/complete`, occurrenceInput)
            .expect(404);
        await f.a
            .post(`${path}/occurrences/2026-10-13/complete`, {
                ...occurrenceInput,
                expectedOccurrenceVersion: 1,
            })
            .expect(409);
        await f.a
            .post(`${base}/tasks/${r.id}/deadline`, {
                expectedVersion: 1,
                deadline: null,
            })
            .expect(404);
        await f.a
            .post(`${path}/occurrences/2026-10-13/deadline`, {
                expectedVersion: 1,
                deadline: null,
            })
            .expect(404);
        await f.a.agent
            .get(
                `/v2/spaces/${f.a.context.personalSpace.id}/task-recurrences/${r.id}`,
            )
            .expect(404);
        await db.query("UPDATE spaces SET status='CLOSING' WHERE id=$1", [
            f.space,
        ]);
        await f.a.agent.get(path).expect(200);
        await f.a
            .post(`${path}/occurrences/2026-10-13/complete`, occurrenceInput)
            .expect(409);
    });
    it('paginates occurrence and rule history', async () => {
        const { b, base } = await personal(),
            r = (await b.post(`${base}/task-recurrences`, input()).expect(201))
                .body,
            path = `${base}/task-recurrences/${r.id}`;
        let page = (
            await b.agent
                .get(
                    `${path}/occurrences?from=2026-10-13&to=2026-10-18&limit=2`,
                )
                .expect(200)
        ).body;
        const dates: string[] = [];
        while (true) {
            dates.push(
                ...page.items.map(
                    (o: { scheduledDate: string }) => o.scheduledDate,
                ),
            );
            if (!page.nextCursor) break;
            page = (
                await b.agent
                    .get(
                        `${path}/occurrences?from=2026-10-13&to=2026-10-18&limit=2&cursor=${page.nextCursor}`,
                    )
                    .expect(200)
            ).body;
        }
        expect(dates).toHaveLength(6);
        expect(new Set(dates).size).toBe(6);
        const key = randomUUID(),
            command = { expectedVersion: 1 };
        const cancelled = (
            await b.post(`${path}/cancel`, command, key).expect(200)
        ).body;
        expect(
            (await b.post(`${path}/cancel`, command, key).expect(200)).body,
        ).toEqual(cancelled);
        const history = (
            await b.agent.get(`${path}/history?limit=1`).expect(200)
        ).body;
        expect(
            (
                await b.agent
                    .get(`${path}/history?limit=1&cursor=${history.nextCursor}`)
                    .expect(200)
            ).body.items[0].type,
        ).toBe('RECURRENCE_CANCELLED');
    });
});
