import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Logger, type INestApplication } from '@nestjs/common';
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
import { TODAY_CLOCK } from '../dist/composition/today/today.clock.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../dist/modules/spaces/application/ports/public/space-financial-context.port.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../dist/modules/spaces/application/ports/public/space-access.port.js';
import { EntityManagerProvider } from '../dist/shared/technical/database/typeorm/entity-manager.provider.js';

describe('CARD-010 HTTP authorized Today financial composition', () => {
    let app: INestApplication<Server>, db: DataSource, instant: Date;

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
        instant = new Date('2026-10-10T15:00:00Z');
        const module = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(FINANCES_CLOCK)
            .useValue({ now: () => instant, today: () => '2026-10-10' })
            .overrideProvider(TODAY_CLOCK)
            .useValue({ now: () => instant })
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
        const agent = request.agent(app.getHttpServer());
        const csrf = (await agent.get('/v2/auth/csrf').expect(200)).body
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
            post: (url: string, body: object, key = randomUUID()) =>
                agent
                    .post(url)
                    .set('Origin', 'http://localhost:3000')
                    .set('X-CSRF-Token', token)
                    .set('Idempotency-Key', key)
                    .send(body),
        };
    }

    async function shared(two = true) {
        const a = await browser('Pessoa A');
        const b = two ? await browser('Pessoa B') : null;
        const created = (
            await a.post('/v2/spaces', { name: 'Casa' }).expect(201)
        ).body;
        const space = created.space.id as string;
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
        ).memberId as string;
        const mb = b
            ? (context.members.find(
                  (m: { personId: string }) =>
                      m.personId === b.context.person.id,
              ).memberId as string)
            : ma;
        return { a, b, space, context, ma, mb };
    }

    type Fixture = Awaited<ReturnType<typeof shared>>;
    const path = (space: string) => `/v2/spaces/${space}/today`;
    const today = (f: Fixture, person = f.a) =>
        person.agent
            .get(path(f.space))
            .expect(200)
            .then((r) => r.body);
    const record = async (
        f: Fixture,
        amount = 10000,
        payer = f.mb,
        date: string | null = '2026-10-09',
        expectedPayerMemberId: string | null = null,
    ) => {
        let existingCycle: string | null = null;
        if (date && date < '2026-10-10') {
            const rows = await db.query(
                'SELECT id FROM settlement_cycles WHERE space_id=$1 AND target_date=$2',
                [f.space, date],
            );
            existingCycle = rows[0]?.id ?? (await emptyCycle(f.space, date));
        }
        return f.a
            .post(`/v2/spaces/${f.space}/shared-cash-expenses`, {
                expectedSpaceVersion: f.context.version,
                description: 'Despesa já realizada',
                amountInCents: amount,
                factDate: '2026-01-05',
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
                ...(expectedPayerMemberId ? { expectedPayerMemberId } : {}),
                disbursement: { payerMemberId: payer, method: 'PIX' },
                settlement: existingCycle
                    ? { mode: 'CYCLE', cycleId: existingCycle }
                    : date
                      ? { mode: 'DATE', targetDate: date }
                      : { mode: 'NONE' },
            })
            .expect(201)
            .then((r) => r.body);
    };

    const transfer = (
        f: Fixture,
        allocations: {
            obligationId: string;
            expectedObligationVersion: number;
            amountInCents: number;
        }[],
        key = randomUUID(),
    ) =>
        f.a.post(
            `/v2/spaces/${f.space}/settlement-transfers`,
            {
                expectedSpaceVersion: f.context.version,
                payerMemberId: f.ma,
                recipientMemberId: f.mb,
                amountInCents: allocations.reduce(
                    (total, item) => total + item.amountInCents,
                    0,
                ),
                factDate: '2026-10-10',
                allocations,
            },
            key,
        );

    async function emptyCycle(space: string, date: string, finalized = false) {
        const id = randomUUID();
        await db.query(
            `INSERT INTO settlement_cycles(id,space_id,target_date,status,version,finalized_at) VALUES($1,$2,$3,$4,1,$5)`,
            [
                id,
                space,
                date,
                finalized ? 'FINALIZED' : 'OPEN',
                finalized ? instant : null,
            ],
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
            'settlement_transfers',
            'settlement_allocations',
            'financial_settlement_command_receipts',
            'financial_settlement_audit',
        ])
            state[table] = await db.query(
                `SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`,
            );
        return state;
    }

    it('A01 A02 A03 A06 composes ordered actual summaries with opposite member perspectives', async () => {
        const f = await shared();
        const overdue = await record(f, 10000);
        await record(f, 4000, f.ma);
        await record(f, 9000, f.mb, '2026-11-01');
        const next = await record(f, 1, f.mb, '2026-10-10');
        const a = await today(f);
        const b = await today(f, f.b!);
        expect(a).toMatchObject({
            spaceId: f.space,
            spaceType: 'SHARED',
            spaceStatus: 'ACTIVE',
            referenceDate: '2026-10-10',
            finance: {
                status: 'AVAILABLE',
                data: {
                    upcomingCommitments: { items: [], totalCount: 0 },
                    settlements: {
                        actorMemberId: f.ma,
                        members: expect.arrayContaining([
                            {
                                memberId: f.ma,
                                personId: f.a.context.person.id,
                                displayName: 'Pessoa A',
                            },
                        ]),
                        nextCycle: {
                            id: next.settlementCycle.id,
                            targetDate: '2026-10-10',
                            isOverdue: false,
                        },
                        overdueCycles: {
                            totalCount: 1,
                            items: [
                                {
                                    id: overdue.settlementCycle.id,
                                    isOverdue: true,
                                    totals: { remainingAmountInCents: '14000' },
                                    position: {
                                        payableAmountInCents: '10000',
                                        receivableAmountInCents: '4000',
                                        net: {
                                            direction: 'PAYABLE',
                                            amountInCents: '6000',
                                        },
                                    },
                                },
                            ],
                        },
                    },
                },
            },
        });
        expect(b.finance.data.settlements).toMatchObject({
            actorMemberId: f.mb,
            overdueCycles: {
                items: [
                    {
                        position: {
                            payableAmountInCents: '4000',
                            receivableAmountInCents: '10000',
                            net: {
                                direction: 'RECEIVABLE',
                                amountInCents: '6000',
                            },
                        },
                    },
                ],
            },
        });
        expect(a.finance.data.settlements.nextCycle).not.toHaveProperty(
            'finalizedAt',
        );
    });

    it('A04 includes a zero upcoming cycle and excludes finalized and old fully resolved cycles', async () => {
        const f = await shared();
        const old = await record(f);
        await transfer(f, [
            {
                obligationId: old.obligation.id,
                expectedObligationVersion: 1,
                amountInCents: 10000,
            },
        ]).expect(201);
        await emptyCycle(f.space, '2026-10-08', true);
        const next = await emptyCycle(f.space, '2026-10-10');
        await record(f, 5000, f.mb, '2026-10-11');
        expect((await today(f)).finance.data.settlements).toMatchObject({
            nextCycle: {
                id: next,
                status: 'OPEN',
                totals: { remainingAmountInCents: '0' },
            },
            overdueCycles: { items: [], totalCount: 0 },
        });
        expect(
            (
                await db.query(
                    'SELECT status FROM settlement_cycles WHERE id=$1',
                    [old.settlementCycle.id],
                )
            )[0].status,
        ).toBe('OPEN');
    });

    it('A05 counts all positive overdue cycles beyond twenty preceding zero cycles and returns only three', async () => {
        const f = await shared();
        await db.query(
            `INSERT INTO settlement_cycles(id,space_id,target_date,status,version) SELECT md5('card-010-zero-'||n)::uuid,$1,DATE '2026-01-01'+n,'OPEN',1 FROM generate_series(0,24) n`,
            [f.space],
        );
        const expected: string[] = [];
        for (let day = 1; day <= 7; day++)
            expected.push(
                (await record(f, day, f.mb, `2026-10-0${day}`)).settlementCycle
                    .id,
            );
        expect(
            (await today(f)).finance.data.settlements.overdueCycles,
        ).toMatchObject({
            totalCount: 7,
            items: expected.slice(0, 3).map((id) => ({ id })),
        });
        expect(
            (await today(f)).finance.data.settlements.overdueCycles.items,
        ).toHaveLength(3);
    });

    it('A06 keeps balanced positive gross debt overdue without settling it', async () => {
        const f = await shared();
        await record(f, 4000);
        await record(f, 4000, f.ma);
        expect(
            (await today(f)).finance.data.settlements.overdueCycles,
        ).toMatchObject({
            totalCount: 1,
            items: [
                {
                    isOverdue: true,
                    openObligationCount: 2,
                    totals: { remainingAmountInCents: '8000' },
                    position: {
                        net: { direction: 'BALANCED', amountInCents: '0' },
                    },
                },
            ],
        });
    });

    it('A07 reduces actual partial and total transfers and removes attention without finalizing or changing origin', async () => {
        const f = await shared();
        const recorded = await record(f);
        const origin = (
            await f.a.agent
                .get(
                    `/v2/spaces/${f.space}/financial-commitments/${recorded.commitment.id}`,
                )
                .expect(200)
        ).body;
        await transfer(f, [
            {
                obligationId: recorded.obligation.id,
                expectedObligationVersion: 1,
                amountInCents: 2500,
            },
        ]).expect(201);
        expect(
            (await today(f)).finance.data.settlements.overdueCycles.items[0]
                .totals,
        ).toEqual({
            originalAmountInCents: '10000',
            recognizedAmountInCents: '10000',
            resolvedAmountInCents: '2500',
            remainingAmountInCents: '7500',
            transferredAmountInCents: '2500',
            compensatedAmountInCents: '0',
            waivedAmountInCents: '0',
            reversedTransferredAmountInCents: '0',
            effectiveTransferredAmountInCents: '2500',
            reversedCompensatedAmountInCents: '0',
            effectiveCompensatedAmountInCents: '0',
        });
        await transfer(f, [
            {
                obligationId: recorded.obligation.id,
                expectedObligationVersion: 2,
                amountInCents: 7500,
            },
        ]).expect(201);
        expect((await today(f)).finance.data.settlements.overdueCycles).toEqual(
            { items: [], totalCount: 0 },
        );
        const after = (
            await f.a.agent
                .get(
                    `/v2/spaces/${f.space}/financial-commitments/${recorded.commitment.id}`,
                )
                .expect(200)
        ).body;
        expect(after.commitment).toEqual(origin.commitment);
        expect(after.disbursement).toEqual(origin.disbursement);
        expect(
            (
                await db.query(
                    'SELECT status,version FROM settlement_cycles WHERE id=$1',
                    [recorded.settlementCycle.id],
                )
            )[0],
        ).toEqual({ status: 'OPEN', version: 1 });
    });

    it('A08 separates resolved and transferred cents once per cycle for one transfer with multiple allocations', async () => {
        const f = await shared();
        const first = await record(f, 10000);
        const sameCycle = await record(f, 5000);
        const second = await record(f, 3000, f.mb, '2026-10-08');
        await db.query(
            `UPDATE inter_member_obligations SET remaining_amount_in_cents=9000,status='PARTIALLY_SETTLED' WHERE id=$1`,
            [first.obligation.id],
        );
        await transfer(
            f,
            [first, sameCycle, second].map((item) => ({
                obligationId: item.obligation.id,
                expectedObligationVersion: 1,
                amountInCents: 1000,
            })),
        ).expect(201);
        const result = (await today(f)).finance.data.settlements.overdueCycles
            .items;
        expect(
            result.find(
                (item: { id: string }) => item.id === first.settlementCycle.id,
            ).totals,
        ).toEqual({
            originalAmountInCents: '15000',
            recognizedAmountInCents: '15000',
            remainingAmountInCents: '12000',
            resolvedAmountInCents: '3000',
            transferredAmountInCents: '2000',
            compensatedAmountInCents: '0',
            waivedAmountInCents: '0',
            reversedTransferredAmountInCents: '0',
            effectiveTransferredAmountInCents: '2000',
            reversedCompensatedAmountInCents: '0',
            effectiveCompensatedAmountInCents: '0',
        });
        expect(
            result.find(
                (item: { id: string }) => item.id === second.settlementCycle.id,
            ).totals,
        ).toEqual({
            originalAmountInCents: '3000',
            recognizedAmountInCents: '3000',
            remainingAmountInCents: '2000',
            resolvedAmountInCents: '1000',
            transferredAmountInCents: '1000',
            compensatedAmountInCents: '0',
            waivedAmountInCents: '0',
            reversedTransferredAmountInCents: '0',
            effectiveTransferredAmountInCents: '1000',
            reversedCompensatedAmountInCents: '0',
            effectiveCompensatedAmountInCents: '0',
        });
    });

    it('A09 A12 does not turn paid facts, optional payer prediction or settlement target into future commitments', async () => {
        const f = await shared();
        await record(f, 10000, f.mb, '2027-01-10', f.ma);
        expect(await today(f)).toMatchObject({
            referenceDate: '2026-10-10',
            finance: {
                data: {
                    upcomingCommitments: { items: [], totalCount: 0 },
                    settlements: {
                        nextCycle: {
                            targetDate: '2027-01-10',
                            isOverdue: false,
                        },
                        overdueCycles: { items: [], totalCount: 0 },
                    },
                },
            },
        });
    });

    it('A10 uses one Sao Paulo reference across the day boundary without any new write', async () => {
        const f = await shared();
        const recorded = await record(f, 1, f.mb, '2026-10-10');
        instant = new Date('2026-10-11T02:59:59.999Z');
        const before = await financialState();
        expect(await today(f)).toMatchObject({
            referenceDate: '2026-10-10',
            finance: {
                data: {
                    settlements: {
                        nextCycle: { id: recorded.settlementCycle.id },
                        overdueCycles: { totalCount: 0 },
                    },
                },
            },
        });
        instant = new Date('2026-10-11T03:00:00Z');
        expect(await today(f)).toMatchObject({
            referenceDate: '2026-10-11',
            finance: {
                data: {
                    settlements: {
                        nextCycle: null,
                        overdueCycles: {
                            totalCount: 1,
                            items: [
                                {
                                    id: recorded.settlementCycle.id,
                                    isOverdue: true,
                                },
                            ],
                        },
                    },
                },
            },
        });
        expect(await financialState()).toEqual(before);
    });

    it('A11 preserves aggregate cents beyond Number precision in the HTTP DTO', async () => {
        const f = await shared();
        await record(f, Number.MAX_SAFE_INTEGER);
        await record(f, Number.MAX_SAFE_INTEGER);
        await record(f, 1, f.ma);
        expect(
            (await today(f)).finance.data.settlements.overdueCycles.items[0],
        ).toMatchObject({
            totals: {
                originalAmountInCents: '18014398509481983',
                recognizedAmountInCents: '18014398509481983',
                remainingAmountInCents: '18014398509481983',
            },
            position: {
                payableAmountInCents: '18014398509481982',
                receivableAmountInCents: '1',
                net: {
                    direction: 'PAYABLE',
                    amountInCents: '18014398509481981',
                },
            },
        });
    });

    it('A13 reads own personal space without the exclusive shared port and denies another personal owner', async () => {
        const a = await browser('Pessoa A');
        const b = await browser('Pessoa B');
        const sharedPort = app.get<SpaceFinancialContextPort>(
            SPACE_FINANCIAL_CONTEXT_PORT,
        );
        const read = vi.spyOn(sharedPort, 'read');
        const own = await a.agent
            .get(path(a.context.personalSpace.id))
            .expect(200);
        expect(own.body).toMatchObject({
            spaceType: 'PERSONAL',
            finance: {
                status: 'AVAILABLE',
                data: {
                    upcomingCommitments: { items: [], totalCount: 0 },
                    settlements: null,
                },
            },
        });
        expect(read).not.toHaveBeenCalled();
        await b.agent
            .get(path(a.context.personalSpace.id))
            .expect(404)
            .expect((r) => expect(r.body.code).toBe('SPACE_NOT_FOUND'));
    });

    it('A14 distinguishes legitimate empty, creator alone and uncategorized paid facts without creating cycles', async () => {
        const alone = await shared(false);
        expect((await today(alone)).finance.data.settlements).toMatchObject({
            members: [{ memberId: alone.ma }],
            nextCycle: null,
            overdueCycles: { items: [], totalCount: 0 },
        });
        await record(alone, 10000, alone.ma, null);
        const f = await shared();
        await record(f, 5000, f.mb, null);
        expect((await today(f)).finance.data.settlements).toMatchObject({
            nextCycle: null,
            overdueCycles: { items: [], totalCount: 0 },
        });
        expect(
            (
                await f.a.agent
                    .get(`/v2/spaces/${f.space}/inter-member-position`)
                    .expect(200)
            ).body.summary.payableAmountInCents,
        ).toBe('5000');
    });

    it.each(['CLOSING', 'CLOSED'])(
        'A15 preserves %s authorized read lifecycle',
        async (status) => {
            const f = await shared();
            await record(f);
            await db.query('UPDATE spaces SET status=$2 WHERE id=$1', [
                f.space,
                status,
            ]);
            expect(await today(f)).toMatchObject({
                spaceStatus: status,
                finance: {
                    status: 'AVAILABLE',
                    data: { settlements: { overdueCycles: { totalCount: 1 } } },
                },
            });
        },
    );

    it('A16 requires session and shared membership without disclosing finance', async () => {
        const f = await shared();
        await record(f);
        await request(app.getHttpServer())
            .get(path(f.space))
            .expect(401)
            .expect((r) => expect(r.body.code).toBe('UNAUTHENTICATED'));
        const outsider = await browser('Fora');
        await outsider.agent
            .get(path(f.space))
            .expect(404)
            .expect((r) => expect(r.body.code).toBe('SPACE_NOT_FOUND'));
    });

    it('A16 suppresses real data when membership is removed during the financial statement', async () => {
        const f = await shared();
        const outsider = await browser('Fora');
        await record(f);
        const manager = app.get(EntityManagerProvider).get();
        const original = manager.query.bind(manager);
        vi.spyOn(manager, 'query').mockImplementation(async (sql, params) => {
            const rows = await original(sql, params);
            if (sql.includes('overdue AS MATERIALIZED ('))
                await original(
                    `UPDATE space_members SET person_id=$2 WHERE id=$1`,
                    [f.ma, outsider.context.person.id],
                );
            return rows;
        });
        await f.a.agent
            .get(path(f.space))
            .expect(404)
            .expect((r) => expect(r.body.code).toBe('SPACE_NOT_FOUND'));
    });

    it('A17 repeated GET preserves facts, versions, receipts and business audit without idempotency or CSRF headers', async () => {
        const f = await shared();
        const recorded = await record(f);
        await transfer(f, [
            {
                obligationId: recorded.obligation.id,
                expectedObligationVersion: 1,
                amountInCents: 1,
            },
        ]).expect(201);
        const before = await financialState();
        const first = await today(f);
        for (let index = 0; index < 3; index++)
            expect(await today(f)).toEqual(first);
        expect(await financialState()).toEqual(before);
    });

    it('A17 keeps the complete SQL snapshot coherent while a real multi-cycle transfer commits on another connection', async () => {
        const f = await shared();
        const first = await record(f, 10000, f.mb, '2026-10-08');
        const second = await record(f, 5000);
        const next = await record(f, 3000, f.mb, '2026-10-10');
        const manager = app.get(EntityManagerProvider).get();
        const spy = vi.spyOn(manager, 'query');
        await today(f);
        const statements = spy.mock.calls.filter(([sql]) =>
            sql.includes('overdue AS MATERIALIZED ('),
        );
        expect(statements).toHaveLength(1);
        const [sql, parameters] = statements[0];
        vi.restoreAllMocks();
        const before = await db.query(sql, parameters);
        const gate = db.createQueryRunner();
        const observer = db.createQueryRunner();
        await gate.connect();
        await observer.connect();
        await gate.startTransaction();
        let pending: Promise<unknown[]> | undefined;
        try {
            const lock = 100010;
            const [{ pid }] = await observer.query(
                'SELECT pg_backend_pid() AS pid',
            );
            await gate.query('SELECT pg_advisory_xact_lock($1)', [lock]);
            pending = observer.query(
                `WITH gate AS MATERIALIZED (SELECT pg_advisory_xact_lock(${lock})) SELECT snapshot.* FROM gate CROSS JOIN LATERAL (${sql}) snapshot`,
                parameters,
            );
            let waiting = false;
            for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
                const [state] = await db.query(
                    'SELECT wait_event FROM pg_stat_activity WHERE pid=$1',
                    [pid],
                );
                waiting = state?.wait_event === 'advisory';
            }
            expect(waiting).toBe(true);
            await transfer(f, [
                {
                    obligationId: first.obligation.id,
                    expectedObligationVersion: 1,
                    amountInCents: 10000,
                },
                {
                    obligationId: second.obligation.id,
                    expectedObligationVersion: 1,
                    amountInCents: 2500,
                },
                {
                    obligationId: next.obligation.id,
                    expectedObligationVersion: 1,
                    amountInCents: 500,
                },
            ]).expect(201);
            await gate.commitTransaction();
            expect(await pending).toEqual(before);
            const financial = (await today(f)).finance.data.settlements;
            expect(financial.overdueCycles).toMatchObject({
                totalCount: 1,
                items: [
                    {
                        id: second.settlementCycle.id,
                        totals: {
                            originalAmountInCents: '5000',
                            recognizedAmountInCents: '5000',
                            remainingAmountInCents: '2500',
                            resolvedAmountInCents: '2500',
                            transferredAmountInCents: '2500',
                            compensatedAmountInCents: '0',
                            waivedAmountInCents: '0',
                            reversedTransferredAmountInCents: '0',
                            effectiveTransferredAmountInCents: '2500',
                            reversedCompensatedAmountInCents: '0',
                            effectiveCompensatedAmountInCents: '0',
                        },
                    },
                ],
            });
            expect(financial.nextCycle).toMatchObject({
                id: next.settlementCycle.id,
                totals: {
                    originalAmountInCents: '3000',
                    recognizedAmountInCents: '3000',
                    remainingAmountInCents: '2500',
                    resolvedAmountInCents: '500',
                    transferredAmountInCents: '500',
                    compensatedAmountInCents: '0',
                    waivedAmountInCents: '0',
                    reversedTransferredAmountInCents: '0',
                    effectiveTransferredAmountInCents: '500',
                    reversedCompensatedAmountInCents: '0',
                    effectiveCompensatedAmountInCents: '0',
                },
            });
            const afterTransfer = await financialState();
            await today(f);
            expect(await financialState()).toEqual(afterTransfer);
        } finally {
            if (gate.isTransactionActive) await gate.rollbackTransaction();
            if (pending) await pending;
            await observer.release();
            await gate.release();
        }
    });

    it('A17 measures existing indexes and executes the one-statement reader in a read-only transaction', async () => {
        const f = await shared();
        await record(f, 1, f.mb, '2026-10-10');
        await db.query(
            `INSERT INTO settlement_cycles(id,space_id,target_date,status,version) SELECT md5('card-010-plan-cycle-'||n)::uuid,$1,DATE '2015-01-01'+n,'OPEN',1 FROM generate_series(0,2999) n`,
            [f.space],
        );
        await db.query(
            `INSERT INTO financial_commitments(id,space_id,kind,modality,description,created_by,version,registered_at) SELECT md5('card-010-plan-origin-'||n)::uuid,$1,'EXPENSE','ONE_TIME','Volume fixture',$2,1,'2026-10-10T15:00:00Z' FROM generate_series(0,2999) n`,
            [f.space, f.a.context.person.id],
        );
        await db.query(
            `INSERT INTO financial_commitment_versions(commitment_id,version,space_id,amount_in_cents,fact_date,split_mode,split_input,rule_source_version) SELECT md5('card-010-plan-origin-'||n)::uuid,1,$1,1,'2026-01-05','AMOUNTS','{}'::jsonb,0 FROM generate_series(0,2999) n`,
            [f.space],
        );
        await db.query(
            `INSERT INTO financial_disbursements(id,space_id,commitment_id,version,payer_member_id,amount_in_cents,method,fact_date,registered_at,recorded_by_person_id,sequence) SELECT md5('card-010-plan-disbursement-'||n)::uuid,$1,md5('card-010-plan-origin-'||n)::uuid,1,$2,1,'PIX','2026-01-05','2026-10-10T15:00:00Z',$3,1 FROM generate_series(0,2999) n`,
            [f.space, f.mb, f.a.context.person.id],
        );
        await db.query(
            `INSERT INTO inter_member_obligations(id,space_id,commitment_id,disbursement_id,debtor_member_id,creditor_member_id,original_amount_in_cents,recognized_amount_in_cents,remaining_amount_in_cents,status,cycle_id,version,fact_date,registered_at) SELECT md5('card-010-plan-obligation-'||n)::uuid,$1,md5('card-010-plan-origin-'||n)::uuid,md5('card-010-plan-disbursement-'||n)::uuid,$2,$3,1,1,1,'OPEN',md5('card-010-plan-cycle-'||n)::uuid,1,'2026-01-05','2026-10-10T15:00:00Z' FROM generate_series(0,2999) n`,
            [f.space, f.ma, f.mb],
        );
        await db.query('ANALYZE settlement_cycles');
        await db.query('ANALYZE inter_member_obligations');
        const manager = app.get(EntityManagerProvider).get();
        const spy = vi.spyOn(manager, 'query');
        const financial = (await today(f)).finance.data.settlements;
        expect(financial.overdueCycles.totalCount).toBe(3000);
        expect(financial.overdueCycles.items).toHaveLength(3);
        const statements = spy.mock.calls.filter(([sql]) =>
            sql.includes('overdue AS MATERIALIZED ('),
        );
        expect(statements).toHaveLength(1);
        const [sql, parameters] = statements[0];
        vi.restoreAllMocks();
        const [plan] = await db.query(
            'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql,
            parameters,
        );
        expect(JSON.stringify(plan)).toContain('IDX_settlement_cycles_open');
        expect(JSON.stringify(plan)).toContain('IDX_obligations_space_cycle');
        expect(plan['QUERY PLAN'][0].Plan['Actual Rows']).toBe(4);
        expect(plan['QUERY PLAN'][0]['Execution Time']).toBeLessThan(2000);
        const runner = db.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
            await runner.query('SET TRANSACTION READ ONLY');
            const rows = await runner.query(sql, parameters);
            expect(rows).toHaveLength(4);
            expect(
                rows.every(
                    (row: { overdue_count: number }) =>
                        row.overdue_count === 3000,
                ),
            ).toBe(true);
            await runner.commitTransaction();
        } finally {
            if (runner.isTransactionActive) await runner.rollbackTransaction();
            await runner.release();
        }
    });

    it('A19 distinguishes technical source unavailability from access loss and allows retry', async () => {
        const f = await shared();
        const outsider = await browser('Fora');
        const manager = app.get(EntityManagerProvider).get();
        const original = manager.query.bind(manager);
        vi.spyOn(manager, 'query').mockImplementation((sql, params) =>
            sql.includes('overdue AS MATERIALIZED (')
                ? Promise.reject(
                      Object.assign(new Error('secret SQL'), { code: '57014' }),
                  )
                : original(sql, params),
        );
        const unavailable = await today(f);
        expect(unavailable.finance).toEqual({
            status: 'UNAVAILABLE',
            error: {
                code: 'FINANCE_TODAY_UNAVAILABLE',
                message:
                    'Não foi possível carregar as finanças. Tente novamente.',
            },
        });
        const access = app.get<SpaceAccessPort>(SPACE_ACCESS_PORT);
        const authorized = access.assertCanRead.bind(access);
        vi.spyOn(access, 'assertCanRead')
            .mockImplementationOnce(authorized)
            .mockImplementationOnce(async (actorId, spaceId) => {
                await db.query(
                    `UPDATE space_members SET person_id=$2 WHERE id=$1`,
                    [f.ma, outsider.context.person.id],
                );
                return authorized(actorId, spaceId);
            });
        await f.a.agent.get(path(f.space)).expect(404);
        vi.restoreAllMocks();
        await db.query(`UPDATE space_members SET person_id=$2 WHERE id=$1`, [
            f.ma,
            f.a.context.person.id,
        ]);
        expect((await today(f)).finance.status).toBe('AVAILABLE');
    });

    it.each(['42601', '23514'])(
        'A19 preserves SQL or persisted-data inconsistency %s as a safe HTTP error',
        async (code) => {
            const f = await shared();
            const manager = app.get(EntityManagerProvider).get();
            const original = manager.query.bind(manager);
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            vi.spyOn(manager, 'query').mockImplementation((sql, params) =>
                sql.includes('overdue AS MATERIALIZED (')
                    ? Promise.reject(
                          Object.assign(new Error('secret SQL data'), { code }),
                      )
                    : original(sql, params),
            );
            const response = await f.a.agent.get(path(f.space)).expect(500);
            expect(response.body).toEqual({
                code: 'INTERNAL_ERROR',
                message: 'Ocorreu um erro interno. Tente novamente mais tarde.',
                details: {},
            });
            expect(response.body).not.toHaveProperty('finance');
        },
    );

    it('A23 validates UUID and rejects client actor, dates, cursor and duplicate filters', async () => {
        const f = await shared();
        await f.a.agent
            .get(path('not-a-uuid'))
            .expect(400)
            .expect((r) => expect(r.body.code).toBe('VALIDATION_ERROR'));
        for (const query of [
            'actorMemberId=' + f.mb,
            'referenceDate=2027-01-01',
            'cursor=x',
            'view=OPEN&view=UPCOMING',
        ])
            await f.a.agent
                .get(path(f.space) + '?' + query)
                .expect(400)
                .expect((r) => expect(r.body.code).toBe('VALIDATION_ERROR'));
        const result = await f.a.agent
            .get(path(f.space.toUpperCase()))
            .expect(200);
        expect(result.headers['cache-control']).toBe('no-store');
        expect(result.body.spaceId).toBe(f.space);
    });

    it('A23 exposes the executable OpenAPI discriminated finance and existing summary schemas', async () => {
        const document = (
            await request(app.getHttpServer())
                .get('/v2/openapi.json')
                .expect(200)
        ).body;
        const endpoint = document.paths['/v2/spaces/{spaceId}/today'].get;
        expect(endpoint.operationId).toBe('getToday');
        expect(endpoint.parameters).toHaveLength(1);
        expect(
            endpoint.responses['200'].content['application/json'].schema,
        ).toEqual({ $ref: '#/components/schemas/TodayResponse' });
        expect(
            document.components.schemas.TodayResponse.properties.finance
                .discriminator.propertyName,
        ).toBe('status');
        expect(
            document.components.schemas.TodaySettlementSummary.properties
                .overdueCycles.properties.items.maxItems,
        ).toBe(3);
        expect(
            document.components.schemas.TodayFinanceAvailable.properties.data
                .properties.upcomingCommitments.properties.items.maxItems,
        ).toBe(4);
    });
});
