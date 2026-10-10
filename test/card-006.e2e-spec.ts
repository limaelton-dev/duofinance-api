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
import {
    FINANCES_CLOCK,
    FINANCIAL_COMMITMENT_REPOSITORY,
    type FinancialCommitmentRepository,
} from '../dist/modules/finances/application/ports/private/shared-expense.repositories.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../dist/modules/spaces/application/ports/public/space-financial-context.port.js';
import { SpacesDomainError } from '../dist/modules/spaces/domain/errors/spaces-domain.error.js';
describe('CARD-006 HTTP contract and financial traceability', () => {
    let app: INestApplication<Server>,
        db: DataSource,
        today = '2026-10-10';
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
                now: () => new Date('2026-10-10T15:00:00Z'),
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
        const agent = request.agent(app.getHttpServer());
        const csrf = (await agent.get('/v2/auth/csrf').expect(200)).body
            .csrfToken;
        const context = (
            await agent
                .post('/v2/auth/register')
                .set('Origin', 'http://localhost:3000')
                .set('X-CSRF-Token', csrf)
                .send({
                    displayName: 'Pessoa ' + name,
                    email: randomUUID() + '@example.com',
                    password: 'uma-senha-de-teste',
                })
                .expect(201)
        ).body;
        const token = (await agent.get('/v2/auth/csrf').expect(200)).body
            .csrfToken;
        const headers = {
            Origin: 'http://localhost:3000',
            'X-CSRF-Token': token,
        };
        return {
            agent,
            context,
            headers,
            post: (url: string, body: unknown, key: string = randomUUID()) =>
                agent
                    .post(url)
                    .set(headers)
                    .set('Idempotency-Key', key)
                    .send(body as object),
            put: (url: string, body: unknown, key: string = randomUUID()) =>
                agent
                    .put(url)
                    .set(headers)
                    .set('Idempotency-Key', key)
                    .send(body as object),
        };
    }
    async function shared(two = true) {
        const a = await browser('A'),
            b = two ? await browser('B') : null;
        const created = (
            await a.post('/v2/spaces', { name: 'Casa' }).expect(201)
        ).body;
        const space = created.space.id as string;
        if (b) {
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
        }
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
    const postPath = (space: string) =>
            `/v2/spaces/${space}/shared-cash-expenses`,
        optionsPath = (space: string) =>
            `/v2/spaces/${space}/shared-cash-expense-options`;
    const body = (f: Awaited<ReturnType<typeof shared>>) => ({
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
        expectedPayerMemberId: f.ma,
        disbursement: { payerMemberId: f.mb, method: 'DEBIT' },
        settlement: { mode: 'NONE' },
    });
    const counts = async () =>
        (
            await db.query(
                `SELECT (SELECT count(*) FROM financial_commitments)::int AS commitments,(SELECT count(*) FROM inter_member_obligations)::int AS obligations,(SELECT count(*) FROM settlement_cycles)::int AS cycles,(SELECT count(*) FROM default_settlement_rules)::int AS rules`,
            )
        )[0];
    it('records Mercado, returns Location and refreshes the original financial entry', async () => {
        const f = await shared();
        const response = await f.a.post(postPath(f.space), body(f)).expect(201);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['access-control-expose-headers']).toContain(
            'Location',
        );
        expect(response.headers.location).toContain(
            response.body.commitment.id,
        );
        expect(response.body.obligation).toMatchObject({
            debtorMemberId: f.ma,
            creditorMemberId: f.mb,
            originalAmountInCents: 20000,
            remainingAmountInCents: 20000,
            status: 'OPEN',
            cycleId: null,
        });
        expect(response.body.commitment).toMatchObject({
            createdByPersonId: f.a.context.person.id,
            expectedPayerMemberId: f.ma,
            amountInCents: 50000,
            settlementRuleSnapshot: null,
            settlementRuleSourceVersion: 0,
        });
        const detail = await f
            .b!.agent.get(response.headers.location)
            .expect(200);
        expect(detail.body).not.toHaveProperty('replayed');
        expect(detail.body.disbursement.id).toBe(response.body.disbursement.id);
        expect(
            detail.body.members
                .map((m: { displayName: string }) => m.displayName)
                .sort(),
        ).toEqual(['Pessoa A', 'Pessoa B']);
        expect(await counts()).toEqual({
            commitments: 1,
            obligations: 1,
            cycles: 0,
            rules: 0,
        });
    });
    it('keeps planned payer independent and reverses debt when A pays', async () => {
        const f = await shared();
        const input = body(f);
        const r = (
            await f
                .b!.post(postPath(f.space), {
                    ...input,
                    disbursement: { payerMemberId: f.ma, method: 'PIX' },
                })
                .expect(201)
        ).body;
        expect(r.commitment.createdByPersonId).toBe(f.b!.context.person.id);
        expect(r.commitment.expectedPayerMemberId).toBe(f.ma);
        expect(r.obligation).toMatchObject({
            debtorMemberId: f.mb,
            creditorMemberId: f.ma,
            originalAmountInCents: 30000,
        });
    });
    it('supports sole creator and zero responsibility without fictitious debt or cycle', async () => {
        const f = await shared(false);
        const r = (await f.a.post(postPath(f.space), body(f)).expect(201)).body;
        expect(r.obligation).toBeNull();
        expect(r.settlementCycle).toBeNull();
        const options = await f.a.agent.get(optionsPath(f.space)).expect(200);
        expect(options.body.defaultSettlementRule).toEqual({
            rule: null,
            version: 0,
        });
        expect(options.body.suggestedTargetDate).toBeNull();
        expect(await counts()).toEqual({
            commitments: 1,
            obligations: 0,
            cycles: 0,
            rules: 0,
        });
    });
    it('allows full responsibility paid by the other member and rejects contradictory zero-debt cycle', async () => {
        const f = await shared();
        const input = {
            ...body(f),
            responsibilitySplit: {
                mode: 'AMOUNTS',
                shares: [
                    { memberId: f.ma, amountInCents: 50000 },
                    { memberId: f.mb, amountInCents: 0 },
                ],
            },
        };
        const r = (await f.a.post(postPath(f.space), input).expect(201)).body;
        expect(r.obligation.originalAmountInCents).toBe(50000);
        await f.a
            .post(postPath(f.space), {
                ...input,
                disbursement: { payerMemberId: f.ma, method: 'CASH' },
                settlement: { mode: 'DATE', targetDate: '2026-10-31' },
            })
            .expect(400);
        expect((await counts()).cycles).toBe(0);
    });
    it('replays same key/order/uppercase IDs and rejects changed payload; actor namespaces remain independent', async () => {
        const f = await shared();
        const input = body(f),
            key = randomUUID();
        const first = (
            await f.a.post(postPath(f.space), input, key).expect(201)
        ).body;
        const replay = (
            await f.a
                .post(
                    postPath(f.space),
                    {
                        ...input,
                        responsibilitySplit: {
                            ...input.responsibilitySplit,
                            shares: [...input.responsibilitySplit.shares]
                                .reverse()
                                .map((s) => ({
                                    ...s,
                                    memberId: s.memberId.toUpperCase(),
                                })),
                        },
                    },
                    key,
                )
                .expect(201)
        ).body;
        expect(replay).toEqual({ ...first, replayed: true });
        await f.a
            .post(postPath(f.space), { ...input, description: 'Changed' }, key)
            .expect(409)
            .expect((r) => expect(r.body.code).toBe('IDEMPOTENCY_KEY_REUSED'));
        const other = (
            await f.b!.post(postPath(f.space), input, key).expect(201)
        ).body;
        expect(other.commitment.id).not.toBe(first.commitment.id);
        expect((await counts()).commitments).toBe(2);
    });
    it('rejects reused key against another accessible space without inheriting the old result', async () => {
        const f = await shared(false),
            key = randomUUID();
        await f.a.post(postPath(f.space), body(f), key).expect(201);
        const second = (
            await f.a.post('/v2/spaces', { name: 'Other' }).expect(201)
        ).body;
        const ctx = (
            await f.a.agent
                .get(`/v2/spaces/${second.space.id}/financial-entry-context`)
                .expect(200)
        ).body;
        const member = ctx.members[0].memberId;
        await f.a
            .post(
                postPath(second.space.id),
                {
                    ...body(f),
                    expectedSpaceVersion: ctx.version,
                    responsibilitySplit: {
                        mode: 'AMOUNTS',
                        shares: [{ memberId: member, amountInCents: 50000 }],
                    },
                    expectedPayerMemberId: member,
                    disbursement: { payerMemberId: member, method: 'CASH' },
                },
                key,
            )
            .expect(409)
            .expect((r) => expect(r.body.code).toBe('IDEMPOTENCY_KEY_REUSED'));
    });
    it('preserves rule snapshot and receipt after current rule changes', async () => {
        const f = await shared();
        await f.a
            .put(`/v2/spaces/${f.space}/default-settlement-rule`, {
                expectedVersion: 0,
                rule: { kind: 'MONTHLY_DAY', dayOfMonth: 31 },
            })
            .expect(200);
        const options = (await f.a.agent.get(optionsPath(f.space)).expect(200))
            .body;
        expect(options.referenceDate).toBe('2026-10-10');
        expect(options.suggestedTargetDate).toBe('2026-10-31');
        const input = {
                ...body(f),
                settlement: {
                    mode: 'SUGGESTED',
                    referenceDate: options.referenceDate,
                    expectedRuleVersion: options.defaultSettlementRule.version,
                },
            },
            key = randomUUID();
        const first = (
            await f.a.post(postPath(f.space), input, key).expect(201)
        ).body;
        await f.a
            .put(`/v2/spaces/${f.space}/default-settlement-rule`, {
                expectedVersion: 1,
                rule: { kind: 'MONTHLY_DAY', dayOfMonth: 10 },
            })
            .expect(200);
        expect(
            (await f.a.post(postPath(f.space), input, key).expect(201)).body,
        ).toEqual({ ...first, replayed: true });
        const detail = (
            await f.a.agent
                .get(
                    `/v2/spaces/${f.space}/financial-commitments/${first.commitment.id}`,
                )
                .expect(200)
        ).body;
        expect(detail.commitment.settlementRuleSnapshot).toEqual({
            kind: 'MONTHLY_DAY',
            dayOfMonth: 31,
        });
        expect(detail.settlementCycle.targetDate).toBe('2026-10-31');
        await f.a
            .post(postPath(f.space), input)
            .expect(409)
            .expect((r) => expect(r.body.code).toBe('EXPENSE_OPTIONS_CHANGED'));
    });
    it('rejects suggestion after business-day rollover and permits manual selection without a default', async () => {
        const f = await shared();
        await f.a
            .put(`/v2/spaces/${f.space}/default-settlement-rule`, {
                expectedVersion: 0,
                rule: { kind: 'MONTHLY_DAY', dayOfMonth: 10 },
            })
            .expect(200);
        const options = (await f.a.agent.get(optionsPath(f.space)).expect(200))
            .body;
        today = '2026-10-11';
        await f.a
            .post(postPath(f.space), {
                ...body(f),
                settlement: {
                    mode: 'SUGGESTED',
                    referenceDate: options.referenceDate,
                    expectedRuleVersion: 1,
                },
            })
            .expect(409);
        await f.a
            .post(postPath(f.space), {
                ...body(f),
                settlement: { mode: 'DATE', targetDate: '2026-10-20' },
            })
            .expect(201);
    });
    it('selects overdue OPEN and refuses FINALIZED, foreign or missing cycles uniformly', async () => {
        const f = await shared();
        const open = randomUUID(),
            closed = randomUUID();
        await db.query(
            `INSERT INTO settlement_cycles(id,space_id,target_date,status,version,finalized_at) VALUES($1,$3,'2026-09-01','OPEN',1,NULL),($2,$3,'2026-10-31','FINALIZED',1,now())`,
            [open, closed, f.space],
        );
        const first = (
            await f.a
                .post(postPath(f.space), {
                    ...body(f),
                    settlement: { mode: 'CYCLE', cycleId: open },
                })
                .expect(201)
        ).body;
        expect(first.settlementCycle.targetDate).toBe('2026-09-01');
        await f.a
            .post(postPath(f.space), {
                ...body(f),
                settlement: { mode: 'CYCLE', cycleId: closed },
            })
            .expect(409)
            .expect((r) =>
                expect(r.body.code).toBe('SETTLEMENT_CYCLE_FINALIZED'),
            );
        await f.a
            .post(postPath(f.space), {
                ...body(f),
                settlement: { mode: 'DATE', targetDate: '2026-10-31' },
            })
            .expect(409);
        await f.a
            .post(postPath(f.space), {
                ...body(f),
                settlement: { mode: 'CYCLE', cycleId: randomUUID() },
            })
            .expect(404)
            .expect((r) =>
                expect(r.body.code).toBe('SETTLEMENT_CYCLE_NOT_FOUND'),
            );
        await db.query(
            `UPDATE settlement_cycles SET status='FINALIZED',finalized_at=now(),version=2 WHERE id=$1`,
            [open],
        );
        const detail = (
            await f.a.agent
                .get(
                    `/v2/spaces/${f.space}/financial-commitments/${first.commitment.id}`,
                )
                .expect(200)
        ).body;
        expect(detail.settlementCycle.status).toBe('FINALIZED');
    });
    it('paginates only OPEN cycles by date/id with a space-bound cursor without writes', async () => {
        const f = await shared(false);
        for (let index = 1; index <= 22; index++)
            await db.query(
                `INSERT INTO settlement_cycles(id,space_id,target_date,status,version) VALUES($1,$2,$3,'OPEN',1)`,
                [
                    randomUUID(),
                    f.space,
                    `2026-11-${String(index).padStart(2, '0')}`,
                ],
            );
        const first = (await f.a.agent.get(optionsPath(f.space)).expect(200))
            .body;
        expect(first.openCycles).toHaveLength(20);
        expect(first.nextCursor).toBeTypeOf('string');
        const second = (
            await f.a.agent
                .get(optionsPath(f.space) + '?cursor=' + first.nextCursor)
                .expect(200)
        ).body;
        expect(second.openCycles).toHaveLength(2);
        expect(second.nextCursor).toBeNull();
        expect(
            [...first.openCycles, ...second.openCycles].map(
                (c: { targetDate: string }) => c.targetDate,
            ),
        ).toEqual(
            Array.from(
                { length: 22 },
                (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`,
            ),
        );
        await f.a.agent
            .get(optionsPath(f.space) + '?cursor=broken')
            .expect(400)
            .expect((r) =>
                expect(r.body.details.fields[0].field).toBe('cursor'),
            );
        expect((await counts()).commitments).toBe(0);
        expect((await counts()).rules).toBe(0);
        const another = (
            await f.a.post('/v2/spaces', { name: 'Other' }).expect(201)
        ).body.space.id;
        await f.a.agent
            .get(optionsPath(another) + '?cursor=' + first.nextCursor)
            .expect(400)
            .expect((r) =>
                expect(r.body.details.fields[0].field).toBe('cursor'),
            );
        await f.a.agent.get(optionsPath(f.space) + '?unknown=1').expect(400);
    });
    it('rejects personal/third-party/nonexistent/revoked access before exposing financial IDs or receipts', async () => {
        const f = await shared(),
            c = await browser('C'),
            key = randomUUID();
        const first = (
            await f.a.post(postPath(f.space), body(f), key).expect(201)
        ).body;
        for (const id of [f.space, randomUUID()]) {
            await c.agent
                .get(optionsPath(id))
                .expect(404)
                .expect((r) => expect(r.body.code).toBe('SPACE_NOT_FOUND'));
            await c.post(postPath(id), body(f), key).expect(404);
        }
        await f.a.agent
            .get(optionsPath(f.a.context.personalSpace.id))
            .expect(409)
            .expect((r) => expect(r.body.code).toBe('SHARED_SPACE_REQUIRED'));
        await c.agent
            .get(
                `/v2/spaces/${f.space}/financial-commitments/${first.commitment.id}`,
            )
            .expect(404);
        const access = app.get<SpaceFinancialContextPort>(
                SPACE_FINANCIAL_CONTEXT_PORT,
            ),
            read = access.read.bind(access);
        vi.spyOn(access, 'read').mockImplementation((actor, space) => {
            if (actor.value === f.a.context.person.id)
                throw new SpacesDomainError('SPACE_NOT_FOUND');
            return read(actor, space);
        });
        await f.a
            .post(postPath(f.space), body(f), key)
            .expect(404)
            .expect((r) => expect(r.body.code).toBe('SPACE_NOT_FOUND'));
        await f.a.agent.get(optionsPath(f.space)).expect(404);
        await f.a.agent
            .get(`/v2/spaces/${f.space}/financial-entry-context`)
            .expect(404);
        await f.a.agent
            .get(
                `/v2/spaces/${f.space}/financial-commitments/${first.commitment.id}`,
            )
            .expect(404);
        expect((await counts()).commitments).toBe(1);
        await f
            .b!.agent.get(
                `/v2/spaces/${f.space}/financial-commitments/${first.commitment.id}`,
            )
            .expect(200);
    });
    it('keeps authorized CLOSED reads and historical replay but refuses new facts', async () => {
        const f = await shared(),
            key = randomUUID(),
            input = body(f);
        await f.a.post(postPath(f.space), input, key).expect(201);
        await db.query(`UPDATE spaces SET status='CLOSED' WHERE id=$1`, [
            f.space,
        ]);
        expect(
            (await f.a.agent.get(optionsPath(f.space)).expect(200)).body.status,
        ).toBe('CLOSED');
        await f.a
            .post(postPath(f.space), input, key)
            .expect(201)
            .expect((r) => expect(r.body.replayed).toBe(true));
        await f.a
            .post(postPath(f.space), input)
            .expect(409)
            .expect((r) => expect(r.body.code).toBe('SPACE_NOT_ACTIVE'));
    });
    it.each([
        ['description', { description: ' '.repeat(2) }],
        ['amountInCents', { amountInCents: 0 }],
        ['amountInCents', { amountInCents: Number.MAX_SAFE_INTEGER + 1 }],
        ['amountInCents', { amountInCents: '50000' }],
        ['amountInCents', { amountInCents: 1.2 }],
        ['factDate', { factDate: '2026-02-30' }],
        ['factDate', { factDate: '2026-10-11' }],
        ['actorId', { actorId: randomUUID() }],
        ['registeredAt', { registeredAt: '2026-10-10T15:00:00Z' }],
        [
            'disbursement.paidAmount',
            {
                disbursement: {
                    payerMemberId: randomUUID(),
                    method: 'PIX',
                    paidAmount: 50000,
                },
            },
        ],
        [
            'disbursement.method',
            {
                disbursement: {
                    payerMemberId: randomUUID(),
                    method: 'CREDIT_CARD',
                },
            },
        ],
        [
            'settlement.targetDate',
            { settlement: { mode: 'NONE', targetDate: '2026-10-31' } },
        ],
        [
            'settlement.targetDate',
            { settlement: { mode: 'DATE', targetDate: '2026-10-09' } },
        ],
    ])(
        'validates closed input at field %s without writes',
        async (field, change) => {
            const f = await shared();
            const r = await f.a
                .post(postPath(f.space), { ...body(f), ...change })
                .expect(400);
            expect(r.body.code).toBe('VALIDATION_ERROR');
            expect(
                r.body.details.fields.some(
                    (entry: { field: string }) => entry.field === field,
                ),
            ).toBe(true);
            expect((await counts()).commitments).toBe(0);
        },
    );
    it('rejects incomplete/duplicate/foreign responsibility and foreign planned/actual payer', async () => {
        const f = await shared();
        const input = body(f);
        for (const bad of [
            {
                ...input,
                responsibilitySplit: {
                    mode: 'AMOUNTS',
                    shares: [{ memberId: f.ma, amountInCents: 50000 }],
                },
            },
            {
                ...input,
                responsibilitySplit: {
                    mode: 'PERCENTAGES',
                    shares: [
                        { memberId: f.ma, basisPoints: 5000 },
                        { memberId: f.ma, basisPoints: 5000 },
                    ],
                },
            },
            {
                ...input,
                responsibilitySplit: {
                    mode: 'PERCENTAGES',
                    shares: [
                        { memberId: f.ma, basisPoints: 3000 },
                        { memberId: f.mb, basisPoints: 6000 },
                    ],
                },
            },
            { ...input, expectedPayerMemberId: randomUUID() },
            {
                ...input,
                disbursement: { payerMemberId: randomUUID(), method: 'PIX' },
            },
        ])
            await f.a.post(postPath(f.space), bad).expect(400);
        expect((await counts()).commitments).toBe(0);
    });
    it('requires session, CSRF and UUID key and keeps internal errors free of SQL', async () => {
        const f = await shared();
        await request(app.getHttpServer())
            .get(optionsPath(f.space))
            .expect(401);
        await f.a.agent
            .post(postPath(f.space))
            .set('Origin', 'http://localhost:3000')
            .set('Idempotency-Key', randomUUID())
            .send(body(f))
            .expect(403);
        await f.a.agent
            .post(postPath(f.space))
            .set(f.a.headers)
            .send(body(f))
            .expect(400);
        await f.a.post(postPath(f.space), body(f), 'bad-key').expect(400);
        const repository = app.get<FinancialCommitmentRepository>(
            FINANCIAL_COMMITMENT_REPOSITORY,
        );
        vi.spyOn(repository, 'save').mockRejectedValue(
            new Error('SQL private detail'),
        );
        const r = await f.a.post(postPath(f.space), body(f)).expect(500);
        expect(r.body.code).toBe('INTERNAL_ERROR');
        expect(JSON.stringify(r.body)).not.toContain('SQL');
        expect((await counts()).commitments).toBe(0);
    });
    it('documents closed oneOf schemas, original split, null/replay/Location and previous CARD005 routes', async () => {
        const r = await request(app.getHttpServer())
            .get('/v2/openapi.json')
            .expect(200);
        const doc = r.body;
        expect(
            doc.paths['/v2/spaces/{spaceId}/shared-cash-expenses'].post
                .responses['201'].headers.Location,
        ).toBeDefined();
        expect(
            doc.components.schemas.ExpenseSettlementSelection.oneOf,
        ).toHaveLength(4);
        expect(doc.components.schemas.ResponsibilitySplit.oneOf).toHaveLength(
            2,
        );
        expect(
            doc.components.schemas.RecordSharedCashExpenseRequest
                .additionalProperties,
        ).toBe(false);
        expect(
            doc.components.schemas.FinancialCommitmentDetail.properties,
        ).not.toHaveProperty('replayed');
        expect(
            doc.paths['/v2/spaces/{spaceId}/default-settlement-rule'].put,
        ).toBeDefined();
        expect(
            doc.paths['/v2/spaces/{spaceId}/financial-entry-context'].get.tags,
        ).toEqual(['Spaces']);
    });
});
