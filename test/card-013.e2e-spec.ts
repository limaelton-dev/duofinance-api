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

describe('CARD-013 partial fulfillment HTTP/PostgreSQL', () => {
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
                now: () => new Date('2026-10-15T02:30:00Z'),
                today: () => '2026-10-14',
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
    function reverseIds() {
        let suffix = 999999999999;
        vi.mocked(randomUUID).mockImplementation(
            () => `ffffffff-ffff-4fff-8fff-${suffix--}`,
        );
    }
    const detailPath = (space: string, id: string) =>
        `/v2/spaces/${space}/financial-commitments/${id}`;
    const personalExpense = (amount = 100000, paid = 30000) => ({
        description: 'Consulta',
        amountInCents: amount,
        factDate: '2026-10-14',
        disbursement: { method: 'PIX', amountInCents: paid },
    });
    const expenseInput = (f: Shared, paid: number, payer = f.ma) => ({
        description: 'Mercado',
        amountInCents: 50000,
        factDate: '2026-10-14',
        expectedSpaceVersion: f.context.version,
        expectedPayerMemberId: f.ma,
        responsibilitySplit: {
            mode: 'AMOUNTS',
            shares: [
                { memberId: f.ma, amountInCents: 30000 },
                { memberId: f.mb, amountInCents: 20000 },
            ],
        },
        disbursement: {
            method: 'PIX',
            payerMemberId: payer,
            amountInCents: paid,
        },
        settlement: { mode: 'NONE' },
    });
    const incomeInput = (
        f: Shared,
        received: number | null,
        recipient = f.ma,
    ) => ({
        description: 'Projeto',
        amountInCents: 100000,
        expectedReceiptDate: '2026-10-20',
        expectedSpaceVersion: f.context.version,
        expectedRecipientMemberId: f.ma,
        participationSplit: {
            mode: 'PERCENTAGES',
            shares: [
                { memberId: f.ma, basisPoints: 6000 },
                { memberId: f.mb, basisPoints: 4000 },
            ],
        },
        receipt:
            received === null
                ? null
                : {
                      amountInCents: received,
                      factDate: '2026-10-14',
                      recipientMemberId: recipient,
                      settlement: { mode: 'NONE' },
                  },
    });
    const payBody = (
        f: Shared,
        version: number,
        amount: number,
        payer = f.ma,
    ) => ({
        expectedCommitmentVersion: version,
        expectedSpaceVersion: f.context.version,
        amountInCents: amount,
        factDate: '2026-10-14',
        method: 'PIX',
        payerMemberId: payer,
        settlement: { mode: 'NONE' },
    });
    const receiveBody = (
        f: Shared,
        version: number,
        amount: number,
        recipient = f.ma,
    ) => ({
        expectedCommitmentVersion: version,
        expectedSpaceVersion: f.context.version,
        amountInCents: amount,
        factDate: '2026-10-14',
        recipientMemberId: recipient,
        settlement: { mode: 'NONE' },
    });
    async function openObligations(commitment: string) {
        return db.query(
            'SELECT id,debtor_member_id,creditor_member_id,original_amount_in_cents::text,recognized_amount_in_cents::text,remaining_amount_in_cents::text,version,cycle_id FROM inter_member_obligations WHERE commitment_id=$1 AND remaining_amount_in_cents>0 ORDER BY id',
            [commitment],
        );
    }
    async function undoPartialFulfillment() {
        while (
            (
                await migrationSource.query(
                    'SELECT name FROM migrations ORDER BY id DESC LIMIT 1',
                )
            )[0]?.name !== 'PartialFinancialFulfillment1792022400000'
        ) {
            await migrationSource.undoLastMigration();
        }
        return migrationSource.undoLastMigration();
    }
    async function transfer(f: Shared, commitment: string, amount: number) {
        const [o] = await openObligations(commitment);
        return (
            await f.a
                .post(`/v2/spaces/${f.space}/settlement-transfers`, {
                    expectedSpaceVersion: f.context.version,
                    payerMemberId: o.debtor_member_id,
                    recipientMemberId: o.creditor_member_id,
                    amountInCents: amount,
                    factDate: '2026-10-14',
                    allocations: [
                        {
                            obligationId: o.id,
                            expectedObligationVersion: o.version,
                            amountInCents: amount,
                        },
                    ],
                })
                .expect(201)
        ).body;
    }
    async function snapshot() {
        const tables = [
            'financial_commitments',
            'financial_commitment_versions',
            'financial_commitment_shares',
            'financial_income_versions',
            'financial_income_shares',
            'financial_disbursements',
            'financial_receipts',
            'inter_member_obligations',
            'inter_member_obligation_changes',
            'settlement_cycles',
            'settlement_transfers',
            'settlement_allocations',
            'financial_expense_command_receipts',
            'financial_income_command_receipts',
            'financial_settlement_command_receipts',
        ];
        return Object.fromEntries(
            await Promise.all(
                tables.map(async (table) => [
                    table,
                    await db.query(`SELECT * FROM ${table} ORDER BY 1,2`),
                ]),
            ),
        );
    }
    async function concurrent<T>(space: string, start: () => Promise<T>) {
        const gate = db.createQueryRunner();
        await gate.connect();
        await gate.startTransaction();
        let pending: Promise<T> | undefined;
        try {
            const [{ pid }] = await gate.query(
                'SELECT pg_backend_pid() AS pid',
            );
            await gate.query('SELECT id FROM spaces WHERE id=$1 FOR UPDATE', [
                space,
            ]);
            pending = start();
            await vi.waitFor(
                async () => {
                    const waiting = await db.query(
                        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
                        [pid],
                    );
                    expect(
                        new Set(waiting.map((r: { pid: number }) => r.pid))
                            .size,
                    ).toBe(2);
                },
                { timeout: 10000, interval: 20 },
            );
            await gate.commitTransaction();
            return await pending;
        } finally {
            if (gate.isTransactionActive) await gate.rollbackTransaction();
            await gate.release();
            if (pending) await Promise.allSettled([pending]);
        }
    }

    it('A01 preserves one personal expense with three facts and no internal debt', async () => {
        const b = await browser(),
            space = b.context.personalSpace.id as string;
        reverseIds();
        const first = (
            await b
                .post(
                    `/v2/spaces/${space}/personal-expenses`,
                    personalExpense(),
                )
                .expect(201)
        ).body;
        const path = detailPath(space, first.commitment.id);
        expect(first).toMatchObject({
            status: 'PARTIALLY_PAID',
            paidAmountInCents: 30000,
            remainingAmountInCents: 70000,
            disbursements: [{ amountInCents: 30000 }],
        });
        const options = await b.agent
            .get(`${path}/disbursement-options`)
            .expect(200);
        expect(options.headers['cache-control']).toBe('no-store');
        expect(options.body).toMatchObject({
            expectedCommitmentVersion: 1,
            amountInCents: 100000,
            paidAmountInCents: 30000,
            remainingAmountInCents: 70000,
            referenceDate: '2026-10-14',
            canDisburse: true,
            disbursementMethods: ['PIX', 'DEBIT', 'CASH'],
        });
        for (const [version, amount, date] of [
            [1, 20000, '2026-10-13'],
            [2, 50000, '2026-10-14'],
        ] as const)
            await b
                .post(`${path}/disbursements`, {
                    expectedCommitmentVersion: version,
                    amountInCents: amount,
                    factDate: date,
                    method: 'CASH',
                })
                .expect(201);
        const detail = (await b.agent.get(path).expect(200)).body;
        expect(detail).toMatchObject({
            status: 'PAID',
            paidAmountInCents: 100000,
            remainingAmountInCents: 0,
            commitment: {
                amountInCents: 100000,
                version: 3,
                factDate: '2026-10-14',
            },
            disbursement: first.disbursement,
        });
        expect(
            detail.disbursements.map(
                (d: { amountInCents: number }) => d.amountInCents,
            ),
        ).toEqual([30000, 20000, 50000]);
        expect(
            new Set(detail.disbursements.map((d: { id: string }) => d.id)).size,
        ).toBe(3);
        const ids = detail.disbursements.map((d: { id: string }) => d.id);
        expect(ids).toEqual([...ids].sort().reverse());
        for (const d of detail.disbursements)
            expect(d).toMatchObject({
                payerPersonId: b.context.person.id,
                recordedByPersonId: b.context.person.id,
                registeredAt: '2026-10-15T02:30:00.000Z',
            });
        expect(detail.disbursements[1].factDate).toBe('2026-10-13');
        expect(
            (await b.agent.get(`${path}/disbursement-options`).expect(200)).body
                .canDisburse,
        ).toBe(false);
        expect(
            await db.query('SELECT * FROM inter_member_obligations'),
        ).toEqual([]);
        expect(await db.query('SELECT * FROM space_members')).toEqual([]);
        expect(
            await db.query('SELECT * FROM financial_commitment_versions'),
        ).toHaveLength(1);
        expect(
            (
                await b.agent
                    .get(`/v2/spaces/${space}/personal-expenses`)
                    .expect(200)
            ).body.items,
        ).toMatchObject([
            {
                id: first.commitment.id,
                paidAmountInCents: 100000,
                remainingAmountInCents: 0,
            },
        ]);
    });

    it('A02/A06 keeps responsibility and expected payer when a different member completes support', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(
                    `/v2/spaces/${f.space}/shared-cash-expenses`,
                    expenseInput(f, 35000),
                )
                .expect(201)
        ).body;
        const path = detailPath(f.space, first.commitment.id);
        const final = (
            await f.b
                .post(`${path}/disbursements`, payBody(f, 1, 15000, f.mb))
                .expect(201)
        ).body;
        expect(final).toMatchObject({
            status: 'PAID',
            paidAmountInCents: 50000,
            remainingAmountInCents: 0,
            commitment: {
                amountInCents: 50000,
                expectedPayerMemberId: f.ma,
                responsibilitySplit: first.commitment.responsibilitySplit,
            },
            obligation: {
                debtorMemberId: f.mb,
                creditorMemberId: f.ma,
                originalAmountInCents: 5000,
                remainingAmountInCents: 5000,
            },
        });
        expect(final.disbursements).toMatchObject([
            {
                payerMemberId: f.ma,
                recordedByPersonId: f.a.context.person.id,
                amountInCents: 35000,
            },
            {
                payerMemberId: f.mb,
                recordedByPersonId: f.b.context.person.id,
                amountInCents: 15000,
            },
        ]);
        expect(
            await db.query('SELECT * FROM financial_commitment_versions'),
        ).toHaveLength(1);
    });

    it('A03/A20 receives a personal forecast in parts and Today displays only its remaining amount', async () => {
        const b = await browser(),
            space = b.context.personalSpace.id as string;
        reverseIds();
        const first = (
            await b
                .post(`/v2/spaces/${space}/incomes`, {
                    description: 'Salário',
                    amountInCents: 100000,
                    expectedReceiptDate: '2026-10-20',
                    receipt: null,
                })
                .expect(201)
        ).body;
        const path = detailPath(space, first.commitment.id);
        expect(first).toMatchObject({
            status: 'PENDING',
            receivedAmountInCents: 0,
            remainingAmountInCents: 100000,
            receipts: [],
        });
        for (const [version, amount, total] of [
            [1, 30000, 30000],
            [2, 20000, 50000],
            [3, 50000, 100000],
        ]) {
            const result = (
                await b
                    .post(`${path}/receipts`, {
                        expectedCommitmentVersion: version,
                        amountInCents: amount,
                        factDate: version === 2 ? '2026-10-13' : '2026-10-14',
                    })
                    .expect(201)
            ).body;
            expect(result).toMatchObject({
                status: total < 100000 ? 'PARTIALLY_RECEIVED' : 'RECEIVED',
                receivedAmountInCents: total,
                remainingAmountInCents: 100000 - total,
                commitment: {
                    amountInCents: 100000,
                    expectedReceiptDate: '2026-10-20',
                    version: version + 1,
                },
                obligation: null,
            });
            const today = (
                await b.agent.get(`/v2/spaces/${space}/today`).expect(200)
            ).body.finance.data.upcomingCommitments;
            if (total < 100000) {
                expect(today.totalCount).toBe(1);
                expect(today.items).toMatchObject([
                    {
                        commitmentId: first.commitment.id,
                        amountInCents: 100000,
                        receivedAmountInCents: total,
                        remainingAmountInCents: 100000 - total,
                    },
                ]);
                expect(
                    (
                        await b.agent
                            .get(`/v2/spaces/${space}/incomes?status=PENDING`)
                            .expect(200)
                    ).body.items,
                ).toHaveLength(1);
                expect(
                    (await b.agent.get(`${path}/receipt-options`).expect(200))
                        .body,
                ).toMatchObject({
                    canReceive: true,
                    remainingAmountInCents: 100000 - total,
                });
            } else expect(today.items).toEqual([]);
        }
        const detail = (await b.agent.get(path).expect(200)).body;
        expect(detail.receipts).toHaveLength(3);
        expect(detail.receipt).toEqual(detail.receipts[0]);
        const ids = detail.receipts.map((r: { id: string }) => r.id);
        expect(ids).toEqual([...ids].sort().reverse());
        expect(detail.receipts[1].factDate).toBe('2026-10-13');
        for (const r of detail.receipts)
            expect(r).toMatchObject({
                recipientPersonId: b.context.person.id,
                recordedByPersonId: b.context.person.id,
            });
        expect(
            (await b.agent.get(`/v2/spaces/${space}/incomes`).expect(200)).body
                .items,
        ).toHaveLength(1);
        expect(
            (await b.agent.get(`${path}/receipt-options`).expect(200)).body
                .canReceive,
        ).toBe(false);
    });

    it('A04 keeps legacy full expense and income creation while accepting a partial initial receipt', async () => {
        const b = await browser(),
            space = b.context.personalSpace.id as string;
        const expense = (
            await b
                .post(`/v2/spaces/${space}/personal-expenses`, {
                    ...personalExpense(),
                    disbursement: { method: 'PIX' },
                })
                .expect(201)
        ).body;
        expect(expense).toMatchObject({
            status: 'PAID',
            paidAmountInCents: 100000,
            remainingAmountInCents: 0,
        });
        const input = {
            description: 'Salário',
            amountInCents: 100000,
            expectedReceiptDate: '2026-10-20',
        };
        const full = (
            await b
                .post(`/v2/spaces/${space}/incomes`, {
                    ...input,
                    receipt: { factDate: '2026-10-14' },
                })
                .expect(201)
        ).body;
        expect(full).toMatchObject({
            status: 'RECEIVED',
            receivedAmountInCents: 100000,
            remainingAmountInCents: 0,
        });
        const partial = (
            await b
                .post(`/v2/spaces/${space}/incomes`, {
                    ...input,
                    receipt: { factDate: '2026-10-14', amountInCents: 30000 },
                })
                .expect(201)
        ).body;
        expect(partial).toMatchObject({
            status: 'PARTIALLY_RECEIVED',
            receivedAmountInCents: 30000,
            remainingAmountInCents: 70000,
        });
        await b
            .post(`${detailPath(space, partial.commitment.id)}/receipts`, {
                expectedCommitmentVersion: 1,
                factDate: '2026-10-14',
            })
            .expect(409);
    });

    it('A05 compares expense support with the original responsibility and preserves the original debt amount', async () => {
        const f = await shared();
        let current = (
            await f.a
                .post(
                    `/v2/spaces/${f.space}/shared-cash-expenses`,
                    expenseInput(f, 10000),
                )
                .expect(201)
        ).body;
        const path = detailPath(f.space, current.commitment.id);
        expect(current.obligation).toBeNull();
        for (const [amount, expected] of [
            [20000, 0],
            [10000, 10000],
            [10000, 20000],
        ]) {
            current = (
                await f.a
                    .post(
                        `${path}/disbursements`,
                        payBody(f, current.commitment.version, amount),
                    )
                    .expect(201)
            ).body;
            if (!expected) expect(current.obligation).toBeNull();
            else
                expect(current.obligation).toMatchObject({
                    debtorMemberId: f.mb,
                    creditorMemberId: f.ma,
                    originalAmountInCents: 10000,
                    recognizedAmountInCents: expected,
                    remainingAmountInCents: expected,
                });
        }
        expect(await openObligations(current.commitment.id)).toHaveLength(1);
        expect(await db.query('SELECT * FROM settlement_transfers')).toEqual(
            [],
        );
    });

    it('A06/A11 preserves an intermediate expense settlement while increasing recognized support', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(
                    `/v2/spaces/${f.space}/shared-cash-expenses`,
                    expenseInput(f, 40000),
                )
                .expect(201)
        ).body;
        const settled = await transfer(f, first.commitment.id, 4000);
        const final = (
            await f.b
                .post(
                    `${detailPath(f.space, first.commitment.id)}/disbursements`,
                    payBody(f, 1, 10000),
                )
                .expect(201)
        ).body;
        expect(final.obligation).toMatchObject({
            id: first.obligation.id,
            originalAmountInCents: 10000,
            recognizedAmountInCents: 20000,
            remainingAmountInCents: 16000,
        });
        expect(
            await db.query(
                'SELECT amount_in_cents::text AS amount FROM settlement_transfers WHERE id=$1',
                [settled.transfer.id],
            ),
        ).toEqual([{ amount: '4000' }]);
        expect(final.paidAmountInCents).toBe(50000);
    });

    it('A07 closes the old income direction by reconciliation and preserves its fact origin', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(`/v2/spaces/${f.space}/incomes`, incomeInput(f, 50000))
                .expect(201)
        ).body;
        expect(first.obligation).toMatchObject({
            debtorMemberId: f.ma,
            creditorMemberId: f.mb,
            remainingAmountInCents: 20000,
        });
        const final = (
            await f.b
                .post(
                    `${detailPath(f.space, first.commitment.id)}/receipts`,
                    receiveBody(f, first.commitment.version, 50000, f.mb),
                )
                .expect(201)
        ).body;
        expect(final.obligation).toMatchObject({
            debtorMemberId: f.mb,
            creditorMemberId: f.ma,
            originalAmountInCents: 10000,
            remainingAmountInCents: 10000,
        });
        expect(final.obligation.id).not.toBe(first.obligation.id);
        expect(final.receipt).toEqual(first.receipt);
        expect(final.receipts).toHaveLength(2);
        expect(final.obligations).toHaveLength(2);
        const old = (
            await db.query(
                'SELECT remaining_amount_in_cents::text AS remaining,status FROM inter_member_obligations WHERE id=$1',
                [first.obligation.id],
            )
        )[0];
        expect(old).toMatchObject({ remaining: '0', status: 'RECONCILED' });
        expect(await db.query('SELECT * FROM settlement_transfers')).toEqual(
            [],
        );
        expect(await openObligations(first.commitment.id)).toHaveLength(1);
        await expect(
            db.query(
                "INSERT INTO inter_member_obligations SELECT (jsonb_populate_record(NULL::inter_member_obligations,to_jsonb(o)||jsonb_build_object('id',$1::uuid))).* FROM inter_member_obligations o WHERE o.id=$2",
                [randomUUID(), final.obligation.id],
            ),
        ).rejects.toMatchObject({ driverError: { code: '23505' } });
    });

    it.each([5000, 20000])(
        'A09 preserves a prior income transfer of %s when the direction reverses',
        async (amount) => {
            const f = await shared();
            const first = (
                await f.a
                    .post(
                        `/v2/spaces/${f.space}/incomes`,
                        incomeInput(f, 50000),
                    )
                    .expect(201)
            ).body;
            const paid = await transfer(f, first.commitment.id, amount);
            const final = (
                await f.b
                    .post(
                        `${detailPath(f.space, first.commitment.id)}/receipts`,
                        receiveBody(f, first.commitment.version, 50000, f.mb),
                    )
                    .expect(201)
            ).body;
            expect(final.obligation).toMatchObject({
                debtorMemberId: f.mb,
                creditorMemberId: f.ma,
                remainingAmountInCents: 10000 + amount,
            });
            expect(final.receivedAmountInCents).toBe(100000);
            const historical = (
                await f.a.agent
                    .get(
                        `/v2/spaces/${f.space}/settlement-transfers/${paid.transfer.id}`,
                    )
                    .expect(200)
            ).body;
            expect(historical.transfer.amountInCents).toBe(amount);
            expect(historical.allocations[0].origin).toMatchObject({
                commitmentId: first.commitment.id,
                receiptId: first.receipt.id,
            });
            expect(
                await db.query('SELECT * FROM settlement_transfers'),
            ).toHaveLength(1);
            expect(
                await db.query('SELECT * FROM settlement_allocations'),
            ).toHaveLength(1);
        },
    );

    it('A08 balances A600/B400 income receipts without an artificial transfer', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(`/v2/spaces/${f.space}/incomes`, incomeInput(f, 60000))
                .expect(201)
        ).body;
        const final = (
            await f.b
                .post(
                    `${detailPath(f.space, first.commitment.id)}/receipts`,
                    receiveBody(f, first.commitment.version, 40000, f.mb),
                )
                .expect(201)
        ).body;
        expect(final.obligation).toBeNull();
        expect(await openObligations(first.commitment.id)).toEqual([]);
        expect(await db.query('SELECT * FROM settlement_transfers')).toEqual(
            [],
        );
    });

    it('A10 permits repeated direction changes while retaining distinct historical episodes', async () => {
        const f = await shared();
        reverseIds();
        const first = (
            await f.a
                .post(`/v2/spaces/${f.space}/incomes`, incomeInput(f, 20000))
                .expect(201)
        ).body;
        const path = `${detailPath(f.space, first.commitment.id)}/receipts`;
        const ids = [first.obligation.id];
        for (const [version, amount, member, debtor, expected] of [
            [1, 20000, f.mb, f.mb, 4000],
            [2, 30000, f.ma, f.ma, 8000],
            [3, 30000, f.mb, f.mb, 10000],
        ] as const) {
            const result = (
                await f.a
                    .post(
                        path,
                        receiveBody(
                            f,
                            first.commitment.version + version - 1,
                            amount,
                            member,
                        ),
                    )
                    .expect(201)
            ).body;
            expect(result.obligation).toMatchObject({
                debtorMemberId: debtor,
                remainingAmountInCents: expected,
            });
            ids.push(result.obligation.id);
            expect(await openObligations(first.commitment.id)).toHaveLength(1);
        }
        expect(new Set(ids).size).toBe(4);
        expect(
            await db.query(
                'SELECT * FROM inter_member_obligations WHERE commitment_id=$1',
                [first.commitment.id],
            ),
        ).toHaveLength(4);
        expect(await db.query('SELECT * FROM settlement_transfers')).toEqual(
            [],
        );
    });

    it('A11 recognizes new same-direction support after the previous obligation was fully settled', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(
                    `/v2/spaces/${f.space}/shared-cash-expenses`,
                    expenseInput(f, 40000),
                )
                .expect(201)
        ).body;
        await transfer(f, first.commitment.id, 10000);
        expect(await openObligations(first.commitment.id)).toEqual([]);
        const final = (
            await f.a
                .post(
                    `${detailPath(f.space, first.commitment.id)}/disbursements`,
                    payBody(f, 1, 10000),
                )
                .expect(201)
        ).body;
        expect(final.obligation).toMatchObject({
            debtorMemberId: f.mb,
            creditorMemberId: f.ma,
            remainingAmountInCents: 10000,
        });
        expect(await openObligations(first.commitment.id)).toHaveLength(1);
        expect(
            await db.query('SELECT * FROM settlement_allocations'),
        ).toHaveLength(1);
    });

    it('A12/A19 keeps opposite origins separate and cycle transfers distinct from reconciliation', async () => {
        const f = await shared();
        const originalInput = incomeInput(f, 50000);
        const input = {
            ...originalInput,
            receipt: {
                ...originalInput.receipt!,
                settlement: { mode: 'DATE', targetDate: '2026-10-20' },
            },
        };
        const first = (
            await f.a.post(`/v2/spaces/${f.space}/incomes`, input).expect(201)
        ).body;
        const opposite = (
            await f.a
                .post(
                    `/v2/spaces/${f.space}/incomes`,
                    incomeInput(f, 100000, f.mb),
                )
                .expect(201)
        ).body;
        await transfer(f, first.commitment.id, 5000);
        const beforeOpposite = await openObligations(opposite.commitment.id);
        await f.b
            .post(
                `${detailPath(f.space, first.commitment.id)}/receipts`,
                receiveBody(f, first.commitment.version, 50000, f.mb),
            )
            .expect(201);
        expect(await openObligations(opposite.commitment.id)).toEqual(
            beforeOpposite,
        );
        const cycle = (
            await f.a.agent
                .get(
                    `/v2/spaces/${f.space}/settlement-cycles/${first.settlementCycle.id}`,
                )
                .expect(200)
        ).body;
        expect(cycle.cycle.totals).toMatchObject({
            originalAmountInCents: '20000',
            recognizedAmountInCents: '5000',
            resolvedAmountInCents: '5000',
            transferredAmountInCents: '5000',
            compensatedAmountInCents: '0',
            remainingAmountInCents: '0',
        });
        expect(cycle.items).toHaveLength(1);
        const list = (
            await f.a.agent.get(`/v2/spaces/${f.space}/incomes`).expect(200)
        ).body;
        expect(list.items).toHaveLength(2);
        expect(new Set(list.items.map((i: { id: string }) => i.id)).size).toBe(
            2,
        );
        const position = (
            await f.a.agent
                .get(`/v2/spaces/${f.space}/inter-member-position`)
                .expect(200)
        ).body;
        expect(position.items).toHaveLength(2);
        expect(
            position.items
                .map(
                    (i: { origin: { commitmentId: string } }) =>
                        i.origin.commitmentId,
                )
                .sort(),
        ).toEqual([first.commitment.id, opposite.commitment.id].sort());
        expect(
            (
                await f.a.agent
                    .get(`/v2/spaces/${f.space}/settlement-transfers`)
                    .expect(200)
            ).body.items,
        ).toHaveLength(1);
    });

    it.each([0, -1, 0.1, Number.MAX_SAFE_INTEGER + 1, 70001])(
        'A13 refuses a later invalid amount %s without changing facts',
        async (amount) => {
            const b = await browser(),
                space = b.context.personalSpace.id as string;
            const first = (
                await b
                    .post(
                        `/v2/spaces/${space}/personal-expenses`,
                        personalExpense(),
                    )
                    .expect(201)
            ).body;
            const before = await snapshot();
            await b
                .post(
                    `${detailPath(space, first.commitment.id)}/disbursements`,
                    {
                        expectedCommitmentVersion: 1,
                        amountInCents: amount,
                        factDate: '2026-10-14',
                        method: 'PIX',
                    },
                )
                .expect(400);
            expect(await snapshot()).toEqual(before);
        },
    );

    it('A13 rejects future dates and foreign effective members for both facts', async () => {
        const f = await shared();
        const expense = (
            await f.a
                .post(
                    `/v2/spaces/${f.space}/shared-cash-expenses`,
                    expenseInput(f, 10000),
                )
                .expect(201)
        ).body;
        const income = (
            await f.a
                .post(`/v2/spaces/${f.space}/incomes`, incomeInput(f, null))
                .expect(201)
        ).body;
        const before = await snapshot();
        for (const [id, suffix, body] of [
            [expense.commitment.id, 'disbursements', payBody(f, 1, 10000)],
            [income.commitment.id, 'receipts', receiveBody(f, 1, 10000)],
        ] as const) {
            await f.a
                .post(`${detailPath(f.space, id)}/${suffix}`, {
                    ...body,
                    factDate: '2026-10-15',
                })
                .expect(400);
            await f.a
                .post(`${detailPath(f.space, id)}/${suffix}`, {
                    ...body,
                    ...(suffix === 'receipts'
                        ? { recipientMemberId: randomUUID() }
                        : { payerMemberId: randomUUID() }),
                })
                .expect(400);
            await f.a
                .post(`${detailPath(f.space, id)}/${suffix}`, {
                    ...body,
                    expectedSpaceVersion: f.context.version + 1,
                })
                .expect(409);
            await f.a
                .post(`${detailPath(f.space, id)}/${suffix}`, {
                    ...body,
                    expectedCommitmentVersion: 99,
                })
                .expect(409);
        }
        expect(await snapshot()).toEqual(before);
    });

    it('A14 replays the original partial result after subsequent facts and distinguishes an explicit initial amount', async () => {
        const b = await browser(),
            space = b.context.personalSpace.id as string;
        const creationKey = randomUUID(),
            input = personalExpense();
        const first = (
            await b
                .post(
                    `/v2/spaces/${space}/personal-expenses`,
                    input,
                    creationKey,
                )
                .expect(201)
        ).body;
        const path = `${detailPath(space, first.commitment.id)}/disbursements`,
            key = randomUUID();
        const body = {
            expectedCommitmentVersion: 1,
            amountInCents: 20000,
            factDate: '2026-10-14',
            method: 'PIX',
        };
        const partial = (await b.post(path, body, key).expect(201)).body;
        await b
            .post(path, {
                ...body,
                expectedCommitmentVersion: 2,
                amountInCents: 50000,
            })
            .expect(201);
        expect((await b.post(path, body, key).expect(200)).body).toEqual({
            ...partial,
            replayed: true,
        });
        expect(
            (
                await b
                    .post(
                        `/v2/spaces/${space}/personal-expenses`,
                        input,
                        creationKey,
                    )
                    .expect(200)
            ).body,
        ).toEqual({ ...first, replayed: true });
        await b.post(path, { ...body, amountInCents: 10000 }, key).expect(409);
        await b
            .post(path, { ...body, factDate: '2026-10-13' }, key)
            .expect(409);
        const legacyKey = randomUUID(),
            legacy = { ...personalExpense(), disbursement: { method: 'PIX' } };
        await b
            .post(`/v2/spaces/${space}/personal-expenses`, legacy, legacyKey)
            .expect(201);
        await b
            .post(
                `/v2/spaces/${space}/personal-expenses`,
                {
                    ...legacy,
                    disbursement: { method: 'PIX', amountInCents: 100000 },
                },
                legacyKey,
            )
            .expect(409);
        expect(
            await db.query(
                'SELECT * FROM financial_disbursements WHERE commitment_id=$1',
                [first.commitment.id],
            ),
        ).toHaveLength(3);
    });

    it('A14/A15 serializes simultaneous same-key and different-key facts on independent PostgreSQL connections', async () => {
        const f = await shared();
        const income = (
            await f.a
                .post(`/v2/spaces/${f.space}/incomes`, incomeInput(f, null))
                .expect(201)
        ).body;
        const path = `${detailPath(f.space, income.commitment.id)}/receipts`,
            body = receiveBody(f, 1, 30000),
            key = randomUUID();
        const same = await concurrent(f.space, () =>
            Promise.all([f.a.post(path, body, key), f.a.post(path, body, key)]),
        );
        expect(same.map((r) => r.status).sort()).toEqual([200, 201]);
        expect(same[0].body.receipt.id).toBe(same[1].body.receipt.id);
        const next = receiveBody(f, 2, 50000);
        const distinct = await concurrent(f.space, () =>
            Promise.all([f.a.post(path, next), f.b.post(path, next)]),
        );
        expect(distinct.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(
            await db.query(
                'SELECT * FROM financial_receipts WHERE commitment_id=$1',
                [income.commitment.id],
            ),
        ).toHaveLength(2);
        expect(await openObligations(income.commitment.id)).toHaveLength(1);
        expect(
            (
                await f.a.agent
                    .get(detailPath(f.space, income.commitment.id))
                    .expect(200)
            ).body,
        ).toMatchObject({
            receivedAmountInCents: 80000,
            remainingAmountInCents: 20000,
            commitment: { version: 3 },
        });
    }, 30000);

    it('A14/A15 serializes new expense payments and replays one same-key effect on independent PostgreSQL connections', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(
                    `/v2/spaces/${f.space}/shared-cash-expenses`,
                    expenseInput(f, 10000),
                )
                .expect(201)
        ).body;
        const path = `${detailPath(f.space, first.commitment.id)}/disbursements`,
            key = randomUUID(),
            body = payBody(f, 1, 10000);
        const same = await concurrent(f.space, () =>
            Promise.all([f.a.post(path, body, key), f.a.post(path, body, key)]),
        );
        expect(same.map((response) => response.status).sort()).toEqual([
            200, 201,
        ]);
        expect(same[0].body.disbursements[1].id).toBe(
            same[1].body.disbursements[1].id,
        );
        const next = payBody(f, 2, 25000);
        const distinct = await concurrent(f.space, () =>
            Promise.all([f.a.post(path, next), f.b.post(path, next)]),
        );
        expect(distinct.map((response) => response.status).sort()).toEqual([
            201, 409,
        ]);
        const detail = (
            await f.a.agent
                .get(detailPath(f.space, first.commitment.id))
                .expect(200)
        ).body;
        expect(detail).toMatchObject({
            paidAmountInCents: 45000,
            remainingAmountInCents: 5000,
            commitment: { version: 3 },
            obligation: {
                debtorMemberId: f.mb,
                creditorMemberId: f.ma,
                remainingAmountInCents: 15000,
            },
        });
        expect(detail.disbursements).toHaveLength(3);
        expect(await openObligations(first.commitment.id)).toHaveLength(1);
    }, 30000);

    it('A15 conflicts when an idempotent receipt changes its effective member or destination', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(`/v2/spaces/${f.space}/incomes`, incomeInput(f, null))
                .expect(201)
        ).body;
        const other = (
            await f.a
                .post(`/v2/spaces/${f.space}/incomes`, incomeInput(f, null))
                .expect(201)
        ).body;
        const path = `${detailPath(f.space, first.commitment.id)}/receipts`,
            key = randomUUID(),
            body = receiveBody(f, 1, 30000);
        await f.a.post(path, body, key).expect(201);
        await f.a
            .post(path, { ...body, recipientMemberId: f.mb }, key)
            .expect(409);
        await f.a
            .post(
                `${detailPath(f.space, other.commitment.id)}/receipts`,
                body,
                key,
            )
            .expect(409);
        expect(await db.query('SELECT * FROM financial_receipts')).toHaveLength(
            1,
        );
    });

    it.each([
        'financial_disbursements',
        'inter_member_obligation_changes',
        'financial_expense_command_receipts',
    ])(
        'A16 rolls back the root and reconciliation when %s rejects a later fact',
        async (table) => {
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            const f = await shared();
            const first = (
                await f.a
                    .post(
                        `/v2/spaces/${f.space}/shared-cash-expenses`,
                        expenseInput(f, 40000),
                    )
                    .expect(201)
            ).body;
            const path = `${detailPath(f.space, first.commitment.id)}/disbursements`,
                body = payBody(f, 1, 10000),
                key = randomUUID(),
                before = await snapshot();
            await db.query(
                "CREATE FUNCTION reject_card013_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'CARD-013 forced transaction failure'; END $$",
            );
            await db.query(
                `CREATE TRIGGER reject_card013_write BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_card013_write()`,
            );
            try {
                await f.a.post(path, body, key).expect(500);
                expect(await snapshot()).toEqual(before);
            } finally {
                await db.query(`DROP TRIGGER reject_card013_write ON ${table}`);
                await db.query('DROP FUNCTION reject_card013_write()');
            }
            const retry = (await f.a.post(path, body, key).expect(201)).body;
            expect(retry).toMatchObject({
                replayed: false,
                paidAmountInCents: 50000,
                obligation: { remainingAmountInCents: 20000 },
            });
        },
    );

    it.each([
        'financial_receipts',
        'inter_member_obligation_changes',
        'financial_income_command_receipts',
    ])(
        'A16 rolls back an income direction reversal when %s rejects it',
        async (table) => {
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            const f = await shared();
            const first = (
                await f.a
                    .post(
                        `/v2/spaces/${f.space}/incomes`,
                        incomeInput(f, 50000),
                    )
                    .expect(201)
            ).body;
            const path = `${detailPath(f.space, first.commitment.id)}/receipts`,
                body = receiveBody(f, first.commitment.version, 50000, f.mb),
                key = randomUUID(),
                before = await snapshot();
            await db.query(
                "CREATE FUNCTION reject_card013_income() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'CARD-013 forced income failure'; END $$",
            );
            await db.query(
                `CREATE TRIGGER reject_card013_income BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_card013_income()`,
            );
            try {
                await f.b.post(path, body, key).expect(500);
                expect(await snapshot()).toEqual(before);
            } finally {
                await db.query(
                    `DROP TRIGGER reject_card013_income ON ${table}`,
                );
                await db.query('DROP FUNCTION reject_card013_income()');
            }
            const retry = (await f.b.post(path, body, key).expect(201)).body;
            expect(retry).toMatchObject({
                replayed: false,
                receivedAmountInCents: 100000,
                obligation: {
                    debtorMemberId: f.mb,
                    creditorMemberId: f.ma,
                    remainingAmountInCents: 10000,
                },
            });
            expect(await openObligations(first.commitment.id)).toHaveLength(1);
            expect(
                await db.query(
                    'SELECT * FROM inter_member_obligations WHERE commitment_id=$1',
                    [first.commitment.id],
                ),
            ).toHaveLength(2);
        },
    );

    it('A17 serializes a new receipt against a manual transfer without overallocating or losing history', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(`/v2/spaces/${f.space}/incomes`, incomeInput(f, 50000))
                .expect(201)
        ).body;
        const [o] = await openObligations(first.commitment.id);
        const transferInput = {
            expectedSpaceVersion: f.context.version,
            payerMemberId: f.ma,
            recipientMemberId: f.mb,
            amountInCents: 5000,
            factDate: '2026-10-14',
            allocations: [
                {
                    obligationId: o.id,
                    expectedObligationVersion: o.version,
                    amountInCents: 5000,
                },
            ],
        };
        const results = await concurrent(f.space, () =>
            Promise.all([
                f.b.post(
                    `${detailPath(f.space, first.commitment.id)}/receipts`,
                    receiveBody(f, first.commitment.version, 50000, f.mb),
                ),
                f.a.post(
                    `/v2/spaces/${f.space}/settlement-transfers`,
                    transferInput,
                ),
            ]),
        );
        expect(results[0].status).toBe(201);
        expect([201, 409]).toContain(results[1].status);
        const paid = results[1].status === 201 ? 5000 : 0;
        const open = await openObligations(first.commitment.id);
        expect(open).toHaveLength(1);
        expect(open[0]).toMatchObject({
            debtor_member_id: f.mb,
            creditor_member_id: f.ma,
            remaining_amount_in_cents: String(10000 + paid),
        });
        expect(
            await db.query('SELECT * FROM settlement_allocations'),
        ).toHaveLength(paid ? 1 : 0);
        expect(await db.query('SELECT * FROM financial_receipts')).toHaveLength(
            2,
        );
        expect(
            await db.query(
                'SELECT * FROM inter_member_obligations WHERE commitment_id=$1',
                [first.commitment.id],
            ),
        ).toHaveLength(2);
    }, 30000);

    it.each(['AMOUNTS', 'PERCENTAGES'])(
        'A18 reconciles indivisible cents over accumulated %s income instead of rounding each fact',
        async (mode) => {
            const f = await shared();
            const ids = [f.ma, f.mb].sort(),
                input = incomeInput(f, null);
            const split =
                mode === 'AMOUNTS'
                    ? {
                          mode,
                          shares: [
                              { memberId: ids[0], amountInCents: 1 },
                              { memberId: ids[1], amountInCents: 2 },
                          ],
                      }
                    : {
                          mode,
                          shares: [
                              { memberId: ids[0], basisPoints: 3333 },
                              { memberId: ids[1], basisPoints: 6667 },
                          ],
                      };
            const first = (
                await f.a
                    .post(`/v2/spaces/${f.space}/incomes`, {
                        ...input,
                        amountInCents: 3,
                        participationSplit: split,
                    })
                    .expect(201)
            ).body;
            const path = `${detailPath(f.space, first.commitment.id)}/receipts`;
            for (let version = 1; version <= 3; version++) {
                const result = (
                    await f.a
                        .post(path, receiveBody(f, version, 1, ids[0]))
                        .expect(201)
                ).body;
                expect(result.receivedAmountInCents).toBe(version);
                expect(result.obligation.remainingAmountInCents).toBe(
                    version === 1 ? 1 : version === 2 ? 1 : 2,
                );
                expect(await openObligations(first.commitment.id)).toHaveLength(
                    1,
                );
            }
            expect(
                (
                    await f.a.agent
                        .get(detailPath(f.space, first.commitment.id))
                        .expect(200)
                ).body.commitment.participationSplit.calculatedShares,
            ).toEqual([
                { memberId: ids[0], amountInCents: 1 },
                { memberId: ids[1], amountInCents: 2 },
            ]);
        },
    );

    it('A18 handles the safe monetary limit and 100/0 income without artificial obligations', async () => {
        const f = await shared(),
            amount = Number.MAX_SAFE_INTEGER;
        const first = (
            await f.a
                .post(`/v2/spaces/${f.space}/incomes`, {
                    ...incomeInput(f, null),
                    amountInCents: amount,
                    participationSplit: {
                        mode: 'PERCENTAGES',
                        shares: [
                            { memberId: f.ma, basisPoints: 10000 },
                            { memberId: f.mb, basisPoints: 0 },
                        ],
                    },
                })
                .expect(201)
        ).body;
        const path = `${detailPath(f.space, first.commitment.id)}/receipts`;
        const partial = (
            await f.a.post(path, receiveBody(f, 1, amount - 1)).expect(201)
        ).body;
        expect(partial).toMatchObject({
            receivedAmountInCents: amount - 1,
            remainingAmountInCents: 1,
            obligation: null,
        });
        const final = (await f.a.post(path, receiveBody(f, 2, 1)).expect(201))
            .body;
        expect(final).toMatchObject({
            receivedAmountInCents: amount,
            remainingAmountInCents: 0,
            obligation: null,
        });
        expect(await openObligations(first.commitment.id)).toEqual([]);
    });

    it('A21 requires current authorization before exposing a replay and isolates personal fact identities', async () => {
        const a = await browser(),
            b = await browser('Terceiro'),
            space = a.context.personalSpace.id as string;
        const first = (
            await a
                .post(
                    `/v2/spaces/${space}/personal-expenses`,
                    personalExpense(),
                )
                .expect(201)
        ).body;
        const path = `${detailPath(space, first.commitment.id)}/disbursements`,
            key = randomUUID(),
            body = {
                expectedCommitmentVersion: 1,
                amountInCents: 20000,
                factDate: '2026-10-14',
                method: 'PIX',
            };
        await a.post(path, body, key).expect(201);
        await request(app.getHttpServer())
            .get(
                `${detailPath(space, first.commitment.id)}/disbursement-options`,
            )
            .expect(401);
        await a.agent
            .post(path)
            .set('Origin', 'http://localhost:3000')
            .set('Idempotency-Key', randomUUID())
            .send(body)
            .expect(403);
        await b.post(path, body, key).expect(404);
        await b.agent
            .get(
                `${detailPath(space, first.commitment.id)}/disbursement-options`,
            )
            .expect(404);
        await b
            .post(
                `${detailPath(b.context.personalSpace.id, first.commitment.id)}/disbursements`,
                body,
            )
            .expect(404);
        for (const patch of [
            { payerPersonId: b.context.person.id },
            { payerMemberId: randomUUID() },
            { expectedSpaceVersion: 1 },
            { settlement: { mode: 'NONE' } },
        ])
            await a
                .post(path, { ...body, expectedCommitmentVersion: 2, ...patch })
                .expect(400);
        await a.post(path, body, key).expect(200);
        expect(
            (
                await a.agent
                    .get(detailPath(space, first.commitment.id))
                    .expect(200)
            ).body.disbursements,
        ).toHaveLength(2);
    });

    it('A21 allows existing shared fulfillment while CLOSING and preserves authorized CLOSED replay', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(`/v2/spaces/${f.space}/incomes`, incomeInput(f, null))
                .expect(201)
        ).body;
        const path = `${detailPath(f.space, first.commitment.id)}/receipts`;
        await db.query("UPDATE spaces SET status='CLOSING' WHERE id=$1", [
            f.space,
        ]);
        const key = randomUUID(),
            body = receiveBody(f, 1, 30000);
        await f.b.post(path, body, key).expect(201);
        await f.b.post(path, body, key).expect(200);
        await db.query("UPDATE spaces SET status='CLOSED' WHERE id=$1", [
            f.space,
        ]);
        await f.b.post(path, body, key).expect(200);
        await f.b.post(path, receiveBody(f, 2, 30000)).expect(409);
        expect(
            (
                await f.b.agent
                    .get(detailPath(f.space, first.commitment.id))
                    .expect(200)
            ).body.receivedAmountInCents,
        ).toBe(30000);
    });

    it('A22 keeps GETs read only, uses the original rule snapshot and never moves an existing cycle', async () => {
        const f = await shared();
        await f.a
            .put(`/v2/spaces/${f.space}/default-settlement-rule`, {
                expectedVersion: 0,
                rule: { kind: 'MONTHLY_DAY', dayOfMonth: 10 },
            })
            .expect(200);
        const first = (
            await f.a
                .post(
                    `/v2/spaces/${f.space}/shared-cash-expenses`,
                    expenseInput(f, 10000),
                )
                .expect(201)
        ).body;
        await f.a
            .put(`/v2/spaces/${f.space}/default-settlement-rule`, {
                expectedVersion: 1,
                rule: { kind: 'MONTHLY_DAY', dayOfMonth: 20 },
            })
            .expect(200);
        const path = detailPath(f.space, first.commitment.id),
            before = await snapshot();
        const options = (
            await f.a.agent.get(`${path}/disbursement-options`).expect(200)
        ).body;
        expect(options).toMatchObject({
            defaultSettlementRule: {
                rule: { kind: 'MONTHLY_DAY', dayOfMonth: 10 },
                version: 1,
            },
            suggestedTargetDate: '2026-11-10',
        });
        await f.a.agent.get(path).expect(200);
        await f.a.agent
            .get(`/v2/spaces/${f.space}/inter-member-position`)
            .expect(200);
        await f.a.agent
            .get(`/v2/spaces/${f.space}/settlement-cycles`)
            .expect(200);
        expect(await snapshot()).toEqual(before);
        const partial = (
            await f.a
                .post(`${path}/disbursements`, {
                    ...payBody(f, 1, 30000),
                    settlement: {
                        mode: 'SUGGESTED',
                        referenceDate: options.referenceDate,
                        expectedRuleVersion: 1,
                    },
                })
                .expect(201)
        ).body;
        const final = (
            await f.a
                .post(`${path}/disbursements`, {
                    ...payBody(f, 2, 10000),
                    settlement: { mode: 'DATE', targetDate: '2026-11-20' },
                })
                .expect(201)
        ).body;
        expect(final.obligation.cycleId).toBe(partial.obligation.cycleId);
        expect(final.settlementCycle.targetDate).toBe('2026-11-10');
        expect(final.commitment.settlementRuleSnapshot).toEqual(
            first.commitment.settlementRuleSnapshot,
        );
        expect(await db.query('SELECT * FROM settlement_cycles')).toHaveLength(
            1,
        );
    });

    it('A22 rejects a finalized cycle before persisting any new residual fact', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(
                    `/v2/spaces/${f.space}/shared-cash-expenses`,
                    expenseInput(f, 10000),
                )
                .expect(201)
        ).body;
        const cycle = randomUUID();
        await db.query(
            "INSERT INTO settlement_cycles(id,space_id,target_date,status,version,finalized_at) VALUES($1,$2,'2026-10-20','FINALIZED',1,now())",
            [cycle, f.space],
        );
        const before = await snapshot();
        await f.a
            .post(`${detailPath(f.space, first.commitment.id)}/disbursements`, {
                ...payBody(f, 1, 30000),
                settlement: { mode: 'CYCLE', cycleId: cycle },
            })
            .expect(409);
        expect(await snapshot()).toEqual(before);
    });

    it('A25 upgrades legacy expenses, income, allocations and literal command receipts without rewriting them', async () => {
        const f = await shared(),
            personalSpace = f.a.context.personalSpace.id as string,
            key = randomUUID();
        const personalInput = {
            ...personalExpense(),
            disbursement: { method: 'PIX' },
        };
        const personal = (
            await f.a
                .post(
                    `/v2/spaces/${personalSpace}/personal-expenses`,
                    personalInput,
                    key,
                )
                .expect(201)
        ).body;
        const expense = (
            await f.a
                .post(`/v2/spaces/${f.space}/shared-cash-expenses`, {
                    ...expenseInput(f, 50000),
                    disbursement: { method: 'DEBIT', payerMemberId: f.ma },
                    settlement: { mode: 'DATE', targetDate: '2026-10-20' },
                })
                .expect(201)
        ).body;
        await transfer(f, expense.commitment.id, 4000);
        await f.a
            .post(`/v2/spaces/${f.space}/incomes`, {
                ...incomeInput(f, null),
                receipt: {
                    factDate: '2026-10-13',
                    recipientMemberId: f.mb,
                    settlement: { mode: 'NONE' },
                },
            })
            .expect(201);
        await f.a
            .post(`/v2/spaces/${personalSpace}/incomes`, {
                description: 'Receita prevista legada',
                amountInCents: 10000,
                expectedReceiptDate: '2026-10-20',
                receipt: null,
            })
            .expect(201);
        await db.query(
            `UPDATE financial_expense_command_receipts SET result=(result-'status'-'paidAmountInCents'-'remainingAmountInCents'-'disbursements'-'obligations') #- '{disbursement,recordedByPersonId}' #- '{obligation,recognizedAmountInCents}'`,
        );
        await db.query(
            `UPDATE financial_income_command_receipts SET result=(result-'remainingAmountInCents'-'receipts'-'obligations') #- '{obligation,recognizedAmountInCents}'`,
        );
        const [stored] = await db.query(
            'SELECT result FROM financial_expense_command_receipts WHERE idempotency_key=$1',
            [key],
        );
        await migrationSource.initialize();
        await undoPartialFulfillment();
        const tables = Object.keys(await snapshot());
        const columns: Record<string, string[]> = {};
        for (const table of tables) {
            const rows: { column_name: string }[] = await db.query(
                "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
                [table],
            );
            columns[table] = rows.map((row) => row.column_name);
        }
        const legacySnapshot = async () =>
            Object.fromEntries(
                await Promise.all(
                    tables.map(async (table) => [
                        table,
                        await db.query(
                            `SELECT ${columns[table].map((column) => `"${column.replaceAll('"', '""')}"`).join(',')} FROM ${table} ORDER BY 1,2`,
                        ),
                    ]),
                ),
            );
        const before = await legacySnapshot();
        await migrationSource.runMigrations();
        expect(await legacySnapshot()).toEqual(before);
        const authors = await db.query(
            'SELECT d.id,d.recorded_by_person_id,c.created_by FROM financial_disbursements d JOIN financial_commitments c ON c.id=d.commitment_id ORDER BY d.id',
        );
        expect(authors).toHaveLength(2);
        for (const author of authors)
            expect(author.recorded_by_person_id).toBe(author.created_by);
        const recognized = await db.query(
            'SELECT original_amount_in_cents::text AS original,recognized_amount_in_cents::text AS recognized FROM inter_member_obligations',
        );
        expect(recognized).toHaveLength(2);
        for (const obligation of recognized)
            expect(obligation.recognized).toBe(obligation.original);
        const replay = (
            await f.a
                .post(
                    `/v2/spaces/${personalSpace}/personal-expenses`,
                    personalInput,
                    key,
                )
                .expect(200)
        ).body;
        expect(replay).toEqual({ ...stored.result, replayed: true });
        expect(replay.commitment.id).toBe(personal.commitment.id);
        expect(replay).not.toHaveProperty('disbursements');
        expect(await legacySnapshot()).toEqual(before);
        await undoPartialFulfillment();
        expect(await legacySnapshot()).toEqual(before);
        await migrationSource.runMigrations();
        expect(await legacySnapshot()).toEqual(before);
    });

    it.each([1, 2])(
        'A25 refuses a destructive downgrade with %s partial facts and rolls the migration transaction back',
        async (facts) => {
            const b = await browser(),
                space = b.context.personalSpace.id as string;
            const first = (
                await b
                    .post(
                        `/v2/spaces/${space}/personal-expenses`,
                        personalExpense(),
                    )
                    .expect(201)
            ).body;
            if (facts === 2)
                await b
                    .post(
                        `${detailPath(space, first.commitment.id)}/disbursements`,
                        {
                            expectedCommitmentVersion: 1,
                            amountInCents: 20000,
                            factDate: '2026-10-14',
                            method: 'PIX',
                        },
                    )
                    .expect(201);
            await migrationSource.initialize();
            while (
                (
                    await migrationSource.query(
                        'SELECT name FROM migrations ORDER BY id DESC LIMIT 1',
                    )
                )[0]?.name !== 'PartialFinancialFulfillment1792022400000'
            ) {
                await migrationSource.undoLastMigration();
            }
            const before = await snapshot();
            const columns = await db.query(
                "SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
            );
            const migrations = await db.query(
                'SELECT * FROM migrations ORDER BY id',
            );
            await expect(undoPartialFulfillment()).rejects.toThrow(
                'Partial financial fulfillment cannot be reverted without losing recorded facts or reconciliation history',
            );
            expect(await snapshot()).toEqual(before);
            expect(
                await db.query('SELECT * FROM migrations ORDER BY id'),
            ).toEqual(migrations);
            expect(
                await db.query(
                    "SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
                ),
            ).toEqual(columns);
        },
    );
});
