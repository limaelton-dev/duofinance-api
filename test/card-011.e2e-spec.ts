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
import { createApiOpenApiDocument } from '../dist/composition/http/create-api-openapi-document.js';
import { PersonalExpenseController } from '../dist/modules/finances/http/controllers/personal-expense.controller.js';
import { SharedCashExpenseController } from '../dist/modules/finances/http/controllers/shared-cash-expense.controller.js';
import type { PersonalExpenseResult } from '../dist/modules/finances/application/models/personal-expense.js';
const input = () => ({
    description: ' Consulta ',
    amountInCents: 12000,
    factDate: '2026-10-14',
    disbursement: { method: 'PIX' },
});
describe('CARD-011 personal expense HTTP and PostgreSQL', () => {
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
        await app?.close();
    });
    async function browser() {
        const agent = request.agent(app.getHttpServer()),
            csrf = (await agent.get('/v2/auth/csrf').expect(200)).body
                .csrfToken;
        const registration = {
            displayName: 'Titular',
            email: randomUUID() + '@example.com',
            password: 'uma-senha-de-teste',
        };
        const context = (
            await agent
                .post('/v2/auth/register')
                .set('Origin', 'http://localhost:3000')
                .set('X-CSRF-Token', csrf)
                .send(registration)
                .expect(201)
        ).body;
        const refresh = async () => ({
            Origin: 'http://localhost:3000',
            'X-CSRF-Token': (await agent.get('/v2/auth/csrf').expect(200)).body
                .csrfToken,
        });
        let headers = await refresh();
        return {
            agent,
            context,
            refresh,
            post: (path: string, body: unknown, key: string = randomUUID()) =>
                agent
                    .post(path)
                    .set(headers)
                    .set('Idempotency-Key', key)
                    .send(body as object),
            relogin: async () => {
                await agent
                    .post('/v2/auth/logout')
                    .set(headers)
                    .send({})
                    .expect(204);
                headers = await refresh();
                await agent
                    .post('/v2/auth/login')
                    .set(headers)
                    .send({
                        email: registration.email,
                        password: registration.password,
                    })
                    .expect(200);
                headers = await refresh();
            },
        };
    }
    const path = (space: string) => `/v2/spaces/${space}/personal-expenses`;
    async function counts() {
        return (
            await db.query(
                `SELECT (SELECT count(*) FROM financial_commitments)::int AS commitments,(SELECT count(*) FROM financial_commitment_versions)::int AS versions,(SELECT count(*) FROM financial_disbursements)::int AS disbursements,(SELECT count(*) FROM financial_expense_command_receipts)::int AS receipts,(SELECT count(*) FROM financial_commitment_shares)::int AS shares,(SELECT count(*) FROM inter_member_obligations)::int AS obligations,(SELECT count(*) FROM settlement_cycles)::int AS cycles,(SELECT count(*) FROM default_settlement_rules)::int AS rules,(SELECT count(*) FROM space_members)::int AS members`,
            )
        )[0];
    }
    it.each(['PIX', 'DEBIT', 'CASH'])(
        'records one personal %s expense without shared artifacts',
        async (method) => {
            const b = await browser(),
                space = b.context.personalSpace.id;
            const r = await b
                .post(path(space), { ...input(), disbursement: { method } })
                .expect(201);
            const result = r.body as PersonalExpenseResult;
            expect(r.headers['cache-control']).toBe('no-store');
            expect(r.headers.location).toBe(
                `/v2/spaces/${space}/financial-commitments/${result.commitment.id}`,
            );
            expect(result).toMatchObject({
                spaceId: space,
                spaceType: 'PERSONAL',
                replayed: false,
                commitment: {
                    description: 'Consulta',
                    amountInCents: 12000,
                    ownerPersonId: b.context.person.id,
                    createdByPersonId: b.context.person.id,
                    factDate: '2026-10-14',
                    registeredAt: '2026-10-15T02:30:00.000Z',
                },
                disbursement: {
                    payerPersonId: b.context.person.id,
                    method,
                    amountInCents: 12000,
                    factDate: '2026-10-14',
                },
            });
            expect(result.commitment.id).not.toBe(result.disbursement.id);
            expect(await counts()).toEqual({
                commitments: 1,
                versions: 1,
                disbursements: 1,
                receipts: 1,
                shares: 0,
                obligations: 0,
                cycles: 0,
                rules: 0,
                members: 0,
            });
            for (const f of ['members', 'obligation', 'settlementCycle'])
                expect(result).not.toHaveProperty(f);
            expect(result.commitment).not.toHaveProperty('responsibilitySplit');
            expect(result.disbursement).not.toHaveProperty('payerMemberId');
            const [rows] = await db.query(
                `SELECT c.personal_owner_person_id,v.split_mode,v.split_input,v.expected_payer_member_id,v.rule_snapshot,v.rule_source_version,d.payer_member_id,d.payer_person_id FROM financial_commitments c JOIN financial_commitment_versions v ON v.commitment_id=c.id JOIN financial_disbursements d ON d.commitment_id=c.id WHERE c.id=$1`,
                [result.commitment.id],
            );
            expect(rows).toEqual({
                personal_owner_person_id: b.context.person.id,
                split_mode: null,
                split_input: null,
                expected_payer_member_id: null,
                rule_snapshot: null,
                rule_source_version: 0,
                payer_member_id: null,
                payer_person_id: b.context.person.id,
            });
        },
    );
    it('uses the São Paulo server date in options and returns an empty authorized history without writes', async () => {
        const b = await browser(),
            space = b.context.personalSpace.id,
            before = await counts();
        const options = await b.agent
            .get(`/v2/spaces/${space}/personal-expense-options`)
            .expect(200);
        expect(options.body).toEqual({
            spaceId: space,
            referenceDate: '2026-10-14',
            disbursementMethods: ['PIX', 'DEBIT', 'CASH'],
        });
        expect(options.headers['cache-control']).toBe('no-store');
        expect((await b.agent.get(path(space)).expect(200)).body).toEqual({
            spaceId: space,
            items: [],
            nextCursor: null,
        });
        expect(await counts()).toEqual(before);
    });
    it.each([1, Number.MAX_SAFE_INTEGER])(
        'preserves %s cents in storage and reads',
        async (amountInCents) => {
            const b = await browser(),
                r = await b
                    .post(path(b.context.personalSpace.id), {
                        ...input(),
                        amountInCents,
                    })
                    .expect(201);
            expect(r.body.commitment.amountInCents).toBe(amountInCents);
            const [v] = await db.query(
                'SELECT amount_in_cents::text FROM financial_commitment_versions WHERE commitment_id=$1',
                [r.body.commitment.id],
            );
            expect(v.amount_in_cents).toBe(String(amountInCents));
        },
    );
    it.each([
        { description: '' },
        { description: '  ' },
        { description: 'a'.repeat(161) },
        { amountInCents: 0 },
        { amountInCents: -1 },
        { amountInCents: 0.1 },
        { amountInCents: Number.MAX_SAFE_INTEGER + 1 },
        { amountInCents: '12000' },
        { factDate: '2026-10-15' },
        { factDate: '2026-02-30' },
        { factDate: '14/10/2026' },
        { factDate: '2026-1-01' },
        { disbursement: { method: 'CREDIT' } },
    ])('rejects invalid input %j without writes', async (patch) => {
        const b = await browser(),
            r = await b
                .post(path(b.context.personalSpace.id), {
                    ...input(),
                    ...patch,
                })
                .expect(400);
        expect(r.body.code).toBe('VALIDATION_ERROR');
        expect(r.body.details.fields.length).toBeGreaterThan(0);
        expect((await counts()).commitments).toBe(0);
    });
    it.each([
        'payerMemberId',
        'payerPersonId',
        'createdByPersonId',
        'ownerPersonId',
        'responsibilitySplit',
        'expectedPayerMemberId',
        'settlement',
        'expectedSpaceVersion',
        'registeredAt',
        'kind',
        'modality',
    ])('rejects the extra root field %s', async (field) => {
        const b = await browser(),
            r = await b
                .post(path(b.context.personalSpace.id), {
                    ...input(),
                    [field]: randomUUID(),
                })
                .expect(400);
        expect(r.body.details.fields).toContainEqual({
            field,
            messages: ['Este campo não é permitido.'],
        });
        expect((await counts()).commitments).toBe(0);
    });
    it.each(['payerMemberId', 'payerPersonId', 'factDate', 'registeredAt'])(
        'rejects extra nested disbursement.%s',
        async (field) => {
            const b = await browser(),
                r = await b
                    .post(path(b.context.personalSpace.id), {
                        ...input(),
                        disbursement: { method: 'PIX', [field]: randomUUID() },
                    })
                    .expect(400);
            expect(r.body.details.fields).toContainEqual({
                field: `disbursement.${field}`,
                messages: ['Este campo não é permitido.'],
            });
        },
    );
    it('requires session, CSRF and UUID idempotency key', async () => {
        await request(app.getHttpServer()).get(path(randomUUID())).expect(401);
        const b = await browser(),
            url = path(b.context.personalSpace.id);
        await b.agent
            .post(url)
            .set('Origin', 'http://localhost:3000')
            .set('Idempotency-Key', randomUUID())
            .send(input())
            .expect(403);
        await b.post(url, input(), 'invalid').expect(400);
        expect((await counts()).receipts).toBe(0);
    });
    it('keeps personal and shared access separate even for shared partners', async () => {
        const a = await browser(),
            b = await browser(),
            space = a.context.personalSpace.id;
        const shared = (
            await a.post('/v2/spaces', { name: 'Casa' }).expect(201)
        ).body;
        const token = new URLSearchParams(
            new URL(shared.inviteUrl).hash.slice(1),
        ).get('token');
        await b
            .post('/v2/invitations/respond', {
                token,
                decision: 'ACCEPT',
                expectedVersion: shared.space.version,
            })
            .expect(200);
        const created = await a.post(path(space), input()).expect(201);
        for (const url of [
            path(space),
            `/v2/spaces/${space}/personal-expense-options`,
            created.headers.location,
        ])
            expect((await b.agent.get(url).expect(404)).body.code).toBe(
                'SPACE_NOT_FOUND',
            );
        expect((await b.post(path(space), input()).expect(404)).body.code).toBe(
            'SPACE_NOT_FOUND',
        );
        expect(
            (await a.post(path(shared.space.id), input()).expect(409)).body
                .code,
        ).toBe('PERSONAL_SPACE_REQUIRED');
        expect(
            (await a.agent.get(path(shared.space.id)).expect(409)).body.code,
        ).toBe('PERSONAL_SPACE_REQUIRED');
        const sharedInput = {
            expectedSpaceVersion: 1,
            ...input(),
            responsibilitySplit: {
                mode: 'AMOUNTS',
                shares: [{ memberId: randomUUID(), amountInCents: 12000 }],
            },
            disbursement: { payerMemberId: randomUUID(), method: 'PIX' },
            settlement: { mode: 'NONE' },
        };
        expect(
            (
                await a
                    .post(
                        `/v2/spaces/${space}/shared-cash-expenses`,
                        sharedInput,
                    )
                    .expect(409)
            ).body.code,
        ).toBe('SHARED_SPACE_REQUIRED');
        expect(
            (
                await b.agent
                    .get(
                        `/v2/spaces/${b.context.personalSpace.id}/financial-commitments/${created.body.commitment.id}`,
                    )
                    .expect(404)
            ).body.code,
        ).toBe('FINANCIAL_COMMITMENT_NOT_FOUND');
        expect((await counts()).commitments).toBe(1);
    });
    it('replays normalized input, conflicts on altered input and isolates independent keys', async () => {
        const b = await browser(),
            url = path(b.context.personalSpace.id),
            key = randomUUID(),
            first = await b.post(url, input(), key).expect(201);
        const replay = await b
            .post(url, { ...input(), description: 'Consulta' }, key)
            .expect(200);
        expect(replay.body).toEqual({ ...first.body, replayed: true });
        expect(replay.headers.location).toBe(first.headers.location);
        const conflict = await b
            .post(url, { ...input(), amountInCents: 1 }, key)
            .expect(409);
        expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        await b.post(url, input()).expect(201);
        expect((await counts()).commitments).toBe(2);
    });
    it('lists >20 facts with equal dates deterministically, persists after a new session and never writes in reads', async () => {
        const b = await browser(),
            space = b.context.personalSpace.id,
            ids: string[] = [];
        for (let i = 0; i < 23; i++) {
            const r = await b
                .post(path(space), {
                    ...input(),
                    description: `Despesa ${i}`,
                    factDate: i === 22 ? '2026-10-13' : '2026-10-14',
                })
                .expect(201);
            ids.push(r.body.commitment.id);
        }
        const before = await counts(),
            first = (await b.agent.get(path(space)).expect(200)).body;
        expect(first.items).toHaveLength(20);
        expect(first.nextCursor).toEqual(expect.any(String));
        const next = (
            await b.agent
                .get(path(space))
                .query({ cursor: first.nextCursor })
                .expect(200)
        ).body;
        expect(next.items).toHaveLength(3);
        expect(next.nextCursor).toBeNull();
        const all = [...first.items, ...next.items];
        expect(all.map((i: { id: string }) => i.id)).toEqual([
            ...ids.slice(0, 22).sort().reverse(),
            ids[22],
        ]);
        expect(new Set(all.map((i: { id: string }) => i.id)).size).toBe(23);
        await b.relogin();
        const detail = await b.agent
            .get(`/v2/spaces/${space}/financial-commitments/${ids[0]}`)
            .expect(200);
        expect(detail.headers['cache-control']).toBe('no-store');
        expect(detail.body).not.toHaveProperty('replayed');
        expect(detail.body.spaceType).toBe('PERSONAL');
        expect((await b.agent.get(path(space)).expect(200)).body).toEqual(
            first,
        );
        expect(await counts()).toEqual(before);
    });
    it.each([
        '',
        '!',
        'a'.repeat(301),
        Buffer.from(
            JSON.stringify([randomUUID(), '2026-10-14', randomUUID()]),
        ).toString('base64url'),
        Buffer.from(
            JSON.stringify(['SPACE', '2026-02-30', randomUUID()]),
        ).toString('base64url'),
    ])('rejects invalid or cross-space cursor %s', async (cursor) => {
        const b = await browser(),
            r = await b.agent
                .get(path(b.context.personalSpace.id))
                .query({ cursor })
                .expect(400);
        expect(r.body.code).toBe('VALIDATION_ERROR');
    });
    it('describes strict executable personal contracts and both detail representations', () => {
        const doc = createApiOpenApiDocument(false),
            schemas = doc.components!.schemas!;
        const inputSchema = schemas.RecordPersonalExpenseRequest as {
            additionalProperties: boolean;
            properties: Record<string, { additionalProperties?: boolean }>;
        };
        expect(inputSchema.additionalProperties).toBe(false);
        expect(inputSchema.properties.disbursement.additionalProperties).toBe(
            false,
        );
        expect(Object.keys(inputSchema.properties)).toEqual([
            'description',
            'amountInCents',
            'factDate',
            'disbursement',
        ]);
        const detail = doc.paths[
            '/v2/spaces/{spaceId}/financial-commitments/{commitmentId}'
        ].get!.responses!['200'] as {
            content: Record<string, { schema: { oneOf: unknown[] } }>;
        };
        expect(detail.content['application/json'].schema.oneOf).toHaveLength(3);
        expect(Reflect.getMetadata('path', PersonalExpenseController)).toBe(
            'spaces/:spaceId',
        );
        expect(
            Reflect.getMetadata(
                'path',
                SharedCashExpenseController.prototype.getDetail,
            ),
        ).toBe('financial-commitments/:commitmentId');
        expect(
            doc.paths['/v2/spaces/{spaceId}/personal-expenses'].post!
                .responses!['201'],
        ).toHaveProperty('headers.Location');
    });
});
