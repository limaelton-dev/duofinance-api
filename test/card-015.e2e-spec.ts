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

describe('CARD-015 external liability settlement HTTP/PostgreSQL', () => {
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
            'financial_external_liability_settlements',
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

    const settlementPath = (
        space: string,
        commitment: string,
        liability: string,
    ) => `${liabilityPath(space, commitment)}/${liability}/settlements`;
    const openPath = (space: string) =>
        `/v2/spaces/${space}/external-liabilities`;
    const settleBody = (version: number, amount: number, f?: Shared) => ({
        expectedCommitmentVersion: version,
        amountInCents: amount,
        factDate: '2026-10-14',
        ...(f ? { expectedSpaceVersion: f.context.version } : {}),
    });
    async function internalSnapshot() {
        const all = await snapshot();
        all.financial_external_liabilities =
            all.financial_external_liabilities.map(
                ({
                    remaining_amount_in_cents: _remaining,
                    ...original
                }: Record<string, unknown>) => original,
            );
        return Object.fromEntries(
            Object.entries(all).filter(
                ([table]) =>
                    ![
                        'financial_external_liability_settlements',
                        'financial_commitments',
                        'financial_expense_command_receipts',
                    ].includes(table),
            ),
        );
    }
    async function personal(amount = 20000) {
        const a = await browser(),
            space = a.context.personalSpace.id as string;
        const first = (
            await a.post(purchasePath(space), personalCard(amount)).expect(201)
        ).body;
        const path = settlementPath(
            space,
            first.commitment.id,
            first.externalLiability.id,
        );
        return { a, space, first, path };
    }

    it('A01/A05/A07 settles personal debt partially then fully and preserves historical replay', async () => {
        const { a, space, first, path } = await personal();
        const before = await internalSnapshot(),
            key = randomUUID(),
            body = { ...settleBody(1, 6000), factDate: '2026-08-31' };
        const partial = (await a.post(path, body, key).expect(201)).body;
        expect(partial).toMatchObject({
            paidAmountInCents: 0,
            assumedAmountInCents: 20000,
            externalSettledAmountInCents: 6000,
            externalOutstandingAmountInCents: 14000,
            supportedAmountInCents: 20000,
            remainingAmountInCents: 0,
            commitment: { id: first.commitment.id, version: 2 },
            settlement: {
                externalLiabilityId: first.externalLiability.id,
                amountInCents: 6000,
                holderPersonId: a.context.person.id,
                recordedByPersonId: a.context.person.id,
                factDate: '2026-08-31',
                sequence: 2,
            },
        });
        expect(partial.settlement.registeredAt).toBeTruthy();
        expect(partial.settlement).not.toHaveProperty('holderMemberId');
        const full = (await a.post(path, settleBody(2, 14000)).expect(201))
            .body;
        expect(full).toMatchObject({
            externalSettledAmountInCents: 20000,
            externalOutstandingAmountInCents: 0,
            commitment: { version: 3 },
        });
        expect(full.externalLiabilities[0].settlements).toHaveLength(2);
        expect(full.externalLiabilities[0].settlements[1].sequence).toBe(3);
        const stable = await snapshot();
        expect((await a.post(path, body, key).expect(200)).body).toEqual({
            ...partial,
            replayed: true,
        });
        await a.post(path, { ...body, amountInCents: 6001 }, key).expect(409);
        await a.post(path, settleBody(3, 1)).expect(409);
        expect(
            (await a.agent.get(openPath(space)).expect(200)).body.items,
        ).toEqual([]);
        expect(
            (
                await a.agent
                    .get(detailPath(space, first.commitment.id))
                    .expect(200)
            ).body.externalLiabilities,
        ).toEqual(full.externalLiabilities);
        expect(await snapshot()).toEqual(stable);
        expect(await internalSnapshot()).toEqual(before);
    });

    it.each([0, 4000, 10000])(
        'A02/A03 preserves support and an internal transfer of %s, including a finalized cycle',
        async (transferred) => {
            const f = await shared();
            const input = {
                ...cardInput(f, 20000, 20000, f.mb),
                responsibilitySplit: {
                    mode: 'AMOUNTS',
                    shares: [
                        { memberId: f.ma, amountInCents: 10000 },
                        { memberId: f.mb, amountInCents: 10000 },
                    ],
                },
                settlement: { mode: 'DATE', targetDate: '2026-10-20' },
            };
            const first = (
                await f.a.post(purchasePath(f.space), input).expect(201)
            ).body;
            if (transferred)
                await transfer(f, first.commitment.id, transferred);
            if (transferred === 10000) {
                await db.query(
                    "UPDATE settlement_cycles SET status='FINALIZED', finalized_at=now(), version=version+1 WHERE id=$1",
                    [first.obligation.cycleId],
                );
            }
            const before = await internalSnapshot();
            const path = settlementPath(
                f.space,
                first.commitment.id,
                first.externalLiability.id,
            );
            for (const [version, amount] of [
                [1, 6000],
                [2, 14000],
            ]) {
                const result = (
                    await f.b
                        .post(path, settleBody(version, amount, f))
                        .expect(201)
                ).body;
                expect(result).toMatchObject({
                    paidAmountInCents: 0,
                    assumedAmountInCents: 20000,
                    supportedAmountInCents: 20000,
                    remainingAmountInCents: 0,
                });
                expect(result.settlement).toMatchObject({
                    holderMemberId: f.mb,
                    recordedByPersonId: f.b.context.person.id,
                });
                expect(result.settlement).not.toHaveProperty('holderPersonId');
                expect(await internalSnapshot()).toEqual(before);
            }
            expect(
                (
                    await f.a.agent
                        .get(detailPath(f.space, first.commitment.id))
                        .expect(200)
                ).body.externalSettledAmountInCents,
            ).toBe(20000);
        },
    );

    it('A04 reduces only the selected liability in mixed support with multiple holders and indivisible cents', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(
                    '/v2/spaces/' + f.space + '/shared-cash-expenses',
                    expenseInput(f, 10001),
                )
                .expect(201)
        ).body;
        const second = (
            await f.a
                .post(
                    liabilityPath(f.space, first.commitment.id),
                    liabilityBody(f, 1, 20001, f.mb),
                )
                .expect(201)
        ).body;
        const third = (
            await f.a
                .post(
                    liabilityPath(f.space, first.commitment.id),
                    liabilityBody(f, 2, 19998),
                )
                .expect(201)
        ).body;
        const target = second.externalLiability;
        const other = third.externalLiabilities.find(
            (l: { id: string }) => l.id !== target.id,
        );
        const before = await internalSnapshot();
        const result = (
            await f.b
                .post(
                    settlementPath(f.space, first.commitment.id, target.id),
                    settleBody(3, 1, f),
                )
                .expect(201)
        ).body;
        expect(result).toMatchObject({
            paidAmountInCents: 10001,
            assumedAmountInCents: 39999,
            supportedAmountInCents: 50000,
            externalSettledAmountInCents: 1,
            externalOutstandingAmountInCents: 39998,
        });
        expect(
            result.externalLiabilities.find(
                (l: { id: string }) => l.id === other.id,
            ),
        ).toEqual(other);
        expect(result.disbursements).toEqual(third.disbursements);
        expect(result.commitment.responsibilitySplit).toEqual(
            first.commitment.responsibilitySplit,
        );
        expect(await internalSnapshot()).toEqual(before);
    });

    it('A04/A08 adds cash and card support after settlement without reusing settlement as support', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(purchasePath(f.space), cardInput(f, 20000, 5000))
                .expect(201)
        ).body;
        const path = settlementPath(
            f.space,
            first.commitment.id,
            first.externalLiability.id,
        );
        await f.a.post(path, settleBody(1, 2000, f)).expect(201);
        const second = (
            await f.a
                .post(
                    liabilityPath(f.space, first.commitment.id),
                    liabilityBody(f, 2, 5000),
                )
                .expect(201)
        ).body;
        expect(second).toMatchObject({
            commitment: { version: 3 },
            supportedAmountInCents: 10000,
            externalSettledAmountInCents: 2000,
            externalOutstandingAmountInCents: 8000,
            remainingAmountInCents: 10000,
        });
        const result = (
            await f.a
                .post(
                    `${detailPath(f.space, first.commitment.id)}/disbursements`,
                    {
                        expectedCommitmentVersion: 3,
                        expectedSpaceVersion: f.context.version,
                        amountInCents: 10000,
                        factDate: '2026-10-14',
                        method: 'PIX',
                        payerMemberId: f.ma,
                        settlement: { mode: 'NONE' },
                    },
                )
                .expect(201)
        ).body;
        expect(result).toMatchObject({
            commitment: { version: 4 },
            paidAmountInCents: 10000,
            assumedAmountInCents: 10000,
            externalSettledAmountInCents: 2000,
            supportedAmountInCents: 20000,
            remainingAmountInCents: 0,
        });
        expect(result.externalLiabilities[0].settlements).toHaveLength(1);
        expect(result.externalLiabilities).toHaveLength(2);
        expect(
            (await openObligations(first.commitment.id))[0]
                .remaining_amount_in_cents,
        ).toBe('8000');
        expect(
            await db.query(
                'SELECT * FROM financial_external_liability_settlements',
            ),
        ).toHaveLength(1);
    });

    it('A05/A07 checks current access and holder before replay, keeps shared reading and isolates origins', async () => {
        const f = await shared(),
            outsider = await browser('Terceiro');
        const first = (
            await f.a
                .post(purchasePath(f.space), cardInput(f, 20000, 20000, f.mb))
                .expect(201)
        ).body;
        const path = settlementPath(
                f.space,
                first.commitment.id,
                first.externalLiability.id,
            ),
            key = randomUUID(),
            body = settleBody(1, 6000, f);
        await f.b.post(path, body, key).expect(201);
        const before = await snapshot();
        await f.a.post(path, body, key).expect(403);
        await outsider.post(path, body, key).expect(404);
        await outsider.agent.get(openPath(f.space)).expect(404);
        await outsider.agent
            .get(path.replace(/settlements$/, 'settlement-options'))
            .expect(404);
        expect(
            (await f.a.agent.get(openPath(f.space)).expect(200)).body.items,
        ).toEqual([]);
        expect(
            (await f.b.agent.get(openPath(f.space)).expect(200)).body.items,
        ).toHaveLength(1);
        expect(
            (
                await f.a.agent
                    .get(detailPath(f.space, first.commitment.id))
                    .expect(200)
            ).body.externalSettledAmountInCents,
        ).toBe(6000);
        await f.b
            .post(
                settlementPath(
                    f.space,
                    randomUUID(),
                    first.externalLiability.id,
                ),
                body,
            )
            .expect(404);
        await f.b
            .post(
                settlementPath(f.space, first.commitment.id, randomUUID()),
                body,
            )
            .expect(404);
        await f.b
            .post(
                settlementPath(
                    outsider.context.personalSpace.id,
                    first.commitment.id,
                    first.externalLiability.id,
                ),
                body,
            )
            .expect(404);
        expect(await snapshot()).toEqual(before);
        await db.query('UPDATE space_members SET person_id=$2 WHERE id=$1', [
            f.mb,
            outsider.context.person.id,
        ]);
        await f.b.post(path, body, key).expect(404);
    });

    it('A05/A06 requires session, CSRF, idempotency and personal ownership without accepting client identity', async () => {
        const { a, space, first, path } = await personal(),
            b = await browser('Outra pessoa'),
            body = settleBody(1, 1);
        const before = await snapshot();
        await request(app.getHttpServer()).get(openPath(space)).expect(401);
        await a.agent
            .post(path)
            .set('Origin', 'http://localhost:3000')
            .set('Idempotency-Key', randomUUID())
            .send(body)
            .expect(403);
        const csrf = (await a.agent.get('/v2/auth/csrf').expect(200)).body
            .csrfToken;
        await a.agent
            .post(path)
            .set('Origin', 'http://localhost:3000')
            .set('X-CSRF-Token', csrf)
            .send(body)
            .expect(400);
        await b.post(path, body).expect(404);
        await b.agent.get(openPath(space)).expect(404);
        for (const patch of [
            { holderPersonId: b.context.person.id },
            { holderMemberId: randomUUID() },
            { recordedByPersonId: b.context.person.id },
            { expectedSpaceVersion: 1 },
            { settlement: { mode: 'NONE' } },
            { method: 'PIX' },
        ]) {
            await a.post(path, { ...body, ...patch }).expect(400);
        }
        await a
            .post(settlementPath(space, first.commitment.id, 'invalid'), body)
            .expect(400);
        expect(await snapshot()).toEqual(before);
    });

    it('A06 rejects invalid amounts, dates, versions and bodies atomically', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(purchasePath(f.space), cardInput(f, 20000))
                .expect(201)
        ).body;
        const path = settlementPath(
                f.space,
                first.commitment.id,
                first.externalLiability.id,
            ),
            body = settleBody(1, 6000, f);
        const before = await snapshot();
        for (const patch of [
            { amountInCents: 0 },
            { amountInCents: -1 },
            { amountInCents: 1.5 },
            { amountInCents: Number.MAX_SAFE_INTEGER + 1 },
            { amountInCents: '1' },
            { amountInCents: 20001 },
            { factDate: '2026-02-30' },
            { factDate: '2026-10-15' },
            { factDate: '2026-10-14T00:00:00Z' },
            { expectedCommitmentVersion: 0 },
            { expectedCommitmentVersion: 1.5 },
            { expectedSpaceVersion: undefined },
            { unexpected: true },
        ]) {
            await f.a.post(path, { ...body, ...patch }).expect(400);
        }
        for (const patch of [
            { expectedCommitmentVersion: 2 },
            { expectedSpaceVersion: f.context.version + 1 },
        ]) {
            await f.a.post(path, { ...body, ...patch }).expect(409);
        }
        expect(await snapshot()).toEqual(before);
    });

    it('A07 permits CLOSING fulfillment and authorized CLOSED replay but no new settlement', async () => {
        const f = await shared();
        const first = (
            await f.a
                .post(purchasePath(f.space), cardInput(f, 20000))
                .expect(201)
        ).body;
        const path = settlementPath(
                f.space,
                first.commitment.id,
                first.externalLiability.id,
            ),
            key = randomUUID(),
            body = settleBody(1, 6000, f);
        await db.query("UPDATE spaces SET status='CLOSING' WHERE id=$1", [
            f.space,
        ]);
        const result = (await f.a.post(path, body, key).expect(201)).body;
        await db.query("UPDATE spaces SET status='CLOSED' WHERE id=$1", [
            f.space,
        ]);
        expect((await f.a.post(path, body, key).expect(200)).body).toEqual({
            ...result,
            replayed: true,
        });
        const before = await snapshot();
        await f.a.post(path, settleBody(2, 14000, f)).expect(409);
        expect(await snapshot()).toEqual(before);
    });

    it.each(['same-key', 'distinct-keys', 'concurrent-support'])(
        'A08 serializes %s on separate real PostgreSQL connections',
        async (kind) => {
            const f = await shared();
            const first = (
                await f.a
                    .post(purchasePath(f.space), cardInput(f, 20000, 10000))
                    .expect(201)
            ).body;
            const path = settlementPath(
                    f.space,
                    first.commitment.id,
                    first.externalLiability.id,
                ),
                key = randomUUID(),
                body = settleBody(1, 10000, f);
            const results = await concurrent(f.space, () =>
                Promise.all([
                    f.a.post(path, body, key),
                    kind === 'concurrent-support'
                        ? f.a.post(
                              liabilityPath(f.space, first.commitment.id),
                              liabilityBody(f, 1, 10000),
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
            expect(detail.commitment.version).toBe(2);
            if (kind === 'same-key') {
                const result = results.find((r) => r.status === 201)!.body;
                expect(results.find((r) => r.status === 200)!.body).toEqual({
                    ...result,
                    replayed: true,
                });
            }
            const settlements = await db.query(
                'SELECT * FROM financial_external_liability_settlements',
            );
            const settlementWon =
                kind !== 'concurrent-support' || results[0].status === 201;
            expect(settlements).toHaveLength(settlementWon ? 1 : 0);
            expect(detail.externalOutstandingAmountInCents).toBe(
                settlementWon ? 0 : 20000,
            );
            expect(
                await db.query('SELECT * FROM financial_disbursements'),
            ).toEqual([]);
        },
    );

    it.each([
        'financial_external_liability_settlements',
        'financial_expense_command_receipts',
    ])(
        'A08 rolls back fact, version, balance and receipt when %s fails',
        async (table) => {
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            const { a, path } = await personal(),
                before = await snapshot(),
                key = randomUUID(),
                body = settleBody(1, 6000);
            await db.query(
                "CREATE FUNCTION reject_card015_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'CARD-015 forced transaction failure'; END $$",
            );
            await db.query(
                `CREATE TRIGGER reject_card015_write BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_card015_write()`,
            );
            try {
                await a.post(path, body, key).expect(500);
                expect(await snapshot()).toEqual(before);
            } finally {
                await db.query(`DROP TRIGGER reject_card015_write ON ${table}`);
                await db.query('DROP FUNCTION reject_card015_write()');
            }
            await a.post(path, body, key).expect(201);
            expect(
                await db.query(
                    'SELECT * FROM financial_external_liability_settlements',
                ),
            ).toHaveLength(1);
        },
    );

    it('A09 preserves legacy card facts, allocations and literal receipts through down/up', async () => {
        const f = await shared(),
            key = randomUUID(),
            input = cardInput(f, 20000);
        const first = (
            await f.a.post(purchasePath(f.space), input, key).expect(201)
        ).body;
        await transfer(f, first.commitment.id, 4000);
        await db.query(
            "UPDATE financial_expense_command_receipts SET result=result-'externalSettledAmountInCents'",
        );
        const [stored] = await db.query(
            'SELECT result FROM financial_expense_command_receipts WHERE idempotency_key=$1',
            [key],
        );
        const legacy = async () =>
            Object.fromEntries(
                Object.entries(await snapshot()).filter(
                    ([table]) =>
                        table !== 'financial_external_liability_settlements',
                ),
            );
        const before = await legacy();
        await migrationSource.initialize();
        await migrationSource.undoLastMigration();
        expect(
            (
                await db.query(
                    "SELECT to_regclass('public.financial_external_liability_settlements') AS name",
                )
            )[0].name,
        ).toBeNull();
        await migrationSource.runMigrations();
        expect(await legacy()).toEqual(before);
        expect(
            (await f.a.post(purchasePath(f.space), input, key).expect(200))
                .body,
        ).toEqual({ ...stored.result, replayed: true });
        const detail = (
            await f.a.agent
                .get(detailPath(f.space, first.commitment.id))
                .expect(200)
        ).body;
        expect(detail.externalSettledAmountInCents).toBe(0);
        expect(detail.externalLiabilities[0].settlements).toEqual([]);
        await f.a
            .post(
                settlementPath(
                    f.space,
                    first.commitment.id,
                    first.externalLiability.id,
                ),
                settleBody(1, 1, f),
            )
            .expect(201);
    });

    it('A09 enforces positive amounts, origin/receipt identity and refuses destructive downgrade atomically', async () => {
        const { a, space, first, path } = await personal();
        const other = (
            await a.post(purchasePath(space), personalCard()).expect(201)
        ).body;
        const result = (await a.post(path, settleBody(1, 6000)).expect(201))
            .body;
        const before = await snapshot();
        await expect(
            db.query(
                'UPDATE financial_external_liability_settlements SET amount_in_cents=0 WHERE id=$1',
                [result.settlement.id],
            ),
        ).rejects.toMatchObject({ driverError: { code: '23514' } });
        await expect(
            db.query(
                'UPDATE financial_external_liability_settlements SET external_liability_id=$2 WHERE id=$1',
                [result.settlement.id, other.externalLiability.id],
            ),
        ).rejects.toMatchObject({ driverError: { code: '23503' } });
        await expect(
            db.query(
                'UPDATE financial_external_liability_settlements SET space_id=$2 WHERE id=$1',
                [result.settlement.id, randomUUID()],
            ),
        ).rejects.toMatchObject({ driverError: { code: '23503' } });
        await expect(
            db.query(
                'UPDATE financial_external_liability_settlements SET idempotency_key=$2 WHERE id=$1',
                [result.settlement.id, randomUUID()],
            ),
        ).rejects.toMatchObject({ driverError: { code: '23503' } });
        await expect(
            db.query(
                'INSERT INTO financial_external_liability_settlements SELECT * FROM financial_external_liability_settlements WHERE id=$1',
                [result.settlement.id],
            ),
        ).rejects.toMatchObject({ driverError: { code: '23505' } });
        expect(result.settlement.externalLiabilityId).toBe(
            first.externalLiability.id,
        );
        const schema = async () =>
            db.query(
                "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conname",
            );
        const constraints = await schema(),
            migrations = await db.query('SELECT * FROM migrations ORDER BY id');
        await migrationSource.initialize();
        await expect(migrationSource.undoLastMigration()).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
        expect(await schema()).toEqual(constraints);
        expect(await db.query('SELECT * FROM migrations ORDER BY id')).toEqual(
            migrations,
        );
    });

    it('A10 paginates only own open liabilities with navigable origins and read-only options', async () => {
        const a = await browser(),
            space = a.context.personalSpace.id as string;
        const ids = new Set<string>();
        for (let i = 0; i < 22; i++) {
            const result = (
                await a
                    .post(purchasePath(space), {
                        ...personalCard(100 + i),
                        description: `Compra ${i}`,
                    })
                    .expect(201)
            ).body;
            ids.add(result.externalLiability.id);
        }
        const before = await snapshot();
        const page = (await a.agent.get(openPath(space)).expect(200)).body;
        expect(page.items).toHaveLength(20);
        expect(page.nextCursor).toBeTruthy();
        const next = (
            await a.agent
                .get(openPath(space))
                .query({ cursor: page.nextCursor })
                .expect(200)
        ).body;
        expect(next.items).toHaveLength(2);
        expect(next.nextCursor).toBeNull();
        expect(
            new Set(
                [...page.items, ...next.items].map(
                    (i: { externalLiability: { id: string } }) =>
                        i.externalLiability.id,
                ),
            ),
        ).toEqual(ids);
        const item = page.items[0];
        const path = settlementPath(
            space,
            item.commitmentId,
            item.externalLiability.id,
        );
        const options = (
            await a.agent
                .get(path.replace(/settlements$/, 'settlement-options'))
                .expect(200)
        ).body;
        expect(options).toMatchObject({
            commitmentId: item.commitmentId,
            expectedCommitmentVersion: item.commitmentVersion,
            description: item.description,
            canSettle: true,
        });
        await a.agent
            .get(openPath(space))
            .query({ cursor: 'invalid' })
            .expect(400);
        expect(await snapshot()).toEqual(before);
        await a
            .post(
                path,
                settleBody(
                    item.commitmentVersion,
                    item.externalLiability.amountInCents,
                ),
            )
            .expect(201);
        const refreshed = (await a.agent.get(openPath(space)).expect(200)).body;
        expect(
            refreshed.items.some(
                (i: { externalLiability: { id: string } }) =>
                    i.externalLiability.id === item.externalLiability.id,
            ),
        ).toBe(false);
        expect(
            (
                await a.agent
                    .get(path.replace(/settlements$/, 'settlement-options'))
                    .expect(200)
            ).body.canSettle,
        ).toBe(false);
    }, 30000);

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
