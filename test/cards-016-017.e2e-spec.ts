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

vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();
    return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

describe('CARDS-016-017 financial review HTTP/PostgreSQL', () => {
    let app: INestApplication<Server>, db: DataSource;
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
        const module = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(FINANCES_CLOCK)
            .useValue({
                now: () => new Date('2026-12-15T12:30:00Z'),
                today: () => '2026-12-15',
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
        vi.mocked(randomUUID).mockReset();
        if (migrationSource.isInitialized) {
            await migrationSource.runMigrations();
            await migrationSource.destroy();
        }
        await app?.close();
    });

    async function browser(name = 'Titular') {
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
        const headers = {
            Origin: 'http://localhost:3000',
            'X-CSRF-Token': (await agent.get('/v2/auth/csrf').expect(200)).body
                .csrfToken,
        };
        return {
            agent,
            context,
            post: (path: string, body: unknown, key: string = randomUUID()) =>
                agent
                    .post(path)
                    .set(headers)
                    .set('Idempotency-Key', key)
                    .send(body as object),
            put: (path: string, body: unknown, key: string = randomUUID()) =>
                agent
                    .put(path)
                    .set(headers)
                    .set('Idempotency-Key', key)
                    .send(body as object),
        };
    }
    async function shared() {
        const a = await browser('Pessoa A'),
            b = await browser('Pessoa B');
        const created = (
            await a.post('/v2/spaces', { name: 'Casa' }).expect(201)
        ).body;
        const space = created.space.id as string;
        const token = new URLSearchParams(
            new URL(created.inviteUrl).hash.slice(1),
        ).get('token');
        await b
            .post('/v2/invitations/respond', {
                token,
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
        const mb = context.members.find(
            (m: { personId: string }) => m.personId === b.context.person.id,
        ).memberId as string;
        return { a, b, space, context, ma, mb };
    }
    type Shared = Awaited<ReturnType<typeof shared>>;
    const base = (space: string) => `/v2/spaces/${space}`;
    const overview = async (
        a: Awaited<ReturnType<typeof browser>>,
        space: string,
        month = '2026-10',
        member?: string,
    ) =>
        (
            await a.agent
                .get(`${base(space)}/financial-overview`)
                .query({ month, ...(member ? { memberId: member } : {}) })
                .expect(200)
        ).body;
    const expense = (amount = 50000, paid = amount) => ({
        description: 'Despesa original',
        amountInCents: amount,
        factDate: '2026-08-31',
        disbursement: { method: 'PIX', amountInCents: paid },
    });
    const income = (f: Shared, amount = 100000) => ({
        description: 'Receita prevista',
        amountInCents: amount,
        expectedReceiptDate: '2027-01-20',
        expectedRecipientMemberId: null,
        expectedSpaceVersion: f.context.version,
        participationSplit: {
            mode: 'PERCENTAGES',
            shares: [
                { memberId: f.ma, basisPoints: 6000 },
                { memberId: f.mb, basisPoints: 4000 },
            ],
        },
        receipt: null,
    });
    async function receipt(
        f: Shared,
        id: string,
        version: number,
        amount: number,
        date: string,
    ) {
        return f.a
            .post(`${base(f.space)}/financial-commitments/${id}/receipts`, {
                expectedCommitmentVersion: version,
                expectedSpaceVersion: f.context.version,
                amountInCents: amount,
                factDate: date,
                recipientMemberId: f.ma,
                settlement: { mode: 'NONE' },
            })
            .expect(201);
    }
    it('A01/A07/A08/A09/A10/A11 keeps expense, cash, card, support and settlement dates independent without writes', async () => {
        const a = await browser(),
            space = a.context.personalSpace.id as string;
        await a.post(`${base(space)}/personal-expenses`, expense()).expect(201);
        const card = (
            await a
                .post(`${base(space)}/credit-card-purchases`, {
                    description: 'Cartão agosto',
                    amountInCents: 20000,
                    factDate: '2026-08-31',
                    externalLiability: { amountInCents: 20000 },
                })
                .expect(201)
        ).body;
        const settlementPath = `${base(space)}/financial-commitments/${card.commitment.id}/external-liabilities/${card.externalLiability.id}/settlements`;
        await a
            .post(settlementPath, {
                expectedCommitmentVersion: 1,
                amountInCents: 6000,
                factDate: '2026-09-10',
            })
            .expect(201);
        const snapshot = await db.query(
            "SELECT table_name,(xpath('/row/c/text()',query_to_xml(format('SELECT count(*) c FROM %I',table_name),false,true,'')))[1]::text AS count FROM information_schema.tables WHERE table_schema='public' AND (table_name LIKE 'financial_%' OR table_name LIKE 'settlement_%' OR table_name LIKE 'inter_member_%') ORDER BY table_name",
        );
        expect((await overview(a, space, '2026-08')).totals).toMatchObject({
            expenseAmountInCents: '70000',
            economicResultInCents: '-70000',
            paidAmountInCents: '50000',
            assumedAmountInCents: '20000',
            supportedAmountInCents: '70000',
            externalSettledAmountInCents: '0',
            disbursedAmountInCents: '50000',
        });
        const september = await overview(a, space, '2026-09');
        expect(september.totals).toMatchObject({
            expenseAmountInCents: '0',
            supportedAmountInCents: '0',
            externalSettledAmountInCents: '6000',
            disbursedAmountInCents: '6000',
        });
        expect(september.currentExternalLiabilities).toEqual({
            referenceDate: '2026-12-15',
            outstandingAmountInCents: '14000',
            byMember: [],
        });
        const timeline = (
            await a.agent
                .get(
                    `${base(space)}/financial-timeline?month=2026-08&view=HISTORY`,
                )
                .expect(200)
        ).body;
        expect(
            timeline.items.map((i: { type: string }) => i.type).sort(),
        ).toEqual(['DISBURSEMENT', 'EXPENSE', 'EXPENSE', 'EXTERNAL_LIABILITY']);
        expect(
            timeline.items.every(
                (i: { relevantDate: string; registeredAt: string }) =>
                    i.relevantDate === '2026-08-31' &&
                    i.registeredAt.startsWith('2026-12-15'),
            ),
        ).toBe(true);
        await a.agent
            .get(
                `${base(space)}/financial-timeline?month=2026-09&view=CALENDAR`,
            )
            .expect(200);
        const after = await db.query(
            "SELECT table_name,(xpath('/row/c/text()',query_to_xml(format('SELECT count(*) c FROM %I',table_name),false,true,'')))[1]::text AS count FROM information_schema.tables WHERE table_schema='public' AND (table_name LIKE 'financial_%' OR table_name LIKE 'settlement_%' OR table_name LIKE 'inter_member_%') ORDER BY table_name",
        );
        expect(after).toEqual(snapshot);
        await a
            .post(settlementPath, {
                expectedCommitmentVersion: 2,
                amountInCents: 14000,
                factDate: '2026-10-10',
            })
            .expect(201);
        expect(
            (await overview(a, space, '2026-08')).currentExternalLiabilities
                .outstandingAmountInCents,
        ).toBe('0');
    });
    it('A03/A05 distinguishes forecast, participation and received cash across months', async () => {
        const f = await shared();
        const original = (
            await f.a.post(`${base(f.space)}/incomes`, income(f)).expect(201)
        ).body;
        await receipt(f, original.commitment.id, 1, 40000, '2026-10-10');
        const october = await overview(f.a, f.space, '2026-10');
        expect(october.totals.realizedIncomeAmountInCents).toBe('40000');
        expect(
            october.byMember.find(
                (m: { memberId: string }) => m.memberId === f.ma,
            ),
        ).toMatchObject({
            realizedIncomeAmountInCents: '24000',
            receivedAmountInCents: '40000',
        });
        expect(
            october.byMember.find(
                (m: { memberId: string }) => m.memberId === f.mb,
            ),
        ).toMatchObject({
            realizedIncomeAmountInCents: '16000',
            receivedAmountInCents: '0',
        });
        const forecast = (
            await f.a.agent
                .get(`${base(f.space)}/financial-forecast?month=2027-01`)
                .expect(200)
        ).body;
        expect(forecast.totals).toEqual({
            expectedAmountInCents: '100000',
            receivedAmountInCents: '40000',
            remainingAmountInCents: '60000',
        });
        await receipt(f, original.commitment.id, 2, 60000, '2026-11-10');
        const november = await overview(f.b, f.space, '2026-11', f.mb);
        expect(november.totals).toMatchObject({
            realizedIncomeAmountInCents: '24000',
            receivedAmountInCents: '0',
        });
        expect(
            (
                await f.a.agent
                    .get(`${base(f.space)}/financial-forecast?month=2027-01`)
                    .expect(200)
            ).body.items,
        ).toEqual([]);
        expect(
            (
                await f.a.agent
                    .get(
                        `${base(f.space)}/financial-timeline?month=2027-01&view=HISTORY`,
                    )
                    .expect(200)
            ).body.items[0],
        ).toMatchObject({
            type: 'EXPECTED_INCOME',
            amountInCents: 100000,
            relevantDate: '2027-01-20',
            dateNature: 'EXPECTED',
        });
    });
    it.each(['PERCENTAGES', 'AMOUNTS'] as const)(
        'A06 assigns cumulative cents by actual dates despite reverse registration order (%s)',
        async (mode) => {
            const f = await shared();
            const first = [f.ma, f.mb].sort()[0],
                second = [f.ma, f.mb].sort()[1];
            const participationSplit =
                mode === 'PERCENTAGES'
                    ? {
                          mode,
                          shares: [
                              { memberId: first, basisPoints: 5000 },
                              { memberId: second, basisPoints: 5000 },
                          ],
                      }
                    : {
                          mode,
                          shares: [
                              { memberId: first, amountInCents: 2 },
                              { memberId: second, amountInCents: 1 },
                          ],
                      };
            const original = (
                await f.a
                    .post(`${base(f.space)}/incomes`, {
                        ...income(f, 3),
                        participationSplit,
                    })
                    .expect(201)
            ).body;
            await receipt(f, original.commitment.id, 1, 1, '2026-11-01');
            await receipt(f, original.commitment.id, 2, 1, '2026-10-01');
            await receipt(f, original.commitment.id, 3, 1, '2026-12-01');
            expect(
                (await overview(f.a, f.space, '2026-10', first)).totals
                    .realizedIncomeAmountInCents,
            ).toBe('1');
            expect(
                (await overview(f.a, f.space, '2026-11', second)).totals
                    .realizedIncomeAmountInCents,
            ).toBe('1');
            expect(
                (await overview(f.a, f.space, '2026-12', first)).totals
                    .realizedIncomeAmountInCents,
            ).toBe('1');
        },
    );
    it('A04/A14 paginates tied facts and retains totals greater than safe integer', async () => {
        const a = await browser(),
            space = a.context.personalSpace.id as string;
        for (let index = 0; index < 11; index++)
            await a
                .post(
                    `${base(space)}/personal-expenses`,
                    expense(Number.MAX_SAFE_INTEGER),
                )
                .expect(201);
        await db.query(
            "UPDATE financial_commitments SET registered_at='2026-12-15T12:30:00.123456Z' WHERE space_id=$1",
            [space],
        );
        await db.query(
            "UPDATE financial_disbursements SET registered_at='2026-12-15T12:30:00.123456Z' WHERE space_id=$1",
            [space],
        );
        const path = `${base(space)}/financial-timeline?month=2026-08&view=HISTORY`;
        const page = (await a.agent.get(path).expect(200)).body;
        expect(page.items).toHaveLength(20);
        expect(page.nextCursor).toBeTypeOf('string');
        expect(page.items[0].registeredAt).toBe('2026-12-15T12:30:00.123456Z');
        const next = (
            await a.agent
                .get(path)
                .query({ cursor: page.nextCursor })
                .expect(200)
        ).body;
        expect(next.items).toHaveLength(2);
        expect(next.nextCursor).toBeNull();
        expect(
            new Set(
                [...page.items, ...next.items].map(
                    (i: { id: string; type: string }) => `${i.type}:${i.id}`,
                ),
            ).size,
        ).toBe(22);
        expect(
            (await overview(a, space, '2026-08')).totals.expenseAmountInCents,
        ).toBe((11n * BigInt(Number.MAX_SAFE_INTEGER)).toString());
        await a.agent
            .get(`${base(space)}/financial-timeline?month=2026-09&view=HISTORY`)
            .query({ cursor: page.nextCursor })
            .expect(400);
        await a.agent
            .get(
                `${base(space)}/financial-timeline?month=2026-08&view=CALENDAR`,
            )
            .query({ cursor: page.nextCursor })
            .expect(400);
    });
    it('A03/A04 returns forecast totals from every page, excludes overdue and fully received forecasts', async () => {
        const a = await browser(),
            space = a.context.personalSpace.id as string;
        for (let index = 0; index < 21; index++)
            await a
                .post(`${base(space)}/incomes`, {
                    description: `Receita ${index}`,
                    amountInCents: 100,
                    expectedReceiptDate: '2027-01-20',
                    receipt: null,
                })
                .expect(201);
        await a
            .post(`${base(space)}/incomes`, {
                description: 'Atrasada não reprogramada',
                amountInCents: 999,
                expectedReceiptDate: '2026-11-20',
                receipt: null,
            })
            .expect(201);
        const path = `${base(space)}/financial-forecast?month=2027-01`;
        const first = (await a.agent.get(path).expect(200)).body;
        expect(first.items).toHaveLength(20);
        expect(first.totals.remainingAmountInCents).toBe('2100');
        const next = (
            await a.agent
                .get(path)
                .query({ cursor: first.nextCursor })
                .expect(200)
        ).body;
        expect(next.items).toHaveLength(1);
        expect(next.totals).toEqual(first.totals);
        expect(
            new Set(
                [...first.items, ...next.items].map(
                    (i: { id: string }) => i.id,
                ),
            ).size,
        ).toBe(21);
        expect(
            (
                await a.agent
                    .get(`${base(space)}/financial-forecast?month=2026-11`)
                    .expect(200)
            ).body.items,
        ).toEqual([]);
        await a.agent
            .get(`${base(space)}/financial-forecast?month=2027-02`)
            .query({ cursor: first.nextCursor })
            .expect(400);
    });
    it('A14 observes one consistent state while external settlement commits concurrently', async () => {
        const a = await browser(),
            space = a.context.personalSpace.id as string;
        const card = (
            await a
                .post(`${base(space)}/credit-card-purchases`, {
                    description: 'Cartão',
                    amountInCents: 20000,
                    factDate: '2026-08-31',
                    externalLiability: { amountInCents: 20000 },
                })
                .expect(201)
        ).body;
        const path = `${base(space)}/financial-commitments/${card.commitment.id}/external-liabilities/${card.externalLiability.id}/settlements`;
        for (let version = 1; version <= 4; version++) {
            const [result] = await Promise.all([
                overview(a, space, '2026-10'),
                a
                    .post(path, {
                        expectedCommitmentVersion: version,
                        amountInCents: 1000,
                        factDate: '2026-10-10',
                    })
                    .expect(201),
            ]);
            const settled = BigInt(result.totals.externalSettledAmountInCents),
                open = BigInt(
                    result.currentExternalLiabilities.outstandingAmountInCents,
                );
            expect(settled + open).toBe(20000n);
            expect([
                BigInt(version - 1) * 1000n,
                BigInt(version) * 1000n,
            ]).toContain(settled);
            expect(result.totals.supportedAmountInCents).toBe('0');
        }
        expect(
            (await overview(a, space, '2026-10')).totals
                .externalSettledAmountInCents,
        ).toBe('4000');
    });
    it('A10/A11 aggregates multiple payments, liabilities and settlements on one origin without multiplying joins or transfers', async () => {
        const f = await shared();
        const original = (
            await f.a
                .post(`${base(f.space)}/shared-cash-expenses`, {
                    description: 'Origem com muitos fatos',
                    amountInCents: 100000,
                    factDate: '2026-10-01',
                    expectedSpaceVersion: f.context.version,
                    expectedPayerMemberId: null,
                    responsibilitySplit: {
                        mode: 'AMOUNTS',
                        shares: [
                            { memberId: f.ma, amountInCents: 60000 },
                            { memberId: f.mb, amountInCents: 40000 },
                        ],
                    },
                    disbursement: {
                        method: 'PIX',
                        amountInCents: 10000,
                        payerMemberId: f.ma,
                    },
                    settlement: { mode: 'NONE' },
                })
                .expect(201)
        ).body;
        const origin = `${base(f.space)}/financial-commitments/${original.commitment.id}`;
        await f.a
            .post(`${origin}/disbursements`, {
                expectedCommitmentVersion: 1,
                expectedSpaceVersion: f.context.version,
                amountInCents: 20000,
                factDate: '2026-10-02',
                method: 'CASH',
                payerMemberId: f.ma,
                settlement: { mode: 'NONE' },
            })
            .expect(201);
        const liabilities = [];
        for (const [version, amount] of [
            [2, 40000],
            [3, 30000],
        ]) {
            const response = (
                await f.a
                    .post(`${origin}/external-liabilities`, {
                        expectedCommitmentVersion: version,
                        expectedSpaceVersion: f.context.version,
                        amountInCents: amount,
                        factDate: '2026-10-03',
                        holderMemberId: f.ma,
                        settlement: { mode: 'NONE' },
                    })
                    .expect(201)
            ).body;
            liabilities.push(response.externalLiability.id);
        }
        for (const [version, liability, amount] of [
            [4, liabilities[0], 10000],
            [5, liabilities[0], 5000],
            [6, liabilities[1], 20000],
            [7, liabilities[1], 10000],
        ] as const)
            await f.a
                .post(
                    `${origin}/external-liabilities/${liability}/settlements`,
                    {
                        expectedCommitmentVersion: version,
                        expectedSpaceVersion: f.context.version,
                        amountInCents: amount,
                        factDate: '2026-10-04',
                    },
                )
                .expect(201);
        const before = await overview(f.a, f.space);
        expect(before.totals).toMatchObject({
            expenseAmountInCents: '100000',
            paidAmountInCents: '30000',
            assumedAmountInCents: '70000',
            externalSettledAmountInCents: '45000',
            disbursedAmountInCents: '75000',
            supportedAmountInCents: '100000',
        });
        expect(before.currentExternalLiabilities.outstandingAmountInCents).toBe(
            '25000',
        );
        const [obligation] = await db.query(
            'SELECT id,version,remaining_amount_in_cents FROM inter_member_obligations WHERE commitment_id=$1 AND remaining_amount_in_cents>0',
            [original.commitment.id],
        );
        await f.b
            .post(`${base(f.space)}/settlement-transfers`, {
                expectedSpaceVersion: f.context.version,
                payerMemberId: f.mb,
                recipientMemberId: f.ma,
                amountInCents: 40000,
                factDate: '2026-10-05',
                allocations: [
                    {
                        obligationId: obligation.id,
                        expectedObligationVersion: obligation.version,
                        amountInCents: 40000,
                    },
                ],
            })
            .expect(201);
        const after = await overview(f.a, f.space);
        expect(after.totals).toMatchObject({
            ...before.totals,
            internalTransfersSentAmountInCents: '40000',
            internalTransfersReceivedAmountInCents: '40000',
            internalTransfersSentEffectiveAmountInCents: '40000',
            internalTransfersReceivedEffectiveAmountInCents: '40000',
        });
        expect(
            (await overview(f.a, f.space, '2026-10', f.mb)).totals,
        ).toMatchObject({
            expenseAmountInCents: '40000',
            paidAmountInCents: '0',
            supportedAmountInCents: '0',
            internalTransfersSentAmountInCents: '40000',
            internalTransfersReceivedAmountInCents: '0',
        });
    });
    it('A15 reports unavailable database rather than successful zero summary', async () => {
        const a = await browser(),
            space = a.context.personalSpace.id as string;
        const original = db.manager.query.bind(db.manager);
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        vi.spyOn(db.manager, 'query').mockImplementation((sql, parameters) =>
            sql.includes('period_receipts AS')
                ? Promise.reject(new Error('database unavailable'))
                : original(sql, parameters),
        );
        const response = await a.agent
            .get(`${base(space)}/financial-overview?month=2026-10`)
            .expect(500);
        expect(response.body.code).toBe('INTERNAL_ERROR');
        expect(response.body).not.toHaveProperty('totals');
    });
    it('A12/A13/A15 protects access, validates filters and keeps another member settlement forbidden', async () => {
        const f = await shared(),
            third = await browser('Terceiro');
        await third.agent
            .get(`${base(f.space)}/financial-overview?month=2026-10`)
            .expect(404);
        await f.a.agent
            .get(`${base(f.space)}/financial-overview?month=2026-13`)
            .expect(400);
        await f.a.agent
            .get(`${base(f.space)}/financial-overview?month=2026-10&unknown=x`)
            .expect(400);
        await f.a.agent
            .get(
                `${base(f.space)}/financial-timeline?month=2026-10&view=INVALID`,
            )
            .expect(400);
        await f.a.agent
            .get(
                `${base(f.space)}/financial-timeline?month=2026-10&view=HISTORY&cursor=invalid`,
            )
            .expect(400);
        await f.a.agent
            .get(
                `${base(f.space)}/financial-overview?month=2026-10&memberId=${randomUUID()}`,
            )
            .expect(400);
        await f.a.agent
            .get(
                `${base(f.a.context.personalSpace.id)}/financial-overview?month=2026-10&memberId=${f.ma}`,
            )
            .expect(400);
        const card = (
            await f.a
                .post(`${base(f.space)}/credit-card-purchases`, {
                    description: 'Cartão do outro',
                    amountInCents: 20000,
                    factDate: '2026-08-31',
                    externalLiability: {
                        amountInCents: 20000,
                        holderMemberId: f.mb,
                    },
                    expectedSpaceVersion: f.context.version,
                    responsibilitySplit: {
                        mode: 'AMOUNTS',
                        shares: [
                            { memberId: f.ma, amountInCents: 10000 },
                            { memberId: f.mb, amountInCents: 10000 },
                        ],
                    },
                    settlement: { mode: 'NONE' },
                })
                .expect(201)
        ).body;
        const listed = (
            await f.a.agent
                .get(`${base(f.space)}/external-liabilities?memberId=${f.mb}`)
                .expect(200)
        ).body;
        expect(listed.items[0].externalLiability.id).toBe(
            card.externalLiability.id,
        );
        expect(listed.canSettle).toBe(false);
        expect(
            (await overview(f.a, f.space, '2026-10', f.mb))
                .currentExternalLiabilities.outstandingAmountInCents,
        ).toBe('20000');
        await f.a
            .post(
                `${base(f.space)}/financial-commitments/${card.commitment.id}/external-liabilities/${card.externalLiability.id}/settlements`,
                {
                    expectedSpaceVersion: f.context.version,
                    expectedCommitmentVersion: 1,
                    amountInCents: 1,
                    factDate: '2026-10-01',
                },
            )
            .expect(403);
        await db.query("UPDATE spaces SET status='CLOSED' WHERE id=$1", [
            f.space,
        ]);
        expect((await overview(f.a, f.space)).spaceType).toBe('SHARED');
        await request(app.getHttpServer())
            .get(`${base(f.space)}/financial-overview?month=2026-10`)
            .expect(401);
    });
});
