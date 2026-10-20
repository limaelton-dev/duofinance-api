import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
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
    ROUTINE_ATTENTION_QUERY,
    RoutineAttentionUnavailableError,
    type RoutineAttentionQueryPort,
} from '../dist/modules/routine/application/ports/public/routine-attention-query.port.js';
import {
    FINANCE_TODAY_QUERY_PORT,
    FinanceTodayUnavailableError,
    type FinanceTodayQueryPort,
} from '../dist/modules/finances/application/ports/public/finance-today-query.port.js';
import {
    TASK_ATTENTION_READER,
    type TaskAttentionReader,
} from '../dist/modules/routine/application/task-attention-reader.js';
import { EntityManagerProvider } from '../dist/shared/technical/database/typeorm/entity-manager.provider.js';
import {
    SPACE_PARTICIPANTS_PORT,
    type SpaceParticipantsPort,
} from '../dist/modules/spaces/application/ports/public/space-participants.port.js';
import { SpacesDomainError } from '../dist/modules/spaces/domain/errors/spaces-domain.error.js';
describe('attention HTTP/PostgreSQL', () => {
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
    it('filters urgency, overdue, today, upcoming and no deadline independently and orders groups', async () => {
        const b = await financeBrowser(app),
            base = `/v2/spaces/${b.context.personalSpace.id}`;
        for (const task of [
            { description: 'Ontem', deadline: { date: '2026-10-17' } },
            {
                description: 'Amanhã urgente',
                urgency: 'URGENT',
                deadline: { date: '2026-10-19' },
            },
            { description: 'Urgente sem prazo', urgency: 'URGENT' },
            { description: 'Hoje', deadline: { date: '2026-10-18' } },
            { description: 'High', urgency: 'HIGH' },
        ])
            await b.post(`${base}/tasks`, task).expect(201);
        const names = async (filter: string) =>
            (
                await b.agent
                    .get(`${base}/tasks?attention=${filter}`)
                    .expect(200)
            ).body.items.map((t: { description: string }) => t.description);
        expect(await names('URGENT')).toEqual([
            'Amanhã urgente',
            'Urgente sem prazo',
        ]);
        expect(await names('OVERDUE')).toEqual(['Ontem']);
        expect(await names('TODAY')).toEqual(['Hoje']);
        expect(await names('UPCOMING')).toEqual(['Amanhã urgente']);
        expect(await names('NO_DEADLINE')).toEqual([
            'Urgente sem prazo',
            'High',
        ]);
        expect(
            (await b.agent.get(`${base}/tasks`).expect(200)).body.items.map(
                (t: { description: string }) => t.description,
            ),
        ).toEqual([
            'Ontem',
            'Hoje',
            'Amanhã urgente',
            'Urgente sem prazo',
            'High',
        ]);
        const before = await routineSnapshot(db);
        const today = (await b.agent.get(`${base}/today`).expect(200)).body;
        expect(today.routine).toMatchObject({
            status: 'AVAILABLE',
            data: {
                counts: { totalCount: 4, overdue: 1, today: 1, urgent: 2 },
                hasMore: false,
            },
        });
        expect(today.routine.data.items).toHaveLength(4);
        expect(await routineSnapshot(db)).toEqual(before);
    });
    it('evaluates local time and deduplicates a task that is urgent, today and overdue', async () => {
        const b = await financeBrowser(app),
            base = `/v2/spaces/${b.context.personalSpace.id}`;
        await b
            .post(`${base}/tasks`, {
                description: '10 horas',
                urgency: 'URGENT',
                deadline: { date: '2026-10-18', time: '10:00' },
            })
            .expect(201);
        instant = '2026-10-18T12:00:00Z';
        expect(
            (await b.agent.get(`${base}/tasks?attention=OVERDUE`).expect(200))
                .body.items,
        ).toEqual([]);
        instant = '2026-10-18T14:00:00Z';
        let summary = (await b.agent.get(`${base}/today`).expect(200)).body
            .routine.data;
        expect(summary.counts).toMatchObject({
            totalCount: 1,
            today: 1,
            overdue: 1,
            urgent: 1,
        });
        expect(summary.items).toHaveLength(1);
        instant = '2026-10-19T01:00:00Z';
        summary = (await b.agent.get(`${base}/today`).expect(200)).body.routine
            .data;
        expect(summary.referenceDate).toBe('2026-10-18');
        expect(summary.counts.today).toBe(1);
    });
    it('uses current assignee for Mine and binds cursor to filters and captured time', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}/tasks`;
        for (let i = 0; i < 5; i++)
            await f.a
                .post(base, { description: `B ${i}`, assigneeMemberId: f.mb })
                .expect(201);
        expect(
            (await f.a.agent.get(`${base}?scope=MINE`).expect(200)).body.items,
        ).toEqual([]);
        let page = (
            await f.b.agent.get(`${base}?scope=MINE&limit=2`).expect(200)
        ).body;
        expect(page.counts.totalCount).toBe(5);
        const ids = page.items.map((t: { id: string }) => t.id),
            firstInstant = page.referenceInstant;
        await f.b.agent
            .get(`${base}?scope=ALL&limit=2&cursor=${page.nextCursor}`)
            .expect(400);
        const invalidCursor = JSON.parse(
            Buffer.from(page.nextCursor, 'base64url').toString(),
        );
        invalidCursor.key.instant = '-100000-01-01T00:00:00.000Z';
        await f.b.agent
            .get(
                `${base}?scope=MINE&cursor=${Buffer.from(JSON.stringify(invalidCursor)).toString('base64url')}`,
            )
            .expect(400);
        instant = '2026-10-20T12:00:00Z';
        while (page.nextCursor) {
            page = (
                await f.b.agent
                    .get(`${base}?scope=MINE&limit=2&cursor=${page.nextCursor}`)
                    .expect(200)
            ).body;
            expect(page.referenceInstant).toBe(firstInstant);
            ids.push(...page.items.map((t: { id: string }) => t.id));
        }
        expect(new Set(ids).size).toBe(5);
    });
    it('distinguishes available empty data, limited preview, and localized failures', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}`;
        expect(
            (await f.a.agent.get(`${base}/today`).expect(200)).body.routine,
        ).toMatchObject({
            status: 'AVAILABLE',
            data: { items: [], counts: { totalCount: 0 } },
        });
        for (let i = 0; i < 5; i++)
            await f.a
                .post(`${base}/tasks`, {
                    description: `Urgente ${i}`,
                    urgency: 'URGENT',
                })
                .expect(201);
        const routine = app.get<RoutineAttentionQueryPort>(
                ROUTINE_ATTENTION_QUERY,
            ),
            finance = app.get<FinanceTodayQueryPort>(FINANCE_TODAY_QUERY_PORT);
        let result = (await f.a.agent.get(`${base}/today`).expect(200)).body;
        expect(result.routine.data).toMatchObject({
            hasMore: true,
            counts: { totalCount: 5 },
        });
        expect(result.routine.data.items).toHaveLength(4);
        vi.spyOn(routine, 'read').mockRejectedValueOnce(
            new RoutineAttentionUnavailableError(),
        );
        result = (await f.a.agent.get(`${base}/today`).expect(200)).body;
        expect(result.routine.status).toBe('UNAVAILABLE');
        expect(result.finance.status).toBe('AVAILABLE');
        vi.spyOn(finance, 'read').mockRejectedValueOnce(
            new FinanceTodayUnavailableError(),
        );
        result = (await f.a.agent.get(`${base}/today`).expect(200)).body;
        expect(result.finance.status).toBe('UNAVAILABLE');
        expect(result.routine.status).toBe('AVAILABLE');
        vi.spyOn(routine, 'read').mockRejectedValueOnce(
            new SpacesDomainError('SPACE_NOT_FOUND'),
        );
        await f.a.agent.get(`${base}/today`).expect(404);
    });
    it('keeps counts and page on one read-only snapshot while another connection commits', async () => {
        const b = await financeBrowser(app),
            base = `/v2/spaces/${b.context.personalSpace.id}`,
            actor = b.context.person.id;
        await b.post(`${base}/tasks`, { description: 'Antes' }).expect(201);
        const provider = app.get(EntityManagerProvider),
            get = provider.get.bind(provider);
        let armed = true;
        vi.spyOn(provider, 'get').mockImplementation(() => {
            const manager = get();
            if (armed && manager.queryRunner?.isTransactionActive) {
                armed = false;
                const query = manager.queryRunner.query.bind(
                    manager.queryRunner,
                );
                vi.spyOn(manager.queryRunner, 'query').mockImplementation(
                    async (...args) => {
                        const result = await query(...args);
                        if (String(args[0]).includes('count(*)'))
                            await db.query(
                                "INSERT INTO routine_tasks(id,space_id,description,creator_person_id,assignee_person_id,urgency,status,version,created_at) VALUES(gen_random_uuid(),$1,'Depois',$2,$2,'NORMAL','PENDING',1,now())",
                                [b.context.personalSpace.id, actor],
                            );
                        return result;
                    },
                );
            }
            return manager;
        });
        const page = (await b.agent.get(`${base}/tasks`).expect(200)).body;
        expect(page.counts.totalCount).toBe(1);
        expect(
            page.items.map((t: { description: string }) => t.description),
        ).toEqual(['Antes']);
        vi.restoreAllMocks();
        expect(
            (await b.agent.get(`${base}/tasks`).expect(200)).body.counts
                .totalCount,
        ).toBe(2);
    });
    it('revalidates access after reading and does not hide an adapter authorization error', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}`;
        const reader = app.get<TaskAttentionReader>(TASK_ATTENTION_READER),
            read = reader.read.bind(reader),
            participants = app.get<SpaceParticipantsPort>(
                SPACE_PARTICIPANTS_PORT,
            );
        vi.spyOn(reader, 'read').mockImplementationOnce(async (...args) => {
            const result = await read(...args);
            vi.spyOn(participants, 'read').mockRejectedValue(
                new SpacesDomainError('SPACE_NOT_FOUND'),
            );
            return result;
        });
        await f.a.agent.get(`${base}/tasks`).expect(404);
    });
});
