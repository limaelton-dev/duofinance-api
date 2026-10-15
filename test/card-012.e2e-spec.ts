import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from './setup-env.js';
import { AppModule } from '../dist/app.module.js';
import { configureApp } from '../dist/configure-app.js';
import migrationSource from '../dist/shared/technical/database/typeorm/data-source.js';
import { FINANCES_CLOCK } from '../dist/modules/finances/application/ports/private/shared-expense.repositories.js';

describe('CARD-012 income and receipt HTTP/PostgreSQL', () => {
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

    it('keeps a personal forecast separate from its later full receipt, today and replay', async () => {
        const b = await browser('Titular');
        const space = b.context.personalSpace.id as string;
        const path = `/v2/spaces/${space}/incomes`;
        const input = {
            description: 'Salário',
            amountInCents: 100000,
            expectedReceiptDate: '2026-10-20',
            receipt: null,
        };
        const key = randomUUID();
        const created = (await b.post(path, input, key).expect(201)).body;
        expect(created).toMatchObject({
            spaceType: 'PERSONAL',
            status: 'PENDING',
            receipt: null,
            receivedAmountInCents: 0,
        });
        expect(
            (await b.post(path, input, key).expect(200)).body.commitment.id,
        ).toBe(created.commitment.id);
        expect(
            (await b.agent.get(`/v2/spaces/${space}/today`).expect(200)).body
                .finance.data.upcomingCommitments.items,
        ).toMatchObject([
            { commitmentId: created.commitment.id, kind: 'INCOME' },
        ]);
        const receiptPath = `/v2/spaces/${space}/financial-commitments/${created.commitment.id}/receipts`;
        const receiptKey = randomUUID();
        const received = (
            await b
                .post(
                    receiptPath,
                    {
                        expectedCommitmentVersion: 1,
                        factDate: '2026-10-14',
                    },
                    receiptKey,
                )
                .expect(201)
        ).body;
        expect(received).toMatchObject({
            status: 'RECEIVED',
            receivedAmountInCents: 100000,
            obligation: null,
            commitment: { expectedReceiptDate: '2026-10-20', version: 2 },
        });
        expect(received.receipt.id).not.toBe(created.commitment.id);
        expect(
            (
                await b
                    .post(
                        receiptPath,
                        {
                            expectedCommitmentVersion: 1,
                            factDate: '2026-10-14',
                        },
                        receiptKey,
                    )
                    .expect(200)
            ).body.receipt.id,
        ).toBe(received.receipt.id);
        await b
            .post(
                receiptPath,
                {
                    expectedCommitmentVersion: 1,
                    factDate: '2026-10-13',
                },
                receiptKey,
            )
            .expect(409);
        expect(
            (await b.agent.get(`/v2/spaces/${space}/today`).expect(200)).body
                .finance.data.upcomingCommitments.items,
        ).toEqual([]);
        expect(
            (
                await b.agent
                    .get(
                        `/v2/spaces/${space}/financial-commitments/${created.commitment.id}`,
                    )
                    .expect(200)
            ).body.receipt.id,
        ).toBe(received.receipt.id);
        await b
            .post(receiptPath, {
                expectedCommitmentVersion: 1,
                factDate: '2026-10-14',
            })
            .expect(409);
    });

    it('directs shared repass from actual receiver and settles it without another receipt', async () => {
        const f = await shared();
        const path = `/v2/spaces/${f.space}/incomes`;
        const input = {
            description: 'Venda',
            amountInCents: 100000,
            expectedReceiptDate: '2026-10-20',
            expectedSpaceVersion: f.context.version,
            participationSplit: {
                mode: 'PERCENTAGES',
                shares: [
                    { memberId: f.ma, basisPoints: 6000 },
                    { memberId: f.mb, basisPoints: 4000 },
                ],
            },
            expectedRecipientMemberId: f.ma,
            receipt: {
                factDate: '2026-10-14',
                recipientMemberId: f.mb,
                settlement: { mode: 'NONE' },
            },
        };
        const income = (await f.a.post(path, input).expect(201)).body;
        expect(income).toMatchObject({
            status: 'RECEIVED',
            receipt: { recipientMemberId: f.mb },
            obligation: {
                debtorMemberId: f.mb,
                creditorMemberId: f.ma,
                originalAmountInCents: 60000,
                originReceiptId: income.receipt.id,
            },
        });
        const position = (
            await f.b.agent
                .get(`/v2/spaces/${f.space}/inter-member-position`)
                .expect(200)
        ).body;
        expect(position.items[0].origin).toMatchObject({
            kind: 'INCOME',
            commitmentId: income.commitment.id,
            receiptId: income.receipt.id,
        });
        const transfer = (
            await f.b
                .post(`/v2/spaces/${f.space}/settlement-transfers`, {
                    expectedSpaceVersion: f.context.version,
                    payerMemberId: f.mb,
                    recipientMemberId: f.ma,
                    amountInCents: 25000,
                    factDate: '2026-10-14',
                    allocations: [
                        {
                            obligationId: income.obligation.id,
                            expectedObligationVersion: 1,
                            amountInCents: 25000,
                        },
                    ],
                })
                .expect(201)
        ).body;
        expect(transfer.allocations[0].origin).toMatchObject({
            kind: 'INCOME',
            receiptId: income.receipt.id,
        });
        const detail = (
            await f.a.agent
                .get(
                    `/v2/spaces/${f.space}/financial-commitments/${income.commitment.id}`,
                )
                .expect(200)
        ).body;
        expect(detail.receipt.id).toBe(income.receipt.id);
        expect(detail.obligation.remainingAmountInCents).toBe(35000);
        expect(
            (
                await db.query(
                    'SELECT count(*)::int AS count FROM financial_receipts',
                )
            )[0].count,
        ).toBe(1);
    });
    it('keeps a shared forecast pending, receives it later and rejects a second concurrent receipt', async () => {
        const f = await shared();
        const base = `/v2/spaces/${f.space}`;
        const input = {
            description: 'Projeto',
            amountInCents: 100001,
            expectedReceiptDate: '2026-10-21',
            expectedSpaceVersion: f.context.version,
            participationSplit: {
                mode: 'PERCENTAGES',
                shares: [
                    { memberId: f.ma, basisPoints: 6000 },
                    { memberId: f.mb, basisPoints: 4000 },
                ],
            },
            expectedRecipientMemberId: f.ma,
            receipt: null,
        };
        const pending = (await f.a.post(`${base}/incomes`, input).expect(201))
            .body;
        expect(pending).toMatchObject({
            status: 'PENDING',
            receipt: null,
            obligation: null,
        });
        expect(
            (
                await f.b.agent
                    .get(
                        `${base}/financial-commitments/${pending.commitment.id}`,
                    )
                    .expect(200)
            ).body.commitment.participationSplit.calculatedShares,
        ).toEqual(
            [
                { memberId: f.ma, amountInCents: 60001 },
                { memberId: f.mb, amountInCents: 40000 },
            ].sort((x, y) => x.memberId.localeCompare(y.memberId)),
        );
        const options = (
            await f.b.agent
                .get(
                    `${base}/financial-commitments/${pending.commitment.id}/receipt-options`,
                )
                .expect(200)
        ).body;
        expect(options).toMatchObject({
            expectedCommitmentVersion: 1,
            expectedSpaceVersion: f.context.version,
            canReceive: true,
        });
        const receiptPath = `${base}/financial-commitments/${pending.commitment.id}/receipts`;
        const body = {
            expectedCommitmentVersion: 1,
            expectedSpaceVersion: f.context.version,
            factDate: '2026-10-13',
            recipientMemberId: f.ma,
            settlement: { mode: 'NONE' },
        };
        const responses = await Promise.all([
            f.a.post(receiptPath, body),
            f.b.post(receiptPath, body),
        ]);
        expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
        const winner = responses.find((r) => r.status === 201)!.body;
        expect(winner.obligation).toMatchObject({
            debtorMemberId: f.ma,
            creditorMemberId: f.mb,
            originalAmountInCents: 40000,
        });
        expect(
            (
                await db.query(
                    'SELECT count(*)::int AS count FROM financial_receipts',
                )
            )[0].count,
        ).toBe(1);
        expect(
            (
                await db.query(
                    'SELECT count(*)::int AS count FROM inter_member_obligations',
                )
            )[0].count,
        ).toBe(1);
        expect(
            (await f.a.agent.get(`${base}/incomes?status=RECEIVED`).expect(200))
                .body.items,
        ).toMatchObject([{ id: pending.commitment.id, status: 'RECEIVED' }]);
    });
    it('refuses migration rollback while an income exists without changing any fact', async () => {
        const b = await browser('Titular rollback');
        const space = b.context.personalSpace.id as string;
        const income = (
            await b
                .post(`/v2/spaces/${space}/incomes`, {
                    description: 'Receita preservada',
                    amountInCents: 5000,
                    expectedReceiptDate: '2026-10-15',
                    receipt: null,
                })
                .expect(201)
        ).body;
        const before = await db.query(
            'SELECT * FROM financial_commitments WHERE id=$1',
            [income.commitment.id],
        );
        await migrationSource.initialize();
        try {
            while (
                (
                    await migrationSource.query(
                        'SELECT name FROM migrations ORDER BY id DESC LIMIT 1',
                    )
                )[0]?.name !== 'RecordIncomeAndReceipt1792022348501'
            ) {
                await migrationSource.undoLastMigration();
            }
            await expect(migrationSource.undoLastMigration()).rejects.toThrow(
                'CARD-012 rollback refused',
            );
            expect(
                await db.query(
                    'SELECT * FROM financial_commitments WHERE id=$1',
                    [income.commitment.id],
                ),
            ).toEqual(before);
            expect(
                (
                    await db.query(
                        'SELECT name FROM migrations ORDER BY id DESC LIMIT 1',
                    )
                )[0].name,
            ).toBe('RecordIncomeAndReceipt1792022348501');
        } finally {
            await migrationSource.runMigrations();
            await migrationSource.destroy();
        }
    });
});
