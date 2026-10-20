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

describe('HTTP manual settlement transfer', () => {
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
                now: () => new Date('2026-10-10T15:00:00Z'),
                today: () => '2026-10-10',
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
            .csrfToken as string;
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
            .csrfToken as string;
        const post = (url: string, body: object, key = randomUUID()) =>
            agent
                .post(url)
                .set('Origin', 'http://localhost:3000')
                .set('X-CSRF-Token', token)
                .set('Idempotency-Key', key)
                .send(body);
        return { agent, context, post };
    }
    async function fixture() {
        const a = await browser('Pessoa A'),
            b = await browser('Pessoa B');
        const created = (
            await a.post('/v2/spaces', { name: 'Casa' }).expect(201)
        ).body;
        const space = created.space.id as string;
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
        const mb = context.members.find(
            (m: { personId: string }) => m.personId === b.context.person.id,
        ).memberId as string;
        const expense = (
            await a
                .post(`/v2/spaces/${space}/shared-cash-expenses`, {
                    expectedSpaceVersion: context.version,
                    description: 'Mercado',
                    amountInCents: 20000,
                    factDate: '2026-10-01',
                    responsibilitySplit: {
                        mode: 'AMOUNTS',
                        shares: [
                            { memberId: ma, amountInCents: 20000 },
                            { memberId: mb, amountInCents: 0 },
                        ],
                    },
                    disbursement: { payerMemberId: mb, method: 'PIX' },
                    settlement: { mode: 'DATE', targetDate: '2026-10-31' },
                })
                .expect(201)
        ).body;
        return { a, b, space, ma, mb, expense, version: context.version };
    }
    it('serves options, validates exact distribution, records once and exposes current history', async () => {
        const f = await fixture(),
            base = `/v2/spaces/${f.space}/settlement-transfers`;
        const options = (await f.a.agent.get(base + '/options').expect(200))
            .body;
        expect(options).toMatchObject({
            spaceVersion: f.version,
            canRecord: true,
            page: { direction: 'PAYABLE' },
            items: [
                {
                    id: f.expense.obligation.id,
                    status: 'OPEN',
                    remainingAmountInCents: 20000,
                },
            ],
        });
        const input = {
            expectedSpaceVersion: f.version,
            payerMemberId: f.ma,
            recipientMemberId: f.mb,
            amountInCents: 7000,
            factDate: '2026-10-05',
            allocations: [
                {
                    obligationId: f.expense.obligation.id,
                    expectedObligationVersion: 1,
                    amountInCents: 7000,
                },
            ],
        };
        await f.b.post(base, { ...input, amountInCents: 6999 }).expect(400);
        const key = randomUUID();
        const first = (await f.b.post(base, input, key).expect(201)).body;
        expect(first).toMatchObject({
            replayed: false,
            transfer: {
                amountInCents: 7000,
                createdByPersonId: f.b.context.person.id,
                mode: 'MANUAL',
            },
            allocations: [
                { obligationId: f.expense.obligation.id, amountInCents: 7000 },
            ],
        });
        expect(
            (await f.b.post(base, input, key).expect(200)).body.transfer.id,
        ).toBe(first.transfer.id);
        await f.b
            .post(
                base,
                {
                    ...input,
                    amountInCents: 7001,
                    allocations: [
                        { ...input.allocations[0], amountInCents: 7001 },
                    ],
                },
                key,
            )
            .expect(409);
        expect(
            (await f.a.agent.get(`${base}/${first.transfer.id}`).expect(200))
                .body.allocations,
        ).toHaveLength(1);
        expect(
            (
                await f.a.agent
                    .get(base + '?obligationId=' + f.expense.obligation.id)
                    .expect(200)
            ).body.items,
        ).toHaveLength(1);
        expect(
            (await f.a.agent.get(base + '/options').expect(200)).body.items[0],
        ).toMatchObject({
            status: 'PARTIALLY_SETTLED',
            remainingAmountInCents: 13000,
            version: 2,
        });
        expect(
            (
                await f.a.agent
                    .get(
                        `/v2/spaces/${f.space}/financial-commitments/${f.expense.commitment.id}`,
                    )
                    .expect(200)
            ).body.obligation,
        ).toMatchObject({
            status: 'PARTIALLY_SETTLED',
            remainingAmountInCents: 13000,
        });
    });
});
