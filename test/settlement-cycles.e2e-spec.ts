import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { TEST_DATABASE_URL } from './setup-env.js';
import { AppModule } from '../dist/app.module.js';
import { configureApp } from '../dist/configure-app.js';
import migrationSource from '../dist/shared/technical/database/typeorm/data-source.js';
import { FINANCES_CLOCK } from '../dist/modules/finances/application/ports/private/shared-expense.repositories.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../dist/modules/spaces/application/ports/public/space-financial-context.port.js';
import { SpacesDomainError } from '../dist/modules/spaces/domain/errors/spaces-domain.error.js';
import { encodePositionCursor } from '../dist/modules/finances/application/queries/inter-member-position.query.js';
import {
    encodeSettlementListCursor,
    encodeSettlementDetailCursor,
} from '../dist/modules/finances/application/queries/settlement-cycle.queries.js';
import {
    SETTLEMENT_CYCLE_QUERY_PORT,
    type SettlementCycleQueryPort,
} from '../dist/modules/finances/application/ports/public/settlement-cycle-query.port.js';
import { PersonId } from '../dist/modules/spaces/domain/person/person-id.js';
import { SpaceId } from '../dist/modules/spaces/domain/space/space-id.js';

describe('HTTP settlement cycles and authorized origins', () => {
    let app: INestApplication<Server>, db: DataSource, today: string;
    beforeAll(async () => {
        if (
            migrationSource.options.type !== 'postgres' ||
            migrationSource.options.url !== TEST_DATABASE_URL
        )
            throw new Error('Expected disposable PostgreSQL');
        await migrationSource.initialize();
        try {
            await migrationSource.dropDatabase();
            await migrationSource.runMigrations();
        } finally {
            await migrationSource.destroy();
        }
    });
    beforeEach(async () => {
        today = '2026-10-10';
        const module = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(FINANCES_CLOCK)
            .useValue({
                now: () => new Date(today + 'T15:00:00Z'),
                today: () => today,
            })
            .compile();
        app = module.createNestApplication();
        configureApp(app);
        await app.init();
        db = app.get(DataSource);
        await db.query('TRUNCATE persons CASCADE');
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await app?.close();
    });
    async function browser(name: string) {
        const agent = request.agent(app.getHttpServer()),
            csrf = (await agent.get('/v2/auth/csrf').expect(200)).body
                .csrfToken;
        const context = (
            await agent
                .post('/v2/auth/register')
                .set('Origin', 'http://localhost:3000')
                .set('X-CSRF-Token', csrf)
                .send({
                    displayName: name,
                    email: randomUUID() + '@example.com',
                    password: 'uma-senha-de-teste',
                })
                .expect(201)
        ).body;
        const token = (await agent.get('/v2/auth/csrf').expect(200)).body
            .csrfToken;
        return {
            agent,
            context,
            post: (url: string, body: object) =>
                agent
                    .post(url)
                    .set('Origin', 'http://localhost:3000')
                    .set('X-CSRF-Token', token)
                    .set('Idempotency-Key', randomUUID())
                    .send(body),
        };
    }
    async function shared(two = true) {
        const a = await browser('Pessoa A'),
            b = two ? await browser('Pessoa B') : null,
            created = (await a.post('/v2/spaces', { name: 'Casa' }).expect(201))
                .body,
            space = created.space.id as string;
        if (b)
            await b
                .post('/v2/invitations/respond', {
                    token: new URLSearchParams(
                        new URL(created.inviteUrl).hash.slice(1),
                    ).get('token'),
                    decision: 'ACCEPT',
                    expectedVersion: created.space.version,
                })
                .expect(200);
        const context = (
            await a.agent
                .get(`/v2/spaces/${space}/financial-entry-context`)
                .expect(200)
        ).body;
        const ma = context.members.find(
                (m: { personId: string }) => m.personId === a.context.person.id,
            ).memberId as string,
            mb = b
                ? (context.members.find(
                      (m: { personId: string }) =>
                          m.personId === b.context.person.id,
                  ).memberId as string)
                : ma;
        return { a, b, space, context, ma, mb };
    }
    const path = (space: string, cycle?: string) =>
        `/v2/spaces/${space}/settlement-cycles` + (cycle ? '/' + cycle : '');
    function expense(
        f: Awaited<ReturnType<typeof shared>>,
        amount = 35000,
        payer = f.mb,
        date: string | null = '2026-10-31',
    ) {
        return {
            expectedSpaceVersion: f.context.version,
            description: 'Mercado',
            amountInCents: amount,
            factDate: '2026-08-05',
            responsibilitySplit: {
                mode: 'AMOUNTS',
                shares: f.b
                    ? [
                          {
                              memberId: f.ma,
                              amountInCents: payer === f.mb ? amount : 0,
                          },
                          {
                              memberId: f.mb,
                              amountInCents: payer === f.ma ? amount : 0,
                          },
                      ]
                    : [{ memberId: f.ma, amountInCents: amount }],
            },
            disbursement: { payerMemberId: payer, method: 'DEBIT' },
            settlement: date
                ? { mode: 'DATE', targetDate: date }
                : { mode: 'NONE' },
        };
    }
    const record = (
        f: Awaited<ReturnType<typeof shared>>,
        amount = 35000,
        payer = f.mb,
        date: string | null = '2026-10-31',
    ) =>
        f.a
            .post(
                `/v2/spaces/${f.space}/shared-cash-expenses`,
                expense(f, amount, payer, date),
            )
            .expect(201)
            .then((r) => r.body);
    async function emptyCycle(space: string, date = '2026-10-31') {
        const id = randomUUID();
        await db.query(
            `INSERT INTO settlement_cycles(id,space_id,target_date,status,version,finalized_at) VALUES($1,$2,$3,'OPEN',1,NULL)`,
            [id, space, date],
        );
        return id;
    }
    async function financialState() {
        const state: Record<string, unknown> = {};
        for (const table of [
            'financial_commitments',
            'financial_commitment_versions',
            'financial_commitment_shares',
            'financial_disbursements',
            'inter_member_obligations',
            'inter_member_obligation_changes',
            'settlement_cycles',
            'financial_expense_command_receipts',
            'default_settlement_rules',
            'default_settlement_rule_changes',
            'finances_command_receipts',
        ])
            state[table] = await db.query(
                `SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`,
            );
        return state;
    }
    it('follows real expense list detail origin with both gross directions and reversed perspective', async () => {
        const f = await shared(),
            payable = await record(f),
            receivable = await record(f, 8000, f.ma),
            id = payable.settlementCycle.id;
        expect(receivable.settlementCycle.id).toBe(id);
        const listed = await f.a.agent.get(path(f.space)).expect(200);
        expect(listed.headers['cache-control']).toBe('no-store');
        expect(listed.body).toMatchObject({
            spaceId: f.space,
            actorMemberId: f.ma,
            referenceDate: today,
            page: { view: 'OPEN', pageSize: 20, nextCursor: null },
        });
        expect(listed.body.items).toEqual([
            expect.objectContaining({
                id,
                targetDate: '2026-10-31',
                status: 'OPEN',
                isOverdue: false,
                obligationCount: 2,
                openObligationCount: 2,
                totals: {
                    originalAmountInCents: '43000',
                    recognizedAmountInCents: '43000',
                    resolvedAmountInCents: '0',
                    remainingAmountInCents: '43000',
                    transferredAmountInCents: '0',
                    compensatedAmountInCents: '0',
                    waivedAmountInCents: '0',
                    reversedTransferredAmountInCents: '0',
                    effectiveTransferredAmountInCents: '0',
                    reversedCompensatedAmountInCents: '0',
                    effectiveCompensatedAmountInCents: '0',
                },
                position: {
                    payableAmountInCents: '35000',
                    receivableAmountInCents: '8000',
                    net: { direction: 'PAYABLE', amountInCents: '27000' },
                },
            }),
        ]);
        const detailed = await f.a.agent.get(path(f.space, id)).expect(200);
        expect(detailed.headers['cache-control']).toBe('no-store');
        expect(detailed.body.cycle).toEqual({
            ...listed.body.items[0],
            finalizedAt: null,
            canFinalize: false,
            finalizationBlockReason: 'OPEN_OBLIGATIONS',
        });
        expect(
            detailed.body.items.map((i: { id: string }) => i.id).sort(),
        ).toEqual([payable.obligation.id, receivable.obligation.id].sort());
        for (const item of detailed.body.items) {
            expect(item).toMatchObject({
                version: 1,
                status: 'OPEN',
                factDate: '2026-08-05',
                registeredAt: '2026-10-10T15:00:00.000000Z',
                resolvedAmountInCents: 0,
                origin: { description: 'Mercado' },
            });
            const source = (
                await f.a.agent
                    .get(
                        `/v2/spaces/${f.space}/financial-commitments/${item.origin.commitmentId}`,
                    )
                    .expect(200)
            ).body;
            expect(source.commitment.id).toBe(item.origin.commitmentId);
            expect(source.disbursement.id).toBe(item.origin.disbursementId);
        }
        const reverse = (await f.b!.agent.get(path(f.space, id)).expect(200))
            .body;
        expect(reverse.cycle.position).toEqual({
            payableAmountInCents: '8000',
            receivableAmountInCents: '35000',
            net: { direction: 'RECEIVABLE', amountInCents: '27000' },
        });
        expect(reverse.items).toEqual(detailed.body.items);
        for (const [direction, obligation] of [
            ['PAYABLE', payable.obligation.id],
            ['RECEIVABLE', receivable.obligation.id],
        ]) {
            const filtered = (
                await f.a.agent
                    .get(path(f.space, id) + '?direction=' + direction)
                    .expect(200)
            ).body;
            expect(filtered.cycle).toEqual(detailed.body.cycle);
            expect(filtered.items).toEqual([
                expect.objectContaining({ id: obligation }),
            ]);
        }
    });
    it('balance with positive gross remains overdue without automatic compensation', async () => {
        const f = await shared(),
            first = await record(f, 8000);
        await record(f, 8000, f.ma);
        await db.query(
            'UPDATE settlement_cycles SET target_date=$2 WHERE id=$1',
            [first.settlementCycle.id, '2026-10-09'],
        );
        const before = await financialState(),
            response = (
                await f.a.agent
                    .get(path(f.space, first.settlementCycle.id))
                    .expect(200)
            ).body;
        expect(response.cycle).toMatchObject({
            status: 'OPEN',
            isOverdue: true,
            openObligationCount: 2,
            totals: { remainingAmountInCents: '16000' },
            position: { net: { direction: 'BALANCED', amountInCents: '0' } },
        });
        expect(response.items).toHaveLength(2);
        expect(await financialState()).toEqual(before);
    });
    it('returns reduced zero and empty OPEN reading fixtures with original composition preserved', async () => {
        const f = await shared(),
            partial = await record(f, 50000),
            zero = await record(f, 10000),
            empty = await emptyCycle(f.space, '2026-10-09');
        await db.query(
            "UPDATE inter_member_obligations SET remaining_amount_in_cents=25000,status='PARTIALLY_SETTLED' WHERE id=$1",
            [partial.obligation.id],
        );
        await db.query(
            "UPDATE inter_member_obligations SET remaining_amount_in_cents=0,status='SETTLED' WHERE id=$1",
            [zero.obligation.id],
        );
        const result = (
            await f.a.agent
                .get(path(f.space, partial.settlementCycle.id))
                .expect(200)
        ).body;
        expect(result.cycle).toMatchObject({
            obligationCount: 2,
            openObligationCount: 1,
            totals: {
                originalAmountInCents: '60000',
                recognizedAmountInCents: '60000',
                resolvedAmountInCents: '35000',
                remainingAmountInCents: '25000',
            },
        });
        expect(result.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: partial.obligation.id,
                    originalAmountInCents: 50000,
                    resolvedAmountInCents: 25000,
                    remainingAmountInCents: 25000,
                }),
                expect.objectContaining({
                    id: zero.obligation.id,
                    status: 'SETTLED',
                    resolvedAmountInCents: 10000,
                    remainingAmountInCents: 0,
                }),
            ]),
        );
        expect(
            (await f.a.agent.get(path(f.space, empty)).expect(200)).body,
        ).toMatchObject({
            cycle: {
                status: 'OPEN',
                isOverdue: false,
                obligationCount: 0,
                totals: {
                    originalAmountInCents: '0',
                    recognizedAmountInCents: '0',
                    resolvedAmountInCents: '0',
                    remainingAmountInCents: '0',
                },
            },
            items: [],
        });
        await db.query(
            "UPDATE inter_member_obligations SET remaining_amount_in_cents=0,status='SETTLED' WHERE id=$1",
            [partial.obligation.id],
        );
        expect(
            (await f.a.agent.get(path(f.space)).expect(200)).body.items,
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: partial.settlementCycle.id,
                    status: 'OPEN',
                    isOverdue: false,
                    openObligationCount: 0,
                    totals: {
                        originalAmountInCents: '60000',
                        recognizedAmountInCents: '60000',
                        resolvedAmountInCents: '60000',
                        remainingAmountInCents: '0',
                        transferredAmountInCents: '0',
                        compensatedAmountInCents: '0',
                        waivedAmountInCents: '0',
                        reversedTransferredAmountInCents: '0',
                        effectiveTransferredAmountInCents: '0',
                        reversedCompensatedAmountInCents: '0',
                        effectiveCompensatedAmountInCents: '0',
                    },
                }),
            ]),
        );
    });
    it('creator alone has a valid empty list and unassigned obligations never create a suggested cycle', async () => {
        const alone = await shared(false);
        expect(
            (await alone.a.agent.get(path(alone.space)).expect(200)).body,
        ).toMatchObject({
            members: [expect.objectContaining({ memberId: alone.ma })],
            items: [],
            page: { nextCursor: null },
        });
        const f = await shared();
        await record(f, 35000, f.mb, null);
        expect(
            (await f.a.agent.get(path(f.space)).expect(200)).body.items,
        ).toEqual([]);
        expect(
            (
                await f.a.agent
                    .get(`/v2/spaces/${f.space}/inter-member-position`)
                    .expect(200)
            ).body.items,
        ).toHaveLength(1);
        expect(
            (await f.a.agent.get(path(f.space) + '?view=UPCOMING').expect(200))
                .body.items,
        ).toEqual([]);
    });
    it('filters civil yesterday today tomorrow and rejects an expired upcoming cursor', async () => {
        const f = await shared(),
            ids: string[] = [];
        for (const date of [
            '2026-10-11',
            '2026-10-12',
            '2026-10-13',
            '2027-10-11',
        ])
            ids.push((await record(f, 1, f.mb, date)).settlementCycle.id);
        await db.query(
            'UPDATE settlement_cycles SET target_date=target_date-2 WHERE id=ANY($1::uuid[])',
            [ids.slice(0, 3)],
        );
        const open = (await f.a.agent.get(path(f.space)).expect(200)).body,
            upcoming = (
                await f.a.agent
                    .get(path(f.space) + '?view=UPCOMING')
                    .expect(200)
            ).body;
        expect(
            open.items.map((i: { targetDate: string; isOverdue: boolean }) => [
                i.targetDate,
                i.isOverdue,
            ]),
        ).toEqual([
            ['2026-10-09', true],
            ['2026-10-10', false],
            ['2026-10-11', false],
            ['2027-10-11', false],
        ]);
        expect(upcoming.items.map((i: { id: string }) => i.id)).toEqual(
            ids.slice(1),
        );
        const cursor = encodeSettlementListCursor(
            f.space,
            f.a.context.person.id,
            'UPCOMING',
            today,
            upcoming.items[0],
        );
        today = '2026-10-11';
        expect(
            (
                await f.a.agent
                    .get(path(f.space) + '?view=UPCOMING&cursor=' + cursor)
                    .expect(400)
            ).body,
        ).toMatchObject({
            code: 'VALIDATION_ERROR',
            details: {
                fields: [{ field: 'cursor', messages: expect.any(Array) }],
            },
        });
        expect(
            (
                await f.a.agent
                    .get(path(f.space) + '?view=UPCOMING')
                    .expect(200)
            ).body.items.map((i: { id: string }) => i.id),
        ).toEqual(ids.slice(2));
    });
    it('paginates existing cycle identities through OPEN and UPCOMING', async () => {
        const f = await shared(false);
        await db.query(
            `INSERT INTO settlement_cycles(id,space_id,target_date,status,version) SELECT md5('settlement-cycles-http-cycle-'||n)::uuid,$1,DATE '2026-10-10'+n,'OPEN',1 FROM generate_series(0,42) n`,
            [f.space],
        );
        for (const view of ['OPEN', 'UPCOMING']) {
            const first = (
                    await f.a.agent
                        .get(path(f.space) + '?view=' + view)
                        .expect(200)
                ).body,
                second = (
                    await f.a.agent
                        .get(
                            path(f.space) +
                                '?view=' +
                                view +
                                '&cursor=' +
                                first.page.nextCursor,
                        )
                        .expect(200)
                ).body,
                third = (
                    await f.a.agent
                        .get(
                            path(f.space) +
                                '?view=' +
                                view +
                                '&cursor=' +
                                second.page.nextCursor,
                        )
                        .expect(200)
                ).body;
            expect([
                first.items.length,
                second.items.length,
                third.items.length,
            ]).toEqual([20, 20, 3]);
            expect(third.page.nextCursor).toBeNull();
            const items = [...first.items, ...second.items, ...third.items];
            expect(new Set(items.map((i) => i.id)).size).toBe(43);
            expect(items.map((i) => i.targetDate)).toEqual(
                items.map((i) => i.targetDate).sort(),
            );
        }
    });
    it('detail filters and exhausted pages retain complete totals with microsecond keyset ordering', async () => {
        const f = await shared(),
            ids: string[] = [];
        let cycle = '';
        for (let i = 0; i < 23; i++) {
            const result = await record(f, 1);
            ids.push(result.obligation.id);
            cycle = result.settlementCycle.id;
        }
        await db.query(
            `UPDATE inter_member_obligations SET registered_at='2026-10-10T15:00:00.123455Z' WHERE id=ANY($1::uuid[])`,
            [ids.slice(0, 10)],
        );
        await db.query(
            `UPDATE inter_member_obligations SET registered_at='2026-10-10T15:00:00.123456Z' WHERE id=ANY($1::uuid[])`,
            [ids.slice(10)],
        );
        const first = (await f.a.agent.get(path(f.space, cycle)).expect(200))
                .body,
            second = (
                await f.a.agent
                    .get(
                        path(f.space, cycle) +
                            '?cursor=' +
                            first.page.nextCursor,
                    )
                    .expect(200)
            ).body;
        expect([first.items.length, second.items.length]).toEqual([20, 3]);
        expect(second.page.nextCursor).toBeNull();
        expect([...first.items, ...second.items].map((i) => i.id)).toEqual([
            ...ids.slice(10).sort().reverse(),
            ...ids.slice(0, 10).sort().reverse(),
        ]);
        expect(second.cycle).toEqual(first.cycle);
        expect(first.cycle).toMatchObject({
            obligationCount: 23,
            totals: {
                originalAmountInCents: '23',
                recognizedAmountInCents: '23',
                remainingAmountInCents: '23',
            },
        });
        const filtered = (
            await f.a.agent
                .get(path(f.space, cycle) + '?direction=RECEIVABLE')
                .expect(200)
        ).body;
        expect(filtered.items).toEqual([]);
        expect(filtered.cycle).toEqual(first.cycle);
        const cursor = encodeSettlementDetailCursor(
            f.space,
            f.a.context.person.id,
            cycle,
            'ALL',
            second.items.at(-1),
        );
        const exhausted = (
            await f.a.agent
                .get(path(f.space, cycle) + '?cursor=' + cursor)
                .expect(200)
        ).body;
        expect(exhausted.items).toEqual([]);
        expect(exhausted.cycle).toEqual(first.cycle);
    });
    it('publishes decimal string totals above safe integer and safe individual amounts', async () => {
        const f = await shared(),
            recorded = await record(f, Number.MAX_SAFE_INTEGER);
        await record(f, Number.MAX_SAFE_INTEGER);
        await record(f, 1, f.ma);
        const result = (
            await f.a.agent
                .get(path(f.space, recorded.settlementCycle.id))
                .expect(200)
        ).body;
        expect(result.cycle.totals).toEqual({
            originalAmountInCents: '18014398509481983',
            recognizedAmountInCents: '18014398509481983',
            resolvedAmountInCents: '0',
            remainingAmountInCents: '18014398509481983',
            transferredAmountInCents: '0',
            compensatedAmountInCents: '0',
            waivedAmountInCents: '0',
            reversedTransferredAmountInCents: '0',
            effectiveTransferredAmountInCents: '0',
            reversedCompensatedAmountInCents: '0',
            effectiveCompensatedAmountInCents: '0',
        });
        expect(result.cycle.position.net).toEqual({
            direction: 'PAYABLE',
            amountInCents: '18014398509481981',
        });
        expect(
            result.items.every((i: { originalAmountInCents: number }) =>
                Number.isSafeInteger(i.originalAmountInCents),
            ),
        ).toBe(true);
    });
    it.each([
        'view=OTHER',
        'view=',
        'view=open',
        'view=ARCHIVED',
        'view=OPEN&view=OPEN',
        'cursor=x&cursor=x',
        'cursor=',
        'cursor=x',
        'cursor=' + 'x'.repeat(513),
        'memberId=' + randomUUID(),
        'status=OPEN',
        'period=2026-10',
        'direction=ALL',
        'cycleId=' + randomUUID(),
        'view[]=OPEN',
    ])('rejects invalid list query %s', async (query) => {
        const f = await shared(false),
            response = await f.a.agent
                .get(path(f.space) + '?' + query)
                .expect(400);
        expect(response.body).toMatchObject({
            code: 'VALIDATION_ERROR',
            message: expect.any(String),
            details: { fields: expect.any(Array) },
        });
    });
    it.each([
        'direction=OTHER',
        'direction=',
        'direction=all',
        'direction=ALL&direction=ALL',
        'cursor=x&cursor=x',
        'cursor=',
        'cursor=x',
        'cursor=' + 'x'.repeat(513),
        'memberId=' + randomUUID(),
        'status=OPEN',
        'period=2026-10',
        'view=OPEN',
        'cycleId=' + randomUUID(),
        'direction[]=ALL',
    ])('rejects invalid detail query %s', async (query) => {
        const f = await shared(false),
            cycle = await emptyCycle(f.space),
            response = await f.a.agent
                .get(path(f.space, cycle) + '?' + query)
                .expect(400);
        expect(response.body).toMatchObject({
            code: 'VALIDATION_ERROR',
            message: expect.any(String),
            details: { fields: expect.any(Array) },
        });
    });
    it.each([
        ['invalid', undefined],
        ['invalid', randomUUID()],
        [randomUUID(), 'invalid'],
    ])('validates path UUID %s %s', async (space, cycle) => {
        const a = await browser('Pessoa A'),
            response = await a.agent.get(path(space!, cycle)).expect(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
    });
    it('binds canonical list detail and old position cursors to actor space filters cycle and query type', async () => {
        const f = await shared(),
            recorded = await record(f),
            id = recorded.settlementCycle.id,
            listed = (await f.a.agent.get(path(f.space)).expect(200)).body,
            detailed = (await f.a.agent.get(path(f.space, id)).expect(200))
                .body,
            actor = f.a.context.person.id;
        const listCursor = encodeSettlementListCursor(
                f.space,
                actor,
                'OPEN',
                today,
                listed.items[0],
            ),
            detailCursor = encodeSettlementDetailCursor(
                f.space,
                actor,
                id,
                'ALL',
                detailed.items[0],
            ),
            oldCursor = encodePositionCursor(
                f.space,
                actor,
                'ALL',
                detailed.items[0],
            );
        const requests = [
            () => f.b!.agent.get(path(f.space) + '?cursor=' + listCursor),
            () => f.b!.agent.get(path(f.space, id) + '?cursor=' + detailCursor),
            () =>
                f.a.agent.get(
                    path(f.space) + '?view=UPCOMING&cursor=' + listCursor,
                ),
            () =>
                f.a.agent.get(
                    path(f.space, id) +
                        '?direction=PAYABLE&cursor=' +
                        detailCursor,
                ),
            () => f.a.agent.get(path(f.space) + '?cursor=' + detailCursor),
            () => f.a.agent.get(path(f.space, id) + '?cursor=' + listCursor),
            () => f.a.agent.get(path(f.space, id) + '?cursor=' + oldCursor),
            () => f.a.agent.get(path(f.space) + '?cursor=' + oldCursor),
            () =>
                f.a.agent.get(
                    path(f.space) +
                        '?cursor=' +
                        encodeSettlementListCursor(
                            randomUUID(),
                            actor,
                            'OPEN',
                            today,
                            listed.items[0],
                        ),
                ),
            () =>
                f.a.agent.get(
                    path(f.space, id) +
                        '?cursor=' +
                        encodeSettlementDetailCursor(
                            randomUUID(),
                            actor,
                            id,
                            'ALL',
                            detailed.items[0],
                        ),
                ),
            () =>
                f.a.agent.get(
                    path(f.space, id) +
                        '?cursor=' +
                        encodeSettlementDetailCursor(
                            f.space,
                            actor,
                            randomUUID(),
                            'ALL',
                            detailed.items[0],
                        ),
                ),
            () => f.a.agent.get(path(f.space) + '?cursor=' + listCursor + '='),
            () =>
                f.a.agent.get(
                    path(f.space, id) + '?cursor=' + detailCursor + '=',
                ),
        ];
        for (const next of requests)
            expect((await next().expect(400)).body).toMatchObject({
                code: 'VALIDATION_ERROR',
                details: {
                    fields: [{ field: 'cursor', messages: expect.any(Array) }],
                },
            });
    });
    it('requires a session and authorizes reads without CSRF or idempotency command headers', async () => {
        for (const route of [
            path(randomUUID()),
            path(randomUUID(), randomUUID()),
        ])
            await request(app.getHttpServer()).get(route).expect(401);
        const f = await shared(false),
            id = await emptyCycle(f.space);
        await f.a.agent.get(path(f.space)).expect(200);
        await f.a.agent.get(path(f.space, id)).expect(200);
    });
    it('denies outsiders absent spaces and personal spaces with generic envelopes', async () => {
        const f = await shared(false),
            outsider = await browser('Pessoa externa'),
            id = await emptyCycle(f.space),
            [personal] = await db.query(
                `SELECT id FROM spaces WHERE type='PERSONAL' AND personal_owner_person_id=$1`,
                [f.a.context.person.id],
            );
        for (const cycle of [undefined, id]) {
            expect(
                (await outsider.agent.get(path(f.space, cycle)).expect(404))
                    .body.code,
            ).toBe('SPACE_NOT_FOUND');
            expect(
                (await f.a.agent.get(path(randomUUID(), cycle)).expect(404))
                    .body.code,
            ).toBe('SPACE_NOT_FOUND');
            expect(
                (await f.a.agent.get(path(personal.id, cycle)).expect(409)).body
                    .code,
            ).toBe('SHARED_SPACE_REQUIRED');
        }
    });
    it('other-space and missing cycles or direct origins never reveal foreign data', async () => {
        const f = await shared(),
            recorded = await record(f),
            other = (
                await f.a.post('/v2/spaces', { name: 'Outra casa' }).expect(201)
            ).body.space.id;
        for (const [space, cycle] of [
            [other, recorded.settlementCycle.id],
            [f.space, randomUUID()],
        ])
            expect(
                (await f.a.agent.get(path(space, cycle)).expect(404)).body,
            ).toMatchObject({
                code: 'SETTLEMENT_CYCLE_NOT_FOUND',
                message: 'Acerto não encontrado.',
            });
        expect(
            (
                await f.a.agent
                    .get(
                        `/v2/spaces/${other}/financial-commitments/${recorded.commitment.id}`,
                    )
                    .expect(404)
            ).body.code,
        ).toBe('FINANCIAL_COMMITMENT_NOT_FOUND');
        const outsider = await browser('Pessoa externa');
        expect(
            (
                await outsider.agent
                    .get(
                        `/v2/spaces/${f.space}/financial-commitments/${recorded.commitment.id}`,
                    )
                    .expect(404)
            ).body.code,
        ).toBe('SPACE_NOT_FOUND');
    });
    it.each(['list', 'detail'])(
        'reauthorizes %s after the financial read and suppresses lost access',
        async (kind) => {
            const f = await shared(false),
                id = await emptyCycle(f.space),
                access = app.get<SpaceFinancialContextPort>(
                    SPACE_FINANCIAL_CONTEXT_PORT,
                ),
                original = access.read.bind(access);
            vi.spyOn(access, 'read')
                .mockImplementationOnce(original)
                .mockRejectedValueOnce(
                    new SpacesDomainError('SPACE_NOT_FOUND'),
                );
            const response = await f.a.agent
                .get(path(f.space, kind === 'detail' ? id : undefined))
                .expect(404);
            expect(response.body.code).toBe('SPACE_NOT_FOUND');
            expect(response.body).not.toHaveProperty('items');
        },
    );
    it.each(['CLOSING', 'CLOSED'])(
        'permits accessible %s and FINALIZED detail reading fixtures',
        async (status) => {
            const f = await shared(),
                recorded = await record(f),
                id = recorded.settlementCycle.id;
            await db.query('UPDATE spaces SET status=$2 WHERE id=$1', [
                f.space,
                status,
            ]);
            await db.query(
                `UPDATE settlement_cycles SET status='FINALIZED',finalized_at='2026-10-10T15:01:00.123456Z',version=2 WHERE id=$1`,
                [id],
            );
            const before = await financialState();
            expect(
                (await f.a.agent.get(path(f.space, id)).expect(200)).body,
            ).toMatchObject({
                spaceStatus: status,
                cycle: {
                    status: 'FINALIZED',
                    version: 2,
                    finalizedAt: '2026-10-10T15:01:00.123456Z',
                    isOverdue: false,
                },
            });
            expect(
                (await f.a.agent.get(path(f.space)).expect(200)).body,
            ).toMatchObject({ spaceStatus: status, items: [] });
            expect(await financialState()).toEqual(before);
        },
    );
    it('REST upcoming and the public port return identical authorized DTOs', async () => {
        const f = await shared(),
            recorded = await record(f),
            port = app.get<SettlementCycleQueryPort>(
                SETTLEMENT_CYCLE_QUERY_PORT,
            );
        const response = (
            await f.a.agent.get(path(f.space) + '?view=UPCOMING').expect(200)
        ).body;
        expect(
            await port.upcoming(
                PersonId.from(f.a.context.person.id),
                SpaceId.from(f.space),
            ),
        ).toEqual(response);
        const cursor = encodeSettlementListCursor(
            f.space,
            f.a.context.person.id,
            'UPCOMING',
            today,
            response.items[0],
        );
        expect(
            await port.upcoming(
                PersonId.from(f.a.context.person.id),
                SpaceId.from(f.space),
                cursor,
            ),
        ).toEqual(
            (
                await f.a.agent
                    .get(path(f.space) + '?view=UPCOMING&cursor=' + cursor)
                    .expect(200)
            ).body,
        );
        expect(response.items[0].id).toBe(recorded.settlementCycle.id);
    });
    it('retry and repeated GET success or validation errors preserve all financial tables', async () => {
        const f = await shared(),
            recorded = await record(f),
            id = recorded.settlementCycle.id,
            before = await financialState();
        const initial = (await f.a.agent.get(path(f.space)).expect(200)).body,
            detail = (await f.a.agent.get(path(f.space, id)).expect(200)).body;
        for (let i = 0; i < 3; i++) {
            expect(
                (await f.a.agent.get(path(f.space)).expect(200)).body,
            ).toEqual(initial);
            expect(
                (await f.a.agent.get(path(f.space, id)).expect(200)).body,
            ).toEqual(detail);
            await f.a.agent.get(path(f.space) + '?view=UPCOMING').expect(200);
        }
        await f.a.agent.get(path(f.space) + '?cursor=x').expect(400);
        await f.a.agent.get(path(f.space, randomUUID())).expect(404);
        expect(await financialState()).toEqual(before);
    });
    it('OpenAPI declares routes filters fixed pages exact totals timestamps and generic missing cycle', async () => {
        const doc = (
            await request(app.getHttpServer())
                .get('/v2/openapi.json')
                .expect(200)
        ).body;
        const list = doc.paths['/v2/spaces/{spaceId}/settlement-cycles'].get,
            detail =
                doc.paths['/v2/spaces/{spaceId}/settlement-cycles/{cycleId}']
                    .get;
        expect(list.operationId).toBe('getSettlementCycles');
        expect(detail.operationId).toBe('getSettlementCycle');
        expect(list.parameters.map((p: { name: string }) => p.name)).toEqual([
            'spaceId',
            'view',
            'cursor',
        ]);
        expect(detail.parameters.map((p: { name: string }) => p.name)).toEqual([
            'spaceId',
            'cycleId',
            'direction',
            'cursor',
        ]);
        expect(list.parameters[1].schema.enum).toEqual([
            'OPEN',
            'UPCOMING',
            'OVERDUE',
            'FINALIZED',
        ]);
        expect(detail.parameters[2].schema.enum).toEqual([
            'ALL',
            'PAYABLE',
            'RECEIVABLE',
        ]);
        for (const operation of [list, detail]) {
            expect(operation.parameters.at(-1).schema.maxLength).toBe(512);
            expect(
                operation.responses['200'].headers['Cache-Control'],
            ).toBeDefined();
            expect(operation.responses['400']).toBeDefined();
            expect(operation.responses['401']).toBeDefined();
            expect(operation.responses['404']).toBeDefined();
            expect(operation.responses['409']).toBeDefined();
        }
        for (const name of [
            'SettlementCyclesResponse',
            'SettlementCycleResponse',
        ]) {
            const schema = doc.components.schemas[name];
            expect(schema.additionalProperties).toBe(false);
            expect(schema.properties.items.maxItems).toBe(20);
            expect(schema.properties.page.properties.pageSize.enum).toEqual([
                20,
            ]);
            expect(schema.properties.referenceDate.format).toBe('date');
            expect(schema.properties).not.toHaveProperty('replayed');
        }
        const summary = doc.components.schemas.SettlementCycleSummary,
            cycle = doc.components.schemas.SettlementCycleDetail,
            obligation = doc.components.schemas.SettlementCycleObligation;
        for (const amount of [
            'originalAmountInCents',
            'recognizedAmountInCents',
            'resolvedAmountInCents',
            'remainingAmountInCents',
            'transferredAmountInCents',
        ])
            expect(summary.properties.totals.properties[amount].type).toBe(
                'string',
            );
        expect(summary.properties.status.enum).toEqual(['OPEN', 'FINALIZED']);
        expect(cycle.properties.status.enum).toEqual(['OPEN', 'FINALIZED']);
        expect(cycle.properties.finalizedAt.oneOf).toEqual([
            { type: 'null' },
            { type: 'string', format: 'date-time' },
        ]);
        expect(obligation.properties.origin.$ref).toBe(
            '#/components/schemas/InterMemberObligationOrigin',
        );
        const origin = doc.components.schemas.InterMemberObligationOrigin;
        expect(origin.oneOf).toHaveLength(4);
        for (const variant of origin.oneOf)
            expect(variant.properties.commitmentId.format).toBe('uuid');
        for (const factId of [
            'disbursementId',
            'receiptId',
            'externalLiabilityId',
            'closureAgreementId',
        ])
            expect(
                origin.oneOf.some(
                    (variant: {
                        properties: Record<string, { format?: string }>;
                    }) => variant.properties[factId]?.format === 'uuid',
                ),
            ).toBe(true);
        expect(obligation.properties.resolvedAmountInCents.type).toBe(
            'integer',
        );
    });
});
