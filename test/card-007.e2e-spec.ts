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
describe('CARD-007 HTTP authorized position and origin', () => {
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
            b = two ? await browser('Pessoa B') : null;
        const created = (
                await a.post('/v2/spaces', { name: 'Casa' }).expect(201)
            ).body,
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
        ).memberId as string;
        const mb = b
            ? (context.members.find(
                  (m: { personId: string }) =>
                      m.personId === b.context.person.id,
              ).memberId as string)
            : ma;
        return { a, b, space, context, ma, mb };
    }
    const path = (space: string) => `/v2/spaces/${space}/inter-member-position`;
    function expense(f: Awaited<ReturnType<typeof shared>>, payer = f.mb) {
        return {
            expectedSpaceVersion: f.context.version,
            description: 'Mercado',
            amountInCents: 50000,
            factDate: '2026-10-09',
            responsibilitySplit: {
                mode: 'PERCENTAGES',
                shares: f.b
                    ? [
                          { memberId: f.ma, basisPoints: 4000 },
                          { memberId: f.mb, basisPoints: 6000 },
                      ]
                    : [{ memberId: f.ma, basisPoints: 10000 }],
            },
            disbursement: { payerMemberId: payer, method: 'DEBIT' },
            settlement: { mode: 'NONE' },
        };
    }
    it.each([false, true])(
        'Market B payer with planned payer present=%s remains 20000 payable and preserves origin',
        async (planned) => {
            const f = await shared(),
                input = expense(f),
                body = planned
                    ? { ...input, expectedPayerMemberId: f.ma }
                    : input;
            const recorded = (
                await f.a
                    .post(`/v2/spaces/${f.space}/shared-cash-expenses`, body)
                    .expect(201)
            ).body;
            const result = await f.a.agent.get(path(f.space)).expect(200);
            expect(result.headers['cache-control']).toBe('no-store');
            expect(result.body.summary).toEqual({
                payableAmountInCents: '20000',
                receivableAmountInCents: '0',
                net: { direction: 'PAYABLE', amountInCents: '20000' },
            });
            expect(result.body.items[0]).toMatchObject({
                id: recorded.obligation.id,
                version: 1,
                status: 'OPEN',
                remainingAmountInCents: 20000,
                factDate: '2026-10-09',
                registeredAt: '2026-10-10T15:00:00.000000Z',
                origin: {
                    commitmentId: recorded.commitment.id,
                    disbursementId: recorded.disbursement.id,
                    description: 'Mercado',
                },
                settlementCycle: null,
            });
            const detailPath = `/v2/spaces/${f.space}/financial-commitments/${result.body.items[0].origin.commitmentId}`;
            const detail = (await f.a.agent.get(detailPath).expect(200)).body;
            expect(detail.commitment.expectedPayerMemberId).toBe(
                planned ? f.ma : null,
            );
            expect(
                detail.commitment.responsibilitySplit.calculatedShares,
            ).toEqual(recorded.commitment.responsibilitySplit.calculatedShares);
            expect((await f.a.agent.get(detailPath).expect(200)).body).toEqual(
                detail,
            );
            expect(
                (await f.a.agent.get(path(f.space)).expect(200)).body,
            ).toEqual(result.body);
        },
    );
    it('Market A payer yields 30000 receivable and B perspective reverses', async () => {
        const f = await shared();
        await f.a
            .post(
                `/v2/spaces/${f.space}/shared-cash-expenses`,
                expense(f, f.ma),
            )
            .expect(201);
        const a = (await f.a.agent.get(path(f.space)).expect(200)).body,
            b = (await f.b!.agent.get(path(f.space)).expect(200)).body;
        expect(a.summary).toEqual({
            payableAmountInCents: '0',
            receivableAmountInCents: '30000',
            net: { direction: 'RECEIVABLE', amountInCents: '30000' },
        });
        expect(b.summary).toEqual({
            payableAmountInCents: '30000',
            receivableAmountInCents: '0',
            net: { direction: 'PAYABLE', amountInCents: '30000' },
        });
        expect(b.items).toEqual(a.items);
    });
    it('shared creator alone is empty without fabricating a partner or debt', async () => {
        const f = await shared(false);
        await f.a
            .post(`/v2/spaces/${f.space}/shared-cash-expenses`, expense(f))
            .expect(201);
        const result = (await f.a.agent.get(path(f.space)).expect(200)).body;
        expect(result.members).toHaveLength(1);
        expect(result.items).toEqual([]);
        expect(result.summary).toEqual({
            payableAmountInCents: '0',
            receivableAmountInCents: '0',
            net: { direction: 'BALANCED', amountInCents: '0' },
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
        'cycleId=' + randomUUID(),
        'direction[]=ALL',
    ])('rejects invalid query %s', async (query) => {
        const f = await shared(false);
        const response = await f.a.agent
            .get(path(f.space) + '?' + query)
            .expect(400);
        expect(response.body).toMatchObject({
            code: 'VALIDATION_ERROR',
            details: { fields: expect.any(Array) },
        });
        expect(typeof response.body.message).toBe('string');
    });
    it('rejects invalid UUID with structured validation', async () => {
        const a = await browser('Pessoa A');
        const response = await a.agent.get(path('invalid')).expect(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
    });
    it('requires session without CSRF command headers for valid reads', async () => {
        await request(app.getHttpServer()).get(path(randomUUID())).expect(401);
        const f = await shared(false);
        await f.a.agent.get(path(f.space)).expect(200);
    });
    it('does not expose absent or outside shared space and rejects personal space', async () => {
        const f = await shared(false),
            outside = await browser('Pessoa externa');
        expect(
            (await outside.agent.get(path(f.space)).expect(404)).body.code,
        ).toBe('SPACE_NOT_FOUND');
        expect(
            (await f.a.agent.get(path(randomUUID())).expect(404)).body.code,
        ).toBe('SPACE_NOT_FOUND');
        const [personal] = await db.query(
            `SELECT id FROM spaces WHERE type='PERSONAL' AND personal_owner_person_id=$1`,
            [f.a.context.person.id],
        );
        expect(
            (await f.a.agent.get(path(personal.id)).expect(409)).body.code,
        ).toBe('SHARED_SPACE_REQUIRED');
    });
    it('does not expose source in another context or absent source', async () => {
        const f = await shared(),
            recorded = (
                await f.a
                    .post(
                        `/v2/spaces/${f.space}/shared-cash-expenses`,
                        expense(f),
                    )
                    .expect(201)
            ).body;
        const other = (
            await f.a.post('/v2/spaces', { name: 'Outra casa' }).expect(201)
        ).body.space.id;
        for (const [space, id] of [
            [other, recorded.commitment.id],
            [f.space, randomUUID()],
        ])
            expect(
                (
                    await f.a.agent
                        .get(`/v2/spaces/${space}/financial-commitments/${id}`)
                        .expect(404)
                ).body.code,
            ).toBe('FINANCIAL_COMMITMENT_NOT_FOUND');
    });
    it.each(['CLOSING', 'CLOSED'])(
        'reads accessible %s fixture',
        async (status) => {
            const f = await shared(false);
            await db.query('UPDATE spaces SET status=$2 WHERE id=$1', [
                f.space,
                status,
            ]);
            expect(
                (await f.a.agent.get(path(f.space)).expect(200)).body
                    .spaceStatus,
            ).toBe(status);
        },
    );
    it('suppresses financial response after simulated access loss', async () => {
        const f = await shared(false),
            access = app.get<SpaceFinancialContextPort>(
                SPACE_FINANCIAL_CONTEXT_PORT,
            ),
            original = access.read.bind(access);
        vi.spyOn(access, 'read')
            .mockImplementationOnce(original)
            .mockRejectedValueOnce(new SpacesDomainError('SPACE_NOT_FOUND'));
        expect((await f.a.agent.get(path(f.space)).expect(404)).body.code).toBe(
            'SPACE_NOT_FOUND',
        );
    });
    it('rejects canonical cursor from another actor, space or direction and preserves global totals on exhausted page', async () => {
        const f = await shared();
        await f.a
            .post(`/v2/spaces/${f.space}/shared-cash-expenses`, expense(f))
            .expect(201);
        const first = (await f.a.agent.get(path(f.space)).expect(200)).body;
        const cursor = encodePositionCursor(
            f.space,
            f.a.context.person.id,
            'ALL',
            first.items[0],
        );
        const exhausted = (
            await f.a.agent.get(path(f.space) + '?cursor=' + cursor).expect(200)
        ).body;
        expect(exhausted.items).toEqual([]);
        expect(exhausted.summary).toEqual(first.summary);
        const requests = [
            () => f.b!.agent.get(path(f.space) + '?cursor=' + cursor),
            () =>
                f.a.agent.get(
                    path(f.space) + '?direction=PAYABLE&cursor=' + cursor,
                ),
            () =>
                f.a.agent.get(
                    path(f.space) +
                        '?cursor=' +
                        encodePositionCursor(
                            randomUUID(),
                            f.a.context.person.id,
                            'ALL',
                            first.items[0],
                        ),
                ),
        ];
        for (const nextRequest of requests)
            expect((await nextRequest().expect(400)).body).toMatchObject({
                code: 'VALIDATION_ERROR',
                details: {
                    fields: [{ field: 'cursor', messages: expect.any(Array) }],
                },
            });
    });
    it('publishes executable OpenAPI matching string totals and fixed page', async () => {
        const doc = (
            await request(app.getHttpServer())
                .get('/v2/openapi.json')
                .expect(200)
        ).body;
        const operation =
            doc.paths['/v2/spaces/{spaceId}/inter-member-position'].get;
        expect(operation.operationId).toBe('getInterMemberPosition');
        expect(
            operation.parameters.map((p: { name: string }) => p.name),
        ).toEqual(['spaceId', 'direction', 'cursor']);
        expect(operation.parameters[2].schema.maxLength).toBe(512);
        expect(
            operation.responses['200'].headers['Cache-Control'],
        ).toBeDefined();
        const schema = doc.components.schemas.InterMemberPositionResponse;
        expect(schema.additionalProperties).toBe(false);
        expect(
            schema.properties.summary.properties.payableAmountInCents.type,
        ).toBe('string');
        expect(schema.properties.items.maxItems).toBe(20);
        expect(schema.properties.page.properties.pageSize.enum).toEqual([20]);
        expect(schema.properties).not.toHaveProperty('replayed');
        expect(
            doc.components.schemas.OpenInterMemberObligation.properties.origin
                .$ref,
        ).toBe('#/components/schemas/InterMemberObligationOrigin');
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
    });
});
