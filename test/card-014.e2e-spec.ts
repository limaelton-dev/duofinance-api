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

describe('CARD-014 credit card purchase HTTP/PostgreSQL', () => {
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
            'financial_external_liabilities',
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

    const purchasePath = (space: string) =>
        `/v2/spaces/${space}/credit-card-purchases`;
    const liabilityPath = (space: string, id: string) =>
        `${detailPath(space, id)}/external-liabilities`;
    const cardInput = (
        f: Shared,
        amount = 50000,
        assumed = amount,
        holder = f.ma,
    ) => ({
        description: 'Compra no cartão',
        amountInCents: amount,
        factDate: '2026-10-14',
        externalLiability: { amountInCents: assumed, holderMemberId: holder },
        expectedSpaceVersion: f.context.version,
        responsibilitySplit: {
            mode: 'AMOUNTS',
            shares: [
                { memberId: f.ma, amountInCents: Math.floor(amount * 0.6) },
                {
                    memberId: f.mb,
                    amountInCents: amount - Math.floor(amount * 0.6),
                },
            ],
        },
        settlement: { mode: 'NONE' },
    });
    const liabilityBody = (
        f: Shared,
        version: number,
        amount: number,
        holder = f.ma,
    ) => ({
        expectedCommitmentVersion: version,
        expectedSpaceVersion: f.context.version,
        amountInCents: amount,
        factDate: '2026-10-14',
        holderMemberId: holder,
        settlement: { mode: 'NONE' },
    });
    const personalCard = (amount = 12000, assumed = amount) => ({
        description: 'Compra pessoal',
        amountInCents: amount,
        factDate: '2026-10-14',
        externalLiability: { amountInCents: assumed },
    });

    it('A01/A02/A04 separates external support, cash and responsibility with an explicit holder', async () => {
        const f = await shared();
        for (const holder of [f.ma, f.mb]) {
            const input = cardInput(f, 20000, 20000, holder);
            input.responsibilitySplit.shares = [
                { memberId: f.ma, amountInCents: 10000 },
                { memberId: f.mb, amountInCents: 10000 },
            ];
            const response = await f.a
                .post(purchasePath(f.space), input)
                .expect(201);
            const result = response.body;
            expect(response.headers.location).toBe(
                detailPath(f.space, result.commitment.id),
            );
            expect(result).toMatchObject({
                disbursement: null,
                disbursements: [],
                paidAmountInCents: 0,
                assumedAmountInCents: 20000,
                externalOutstandingAmountInCents: 20000,
                supportedAmountInCents: 20000,
                remainingAmountInCents: 0,
                fulfillmentStatus: 'FULFILLED',
                obligation: {
                    debtorMemberId: holder === f.ma ? f.mb : f.ma,
                    creditorMemberId: holder,
                    remainingAmountInCents: 10000,
                },
            });
            expect(result.externalLiabilities).toHaveLength(1);
            expect(result.externalLiability.holderMemberId).toBe(holder);
            expect(result.obligation.originExternalLiabilityId).toBe(
                result.externalLiability.id,
            );
            expect(
                (
                    await f.b.agent
                        .get(detailPath(f.space, result.commitment.id))
                        .expect(200)
                ).body,
            ).toMatchObject({
                disbursement: null,
                supportedAmountInCents: 20000,
                remainingAmountInCents: 0,
            });
        }
        expect(await db.query('SELECT * FROM financial_disbursements')).toEqual(
            [],
        );
    });

    it('A03/A12/A22/A27 persists a retroactive personal card expense without internal entities', async () => {
        const a = await browser(),
            space = a.context.personalSpace.id as string;
        const result = (
            await a
                .post(purchasePath(space), {
                    ...personalCard(),
                    factDate: '2026-08-31',
                })
                .expect(201)
        ).body;
        expect(result).toMatchObject({
            paidAmountInCents: 0,
            supportedAmountInCents: 12000,
            remainingAmountInCents: 0,
            disbursement: null,
        });
        expect(result.externalLiability).toMatchObject({
            holderPersonId: a.context.person.id,
            factDate: '2026-08-31',
            recordedByPersonId: a.context.person.id,
        });
        expect(result.externalLiability).not.toHaveProperty('holderMemberId');
        expect(result.externalLiability.registeredAt).toBeTruthy();
        for (const table of [
            'financial_disbursements',
            'inter_member_obligations',
            'settlement_cycles',
            'settlement_transfers',
        ])
            expect(await db.query(`SELECT * FROM ${table}`)).toEqual([]);
        const detail = (
            await a.agent
                .get(detailPath(space, result.commitment.id))
                .expect(200)
        ).body;
        expect(detail.externalLiabilities).toEqual(result.externalLiabilities);
        const history = (
            await a.agent
                .get(`/v2/spaces/${space}/personal-expenses`)
                .expect(200)
        ).body;
        expect(history.items).toHaveLength(1);
        expect(history.items[0]).toMatchObject({
            id: result.commitment.id,
            paidAmountInCents: 0,
            supportedAmountInCents: 12000,
        });
        expect(
            (await a.agent.get(`/v2/spaces/${space}/today`).expect(200)).body
                .finance.data.upcomingCommitments.items,
        ).toEqual([]);
        await a
            .post(`${detailPath(space, result.commitment.id)}/disbursements`, {
                expectedCommitmentVersion: result.commitment.version,
                factDate: '2026-10-14',
                method: 'PIX',
                amountInCents: 1,
            })
            .expect(409);
    });

    it('A04 preserves indivisible cents, 0/100 shares and a single-member shared space', async () => {
        const f = await shared();
        for (const basisPoints of [0, 3333, 10000]) {
            const result = (
                await f.a
                    .post(purchasePath(f.space), {
                        ...cardInput(f, 3),
                        responsibilitySplit: {
                            mode: 'PERCENTAGES',
                            shares: [
                                { memberId: f.ma, basisPoints },
                                {
                                    memberId: f.mb,
                                    basisPoints: 10000 - basisPoints,
                                },
                            ],
                        },
                    })
                    .expect(201)
            ).body;
            expect(
                result.commitment.responsibilitySplit.calculatedShares.reduce(
                    (sum: number, share: { amountInCents: number }) =>
                        sum + share.amountInCents,
                    0,
                ),
            ).toBe(3);
            if (basisPoints === 10000) expect(result.obligation).toBeNull();
            else
                expect(result.obligation.remainingAmountInCents).toBe(
                    basisPoints === 0 ? 3 : 2,
                );
        }
        const solo = (
            await f.a.post('/v2/spaces', { name: 'Só titular' }).expect(201)
        ).body.space;
        const context = (
            await f.a.agent
                .get(`/v2/spaces/${solo.id}/financial-entry-context`)
                .expect(200)
        ).body;
        const holder = context.members[0].memberId;
        const result = (
            await f.a
                .post(purchasePath(solo.id), {
                    description: 'Um membro',
                    amountInCents: 1,
                    factDate: '2026-10-14',
                    externalLiability: { holderMemberId: holder },
                    expectedSpaceVersion: context.version,
                    responsibilitySplit: {
                        mode: 'AMOUNTS',
                        shares: [{ memberId: holder, amountInCents: 1 }],
                    },
                    settlement: { mode: 'NONE' },
                })
                .expect(201)
        ).body;
        expect(result.obligation).toBeNull();
        expect(result.supportedAmountInCents).toBe(1);
    });

    it('A05/A06/A12 accumulates ordered partial assumptions against original responsibility', async () => {
        const f = await shared();
        reverseIds();
        let current = (
            await f.a
                .post(purchasePath(f.space), cardInput(f, 50000, 10000))
                .expect(201)
        ).body;
        const first = current.externalLiability;
        expect(current.obligation).toBeNull();
        for (const [amount, remaining, debt] of [
            [20000, 20000, 0],
            [10000, 10000, 10000],
            [10000, 0, 20000],
        ]) {
            current = (
                await f.b
                    .post(
                        liabilityPath(f.space, current.commitment.id),
                        liabilityBody(f, current.commitment.version, amount),
                    )
                    .expect(201)
            ).body;
            expect(current.remainingAmountInCents).toBe(remaining);
            expect(current.externalOutstandingAmountInCents).toBe(
                50000 - remaining,
            );
            if (debt)
                expect(current.obligation.remainingAmountInCents).toBe(debt);
            else expect(current.obligation).toBeNull();
        }
        expect(current.externalLiabilities).toHaveLength(4);
        expect(current.externalLiabilities[0]).toEqual(first);
        const refreshed = (
            await f.a.agent
                .get(detailPath(f.space, current.commitment.id))
                .expect(200)
        ).body;
        expect(refreshed.externalLiabilities).toEqual(
            current.externalLiabilities,
        );
        expect(await db.query('SELECT * FROM financial_disbursements')).toEqual(
            [],
        );
    });

    it('A07/A08 combines cash and card in both orders without settling the external liability', async () => {
        const f = await shared();
        const cash = (
            await f.a
                .post(
                    `/v2/spaces/${f.space}/shared-cash-expenses`,
                    expenseInput(f, 40000),
                )
                .expect(201)
        ).body;
        const mixed = (
            await f.b
                .post(
                    liabilityPath(f.space, cash.commitment.id),
                    liabilityBody(f, 1, 10000),
                )
                .expect(201)
        ).body;
        expect(mixed).toMatchObject({
            paidAmountInCents: 40000,
            assumedAmountInCents: 10000,
            supportedAmountInCents: 50000,
            remainingAmountInCents: 0,
            externalOutstandingAmountInCents: 10000,
        });
        const card = (
            await f.a
                .post(purchasePath(f.space), cardInput(f, 50000, 10000))
                .expect(201)
        ).body;
        const final = (
            await f.b
                .post(
                    `${detailPath(f.space, card.commitment.id)}/disbursements`,
                    payBody(f, 1, 40000),
                )
                .expect(201)
        ).body;
        expect(final).toMatchObject({
            paidAmountInCents: 40000,
            assumedAmountInCents: 10000,
            supportedAmountInCents: 50000,
            remainingAmountInCents: 0,
            externalOutstandingAmountInCents: 10000,
        });
        expect(final.externalLiabilities).toEqual(card.externalLiabilities);
        expect(
            await db.query('SELECT * FROM financial_commitments'),
        ).toHaveLength(2);
    });

    it('A09/A10/A23 preserves the existing debt and allocations after another holder adds card support', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(
                    `/v2/spaces/${f.space}/shared-cash-expenses`,
                    expenseInput(f, 40000),
                )
                .expect(201)
        ).body;
        const paid = await transfer(f, first.commitment.id, 8000);
        const before = await db.query('SELECT * FROM settlement_allocations');
        const final = (
            await f.b
                .post(
                    liabilityPath(f.space, first.commitment.id),
                    liabilityBody(f, 1, 10000, f.mb),
                )
                .expect(201)
        ).body;
        expect(final).toMatchObject({
            externalOutstandingAmountInCents: 10000,
            supportedAmountInCents: 50000,
            obligation: {
                id: first.obligation.id,
                debtorMemberId: f.mb,
                creditorMemberId: f.ma,
                remainingAmountInCents: 2000,
            },
        });
        expect(await db.query('SELECT * FROM settlement_allocations')).toEqual(
            before,
        );
        expect(
            (
                await db.query(
                    'SELECT status,remaining_amount_in_cents::text AS remaining FROM inter_member_obligations WHERE id=$1',
                    [first.obligation.id],
                )
            )[0],
        ).toMatchObject({ status: 'PARTIALLY_SETTLED', remaining: '2000' });
        const detail = (
            await f.a.agent
                .get(
                    `/v2/spaces/${f.space}/settlement-transfers/${paid.transfer.id}`,
                )
                .expect(200)
        ).body;
        expect(detail.allocations[0].origin.commitmentId).toBe(
            first.commitment.id,
        );
        await transfer(f, first.commitment.id, 2000);
        const refreshed = (
            await f.a.agent
                .get(detailPath(f.space, first.commitment.id))
                .expect(200)
        ).body;
        expect(refreshed.externalOutstandingAmountInCents).toBe(10000);
        expect(await openObligations(first.commitment.id)).toEqual([]);
    });

    it('A11/A13/A22 keeps opposite origins separate and every options GET read only', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(purchasePath(f.space), cardInput(f, 50000, 40000))
                .expect(201)
        ).body;
        const opposite = (
            await f.b
                .post(purchasePath(f.space), cardInput(f, 50000, 40000, f.mb))
                .expect(201)
        ).body;
        const before = await snapshot();
        for (const path of [
            `/v2/spaces/${f.space}/credit-card-purchase-options`,
            `${detailPath(f.space, first.commitment.id)}/external-liability-options`,
            detailPath(f.space, first.commitment.id),
            `/v2/spaces/${f.space}/inter-member-position`,
        ])
            await f.a.agent.get(path).expect(200);
        expect(await snapshot()).toEqual(before);
        expect(await openObligations(first.commitment.id)).toHaveLength(1);
        expect(await openObligations(opposite.commitment.id)).toHaveLength(1);
    });

    it.each([0, -1, 0.1, Number.MAX_SAFE_INTEGER + 1, 40001])(
        'A15 refuses invalid later card amount %s atomically',
        async (amount) => {
            const f = await shared();
            const first = (
                await f.a
                    .post(purchasePath(f.space), cardInput(f, 50000, 10000))
                    .expect(201)
            ).body;
            const before = await snapshot();
            await f.a
                .post(
                    liabilityPath(f.space, first.commitment.id),
                    liabilityBody(f, 1, amount),
                )
                .expect(400);
            expect(await snapshot()).toEqual(before);
        },
    );

    it('A15 rejects future dates, foreign holders, invalid versions, incomes and missing origins', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(purchasePath(f.space), cardInput(f, 50000, 10000))
                .expect(201)
        ).body;
        const income = (
            await f.a
                .post(`/v2/spaces/${f.space}/incomes`, incomeInput(f, null))
                .expect(201)
        ).body;
        const before = await snapshot(),
            body = liabilityBody(f, 1, 10000);
        for (const patch of [
            { factDate: '2026-10-15' },
            { holderMemberId: randomUUID() },
            { holderMemberId: null },
        ])
            await f.a
                .post(liabilityPath(f.space, first.commitment.id), {
                    ...body,
                    ...patch,
                })
                .expect(400);
        for (const patch of [
            { expectedSpaceVersion: f.context.version + 1 },
            { expectedCommitmentVersion: 99 },
        ])
            await f.a
                .post(liabilityPath(f.space, first.commitment.id), {
                    ...body,
                    ...patch,
                })
                .expect(409);
        await f.a
            .post(liabilityPath(f.space, income.commitment.id), body)
            .expect(404);
        await f.a.post(liabilityPath(f.space, randomUUID()), body).expect(404);
        expect(await snapshot()).toEqual(before);
    });

    it('A16 replays historical card results after support and settlements and conflicts on payload changes', async () => {
        const f = await shared(),
            key = randomUUID(),
            input = cardInput(f, 50000, 40000);
        const first = (
            await f.a.post(purchasePath(f.space), input, key).expect(201)
        ).body;
        await transfer(f, first.commitment.id, 4000);
        const secondKey = randomUUID(),
            body = liabilityBody(f, 1, 10000);
        const second = (
            await f.a
                .post(
                    liabilityPath(f.space, first.commitment.id),
                    body,
                    secondKey,
                )
                .expect(201)
        ).body;
        expect(
            (await f.a.post(purchasePath(f.space), input, key).expect(200))
                .body,
        ).toEqual({ ...first, replayed: true });
        expect(
            (
                await f.a
                    .post(
                        liabilityPath(f.space, first.commitment.id),
                        body,
                        secondKey,
                    )
                    .expect(200)
            ).body,
        ).toEqual({ ...second, replayed: true });
        await f.a
            .post(
                purchasePath(f.space),
                { ...input, description: 'Outra compra' },
                key,
            )
            .expect(409);
        await f.a
            .post(
                liabilityPath(f.space, first.commitment.id),
                { ...body, amountInCents: 1 },
                secondKey,
            )
            .expect(409);
        const other = (
            await f.a
                .post(purchasePath(f.space), cardInput(f, 50000, 10000))
                .expect(201)
        ).body;
        await f.a
            .post(liabilityPath(f.space, other.commitment.id), body, secondKey)
            .expect(409);
        expect(
            await db.query('SELECT * FROM financial_external_liabilities'),
        ).toHaveLength(3);
    });

    it('A17 serializes card support against a manual transfer without losing allocations', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(
                    `/v2/spaces/${f.space}/shared-cash-expenses`,
                    expenseInput(f, 40000),
                )
                .expect(201)
        ).body;
        const [o] = await openObligations(first.commitment.id);
        const results = await concurrent(f.space, () =>
            Promise.all([
                f.b.post(
                    liabilityPath(f.space, first.commitment.id),
                    liabilityBody(f, 1, 10000, f.mb),
                ),
                f.a.post(`/v2/spaces/${f.space}/settlement-transfers`, {
                    expectedSpaceVersion: f.context.version,
                    payerMemberId: f.mb,
                    recipientMemberId: f.ma,
                    amountInCents: 8000,
                    factDate: '2026-10-14',
                    allocations: [
                        {
                            obligationId: o.id,
                            expectedObligationVersion: o.version,
                            amountInCents: 8000,
                        },
                    ],
                }),
            ]),
        );
        expect(results[0].status).toBe(201);
        expect([201, 409]).toContain(results[1].status);
        const paid = results[1].status === 201 ? 8000 : 0;
        const open = await openObligations(first.commitment.id);
        expect(open).toHaveLength(1);
        expect(open[0]).toMatchObject({
            id: first.obligation.id,
            debtor_member_id: f.mb,
            creditor_member_id: f.ma,
            remaining_amount_in_cents: paid ? '2000' : '10000',
        });
        expect(
            await db.query('SELECT * FROM settlement_allocations'),
        ).toHaveLength(paid ? 1 : 0);
        const detail = (
            await f.a.agent
                .get(detailPath(f.space, first.commitment.id))
                .expect(200)
        ).body;
        expect(detail.supportedAmountInCents).toBe(50000);
        expect(detail.externalOutstandingAmountInCents).toBe(10000);
    });

    it('A16 serializes same-key purchase creation on independent PostgreSQL connections', async () => {
        const f = await shared(),
            key = randomUUID(),
            body = cardInput(f);
        const results = await concurrent(f.space, () =>
            Promise.all([
                f.a.post(purchasePath(f.space), body, key),
                f.a.post(purchasePath(f.space), body, key),
            ]),
        );
        expect(results.map((result) => result.status).sort()).toEqual([
            200, 201,
        ]);
        const first = results.find((result) => result.status === 201)!.body;
        const replay = results.find((result) => result.status === 200)!.body;
        expect(replay).toEqual({ ...first, replayed: true });
        expect(await db.query('SELECT id FROM financial_commitments')).toEqual([
            { id: first.commitment.id },
        ]);
        expect(
            await db.query(
                'SELECT id,commitment_id FROM financial_external_liabilities',
            ),
        ).toEqual([
            {
                id: first.externalLiability.id,
                commitment_id: first.commitment.id,
            },
        ]);
        expect(
            await db.query(
                'SELECT commitment_id,idempotency_key,result FROM financial_expense_command_receipts',
            ),
        ).toEqual([
            {
                commitment_id: first.commitment.id,
                idempotency_key: key,
                result: first,
            },
        ]);
        expect(await openObligations(first.commitment.id)).toHaveLength(1);
        expect(await db.query('SELECT * FROM financial_disbursements')).toEqual(
            [],
        );
    });

    it.each(['same-key', 'two-cards', 'card-and-cash'])(
        'A16/A17 serializes %s on independent PostgreSQL connections',
        async (kind) => {
            const f = await shared();
            const first = (
                await f.a
                    .post(purchasePath(f.space), cardInput(f, 50000, 10000))
                    .expect(201)
            ).body;
            const path = liabilityPath(f.space, first.commitment.id),
                body = liabilityBody(f, 1, 40000),
                key = randomUUID();
            const results = await concurrent(f.space, () =>
                Promise.all([
                    f.a.post(path, body, key),
                    kind === 'card-and-cash'
                        ? f.b.post(
                              `${detailPath(f.space, first.commitment.id)}/disbursements`,
                              payBody(f, 1, 40000),
                          )
                        : f.a.post(
                              path,
                              body,
                              kind === 'same-key' ? key : randomUUID(),
                          ),
                ]),
            );
            expect(results.map((r) => r.status).sort()).toEqual(
                kind === 'same-key' ? [200, 201] : [201, 409],
            );
            const detail = (
                await f.a.agent
                    .get(detailPath(f.space, first.commitment.id))
                    .expect(200)
            ).body;
            expect(detail.supportedAmountInCents).toBe(50000);
            expect(detail.remainingAmountInCents).toBe(0);
            expect(detail.commitment.version).toBe(2);
            expect(await openObligations(first.commitment.id)).toHaveLength(1);
        },
    );

    it.each([
        'financial_external_liabilities',
        'inter_member_obligation_changes',
        'financial_expense_command_receipts',
    ])(
        'A18 rolls back the entire card transaction when %s rejects persistence',
        async (table) => {
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            const f = await shared();
            const first = (
                await f.a
                    .post(purchasePath(f.space), cardInput(f, 50000, 30000))
                    .expect(201)
            ).body;
            const before = await snapshot(),
                key = randomUUID(),
                body = {
                    ...liabilityBody(f, 1, 10000),
                    settlement: { mode: 'DATE', targetDate: '2026-11-10' },
                };
            await db.query(
                "CREATE FUNCTION reject_card014_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'CARD-014 forced transaction failure'; END $$",
            );
            await db.query(
                `CREATE TRIGGER reject_card014_write BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_card014_write()`,
            );
            try {
                await f.a
                    .post(
                        liabilityPath(f.space, first.commitment.id),
                        body,
                        key,
                    )
                    .expect(500);
                expect(await snapshot()).toEqual(before);
            } finally {
                await db.query(`DROP TRIGGER reject_card014_write ON ${table}`);
                await db.query('DROP FUNCTION reject_card014_write()');
            }
            await f.a
                .post(liabilityPath(f.space, first.commitment.id), body, key)
                .expect(201);
            expect(
                await db.query('SELECT * FROM financial_disbursements'),
            ).toEqual([]);
        },
    );

    it('A19 requires session, CSRF and current ownership before exposing card reads or replay', async () => {
        const a = await browser(),
            outsider = await browser('Terceiro'),
            space = a.context.personalSpace.id as string;
        const key = randomUUID(),
            body = personalCard(12000, 10000);
        const first = (await a.post(purchasePath(space), body, key).expect(201))
            .body;
        await request(app.getHttpServer())
            .get(`/v2/spaces/${space}/credit-card-purchase-options`)
            .expect(401);
        await a.agent
            .post(purchasePath(space))
            .set('Origin', 'http://localhost:3000')
            .set('Idempotency-Key', randomUUID())
            .send(body)
            .expect(403);
        await outsider.post(purchasePath(space), body, key).expect(404);
        await outsider.agent
            .get(detailPath(space, first.commitment.id))
            .expect(404);
        await outsider.agent
            .get(
                `${detailPath(space, first.commitment.id)}/external-liability-options`,
            )
            .expect(404);
        for (const externalLiability of [
            { holderMemberId: randomUUID() },
            { holderPersonId: outsider.context.person.id },
        ])
            await a
                .post(purchasePath(space), { ...body, externalLiability })
                .expect(400);
        await a.post(purchasePath(space), body, key).expect(200);
    });

    it('A19 preserves existing CLOSING fulfillment and authorized CLOSED replay', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(purchasePath(f.space), cardInput(f, 50000, 10000))
                .expect(201)
        ).body;
        await db.query("UPDATE spaces SET status='CLOSING' WHERE id=$1", [
            f.space,
        ]);
        const body = liabilityBody(f, 1, 10000),
            key = randomUUID();
        await f.a.post(purchasePath(f.space), cardInput(f)).expect(409);
        await f.b
            .post(liabilityPath(f.space, first.commitment.id), body, key)
            .expect(201);
        await db.query("UPDATE spaces SET status='CLOSED' WHERE id=$1", [
            f.space,
        ]);
        await f.b
            .post(liabilityPath(f.space, first.commitment.id), body, key)
            .expect(200);
        await f.b
            .post(
                liabilityPath(f.space, first.commitment.id),
                liabilityBody(f, 2, 10000),
            )
            .expect(409);
        const outsider = await browser('Novo vínculo');
        await db.query('UPDATE space_members SET person_id=$2 WHERE id=$1', [
            f.mb,
            outsider.context.person.id,
        ]);
        await f.b
            .post(liabilityPath(f.space, first.commitment.id), body, key)
            .expect(404);
        await f.b.agent
            .get(detailPath(f.space, first.commitment.id))
            .expect(404);
    });
    it('A13/A14 preserves the rule snapshot and original cycle while rejecting finalized cycles atomically', async () => {
        const f = await shared();
        await f.a
            .put(`/v2/spaces/${f.space}/default-settlement-rule`, {
                expectedVersion: 0,
                rule: { kind: 'MONTHLY_DAY', dayOfMonth: 10 },
            })
            .expect(200);
        const first = (
            await f.a
                .post(purchasePath(f.space), cardInput(f, 50000, 10000))
                .expect(201)
        ).body;
        await f.a
            .put(`/v2/spaces/${f.space}/default-settlement-rule`, {
                expectedVersion: 1,
                rule: { kind: 'MONTHLY_DAY', dayOfMonth: 20 },
            })
            .expect(200);
        const options = (
            await f.a.agent
                .get(
                    `${detailPath(f.space, first.commitment.id)}/external-liability-options`,
                )
                .expect(200)
        ).body;
        expect(options).toMatchObject({
            defaultSettlementRule: {
                rule: { kind: 'MONTHLY_DAY', dayOfMonth: 10 },
                version: 1,
            },
            suggestedTargetDate: '2026-11-10',
        });
        const partial = (
            await f.a
                .post(liabilityPath(f.space, first.commitment.id), {
                    ...liabilityBody(f, 1, 30000),
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
                .post(liabilityPath(f.space, first.commitment.id), {
                    ...liabilityBody(f, 2, 10000),
                    settlement: { mode: 'DATE', targetDate: '2026-11-20' },
                })
                .expect(201)
        ).body;
        expect(final.obligation.cycleId).toBe(partial.obligation.cycleId);
        expect(final.settlementCycle.targetDate).toBe('2026-11-10');
        expect(final.commitment.settlementRuleSnapshot).toEqual(
            first.commitment.settlementRuleSnapshot,
        );
        const cycleDetail = (
            await f.a.agent
                .get(
                    `/v2/spaces/${f.space}/settlement-cycles/${final.settlementCycle.id}`,
                )
                .expect(200)
        ).body;
        expect(cycleDetail.items).toHaveLength(1);
        expect(cycleDetail.items[0].origin).toMatchObject({
            commitmentId: first.commitment.id,
            externalLiabilityId: partial.externalLiability.id,
        });
        const position = (
            await f.a.agent
                .get(`/v2/spaces/${f.space}/inter-member-position`)
                .expect(200)
        ).body;
        expect(position.items).toHaveLength(1);
        expect(position.items[0].origin).toMatchObject({
            commitmentId: first.commitment.id,
            externalLiabilityId: partial.externalLiability.id,
        });
        const today = (
            await f.a.agent.get(`/v2/spaces/${f.space}/today`).expect(200)
        ).body;
        expect(today.finance.data.settlements.nextCycle.id).toBe(
            final.settlementCycle.id,
        );
        const another = (
            await f.a
                .post(purchasePath(f.space), cardInput(f, 50000, 10000))
                .expect(201)
        ).body;
        const cycle = randomUUID();
        await db.query(
            "INSERT INTO settlement_cycles(id,space_id,target_date,status,version,finalized_at) VALUES($1,$2,'2026-10-20','FINALIZED',1,now())",
            [cycle, f.space],
        );
        const before = await snapshot();
        await f.a
            .post(liabilityPath(f.space, another.commitment.id), {
                ...liabilityBody(f, 1, 30000),
                settlement: { mode: 'CYCLE', cycleId: cycle },
            })
            .expect(409);
        expect(await snapshot()).toEqual(before);
    });

    it('A20/A23 upgrades legacy cash, income, allocations and literal idempotent results without rewriting facts', async () => {
        const f = await shared(),
            key = randomUUID(),
            input = expenseInput(f, 40000);
        const first = (
            await f.a
                .post(`/v2/spaces/${f.space}/shared-cash-expenses`, input, key)
                .expect(201)
        ).body;
        await transfer(f, first.commitment.id, 4000);
        const income = (
            await f.a
                .post(`/v2/spaces/${f.space}/incomes`, incomeInput(f, 30000))
                .expect(201)
        ).body;
        await f.a
            .post(
                `${detailPath(f.space, income.commitment.id)}/receipts`,
                receiveBody(f, income.commitment.version, 10000),
            )
            .expect(201);
        await db.query(
            "UPDATE financial_expense_command_receipts SET result=result-'externalLiability'-'externalLiabilities'-'assumedAmountInCents'-'externalOutstandingAmountInCents'-'supportedAmountInCents'-'fulfillmentStatus'",
        );
        const [stored] = await db.query(
            'SELECT result FROM financial_expense_command_receipts WHERE idempotency_key=$1',
            [key],
        );
        await migrationSource.initialize();
        await undoCreditCardPurchase();
        const columns: { table_name: string; column_name: string }[] =
            await db.query(
                "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND (table_name LIKE 'financial_%' OR table_name LIKE 'inter_member_%' OR table_name LIKE 'settlement_%') ORDER BY table_name,ordinal_position",
            );
        const tables = [...new Set(columns.map((c) => c.table_name))];
        const legacy = async () =>
            Object.fromEntries(
                await Promise.all(
                    tables.map(async (table) => [
                        table,
                        await db.query(
                            `SELECT ${columns
                                .filter((c) => c.table_name === table)
                                .map((c) => `"${c.column_name}"`)
                                .join(',')} FROM "${table}" ORDER BY 1,2`,
                        ),
                    ]),
                ),
            );
        const before = await legacy();
        const constraints = await db.query(
            "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace AND conname NOT IN ('CHK_obligations_origin_xor','CHK_expense_receipt','CHK_obligation_changes_type','CHK_obligations_state') ORDER BY conname",
        );
        await migrationSource.runMigrations();
        expect(await legacy()).toEqual(before);
        const afterConstraints = await db.query(
            "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conname",
        );
        for (const constraint of constraints)
            expect(afterConstraints).toContainEqual(constraint);
        expect(afterConstraints).toContainEqual({
            conname: 'CHK_obligation_changes_type',
            definition: expect.stringContaining('ASSIGNMENT_CHANGED'),
        });
        expect(afterConstraints).toContainEqual({
            conname: 'CHK_obligations_state',
            definition: expect.stringContaining('WAIVED'),
        });
        expect(
            (
                await f.a
                    .post(
                        `/v2/spaces/${f.space}/shared-cash-expenses`,
                        input,
                        key,
                    )
                    .expect(200)
            ).body,
        ).toEqual({ ...stored.result, replayed: true });
        expect(await legacy()).toEqual(before);
        await undoCreditCardPurchase();
        expect(await legacy()).toEqual(before);
        await migrationSource.runMigrations();
        expect(await legacy()).toEqual(before);
    });

    it('A20 enforces positive liabilities and exactly one fact belonging to the same origin', async () => {
        const f = await shared();
        const first = (
            await f.a.post(purchasePath(f.space), cardInput(f)).expect(201)
        ).body;
        const other = (
            await f.a.post(purchasePath(f.space), cardInput(f)).expect(201)
        ).body;
        const before = await snapshot();
        await expect(
            db.query(
                'UPDATE financial_external_liabilities SET amount_in_cents=0 WHERE id=$1',
                [first.externalLiability.id],
            ),
        ).rejects.toMatchObject({ driverError: { code: '23514' } });
        await expect(
            db.query(
                'UPDATE inter_member_obligations SET external_liability_id=NULL WHERE id=$1',
                [first.obligation.id],
            ),
        ).rejects.toMatchObject({ driverError: { code: '23514' } });
        await expect(
            db.query(
                'UPDATE inter_member_obligations SET external_liability_id=$2 WHERE id=$1',
                [first.obligation.id, other.externalLiability.id],
            ),
        ).rejects.toMatchObject({ driverError: { code: '23503' } });
        await expect(
            db.query(
                'UPDATE inter_member_obligations SET disbursement_id=$2 WHERE id=$1',
                [first.obligation.id, randomUUID()],
            ),
        ).rejects.toMatchObject({ driverError: { code: '23514' } });
        expect(await snapshot()).toEqual(before);
    });

    it('A21 refuses downgrade before losing any external fact or schema constraint', async () => {
        const a = await browser(),
            space = a.context.personalSpace.id as string;
        await a.post(purchasePath(space), personalCard()).expect(201);
        await migrationSource.initialize();
        await reachCreditCardPurchase();
        const before = await snapshot();
        const schema = async () =>
            db.query(
                "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conname",
            );
        const constraints = await schema(),
            migrations = await db.query('SELECT * FROM migrations ORDER BY id');
        await expect(migrationSource.undoLastMigration()).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
        expect(await schema()).toEqual(constraints);
        expect(await db.query('SELECT * FROM migrations ORDER BY id')).toEqual(
            migrations,
        );
    });

    async function reachCreditCardPurchase() {
        while (
            (
                await migrationSource.query(
                    'SELECT name FROM migrations ORDER BY id DESC LIMIT 1',
                )
            )[0]?.name !== 'RecordCreditCardPurchase1792087652424'
        ) {
            await migrationSource.undoLastMigration();
        }
    }
    async function undoCreditCardPurchase() {
        await reachCreditCardPurchase();
        return migrationSource.undoLastMigration();
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
});
