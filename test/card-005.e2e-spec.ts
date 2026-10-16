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
import migrationDataSource from '../dist/shared/technical/database/typeorm/data-source.js';
import {
    DEFAULT_SETTLEMENT_RULE_REPOSITORY,
    type DefaultSettlementRuleRepository,
} from '../dist/modules/finances/application/ports/private/default-settlement-rule.repository.js';
import {
    FINANCES_COMMAND_RECEIPTS,
    type FinancesCommandReceipts,
} from '../dist/modules/finances/application/ports/private/finances-command-receipts.js';
import { ConfigureDefaultSettlementRuleHandler } from '../dist/modules/finances/application/handlers/configure-default-settlement-rule.handler.js';
import { GetDefaultSettlementRuleQuery } from '../dist/modules/finances/application/queries/get-default-settlement-rule.query.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../dist/modules/spaces/application/ports/public/space-access.port.js';
import { PersonId } from '../dist/modules/spaces/domain/person/person-id.js';
import { SpaceId } from '../dist/modules/spaces/domain/space/space-id.js';
import type { AuthenticatedContext } from '../dist/modules/identity/application/models/authenticated-context.js';
import { SettlementRule } from '../dist/modules/finances/domain/settlement-rule/settlement-rule.js';

describe('CARD-005 — contrato HTTP e persistência PostgreSQL', () => {
    let app: INestApplication<Server>;
    let db: DataSource;
    let repository: DefaultSettlementRuleRepository;
    let receipts: FinancesCommandReceipts;
    beforeAll(async () => {
        if (
            process.env.NODE_ENV !== 'test' ||
            migrationDataSource.options.type !== 'postgres' ||
            migrationDataSource.options.url !== TEST_DATABASE_URL
        )
            throw new Error('Expected isolated PostgreSQL test database');
        await migrationDataSource.initialize();
        try {
            await migrationDataSource.dropDatabase();
            await migrationDataSource.runMigrations();
        } finally {
            await migrationDataSource.destroy();
        }
    });
    beforeEach(async () => {
        const module = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = module.createNestApplication();
        configureApp(app);
        await app.init();
        db = app.get(DataSource);
        if (
            db.options.type !== 'postgres' ||
            db.options.url !== TEST_DATABASE_URL
        )
            throw new Error('Expected isolated PostgreSQL test database');
        repository = app.get(DEFAULT_SETTLEMENT_RULE_REPOSITORY);
        receipts = app.get(FINANCES_COMMAND_RECEIPTS);
        await db.query(
            'TRUNCATE TABLE finances_command_receipts, default_settlement_rule_changes, default_settlement_rules, space_command_receipts, space_invitations, space_members, auth_sessions, auth_credentials, spaces, persons CASCADE',
        );
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await app?.close();
    });
    const path = (id: string) => `/v2/spaces/${id}/default-settlement-rule`;
    const input = (dayOfMonth = 10, expectedVersion = 0) => ({
        expectedVersion,
        rule: { kind: 'MONTHLY_DAY' as const, dayOfMonth },
    });
    async function browser(name: string) {
        const agent = request.agent(app.getHttpServer());
        const csrf = (await agent.get('/v2/auth/csrf').expect(200)).body
            .csrfToken as string;
        const response = await agent
            .post('/v2/auth/register')
            .set('Origin', 'http://localhost:3000')
            .set('X-CSRF-Token', csrf)
            .send({
                displayName: name,
                email: randomUUID() + '@example.com',
                password: 'uma-senha-de-teste',
            })
            .expect(201);
        const token = (await agent.get('/v2/auth/csrf').expect(200)).body
            .csrfToken as string;
        const headers = () => ({
            Origin: 'http://localhost:3000',
            'X-CSRF-Token': token,
        });
        return {
            agent,
            context: response.body as AuthenticatedContext,
            headers,
            post: (url: string, body: object) =>
                agent
                    .post(url)
                    .set(headers())
                    .set('Idempotency-Key', randomUUID())
                    .send(body),
            put: (
                id: string,
                body: object = input(),
                key: string = randomUUID(),
            ) =>
                agent
                    .put(path(id))
                    .set(headers())
                    .set('Idempotency-Key', key)
                    .send(body),
        };
    }
    async function shared(
        a: Awaited<ReturnType<typeof browser>>,
        b?: Awaited<ReturnType<typeof browser>>,
    ) {
        const result = await a.post('/v2/spaces', { name: 'Casa' }).expect(201);
        if (b)
            await b
                .post('/v2/invitations/respond', {
                    token: new URLSearchParams(
                        new URL(result.body.inviteUrl).hash.slice(1),
                    ).get('token'),
                    decision: 'ACCEPT',
                    expectedVersion: 1,
                })
                .expect(200);
        return result.body.space.id as string;
    }
    async function state(id: string) {
        return {
            rules: await db.query(
                'SELECT * FROM default_settlement_rules WHERE space_id=$1',
                [id],
            ),
            history: await db.query(
                'SELECT * FROM default_settlement_rule_changes WHERE space_id=$1 ORDER BY version',
                [id],
            ),
            receipts: await db.query(
                'SELECT * FROM finances_command_receipts WHERE result_space_id=$1 ORDER BY actor_id,key',
                [id],
            ),
        };
    }
    function command(
        a: Awaited<ReturnType<typeof browser>>,
        id: string,
        day = 10,
        version = 0,
        key = randomUUID(),
    ) {
        return {
            actorId: PersonId.from(a.context.person.id),
            spaceId: SpaceId.from(id),
            key,
            ...input(day, version),
        };
    }
    it('A01/A02/A07: ausência é leitura sem INSERT; qualquer membro e criador sozinho configuram', async () => {
        const a = await browser('Criador');
        const b = await browser('Membro');
        const id = await shared(a, b);
        const alone = await shared(a);
        for (const person of [a, b]) {
            const result = await person.agent.get(path(id)).expect(200);
            expect(result.headers['cache-control']).toBe('no-store');
            expect(result.body).toEqual({
                spaceId: id,
                rule: null,
                version: 0,
                updatedAt: null,
            });
        }
        expect(await state(id)).toEqual({
            rules: [],
            history: [],
            receipts: [],
        });
        await b.put(id).expect(200);
        await a.put(id, input(20, 1)).expect(200);
        await a.put(alone, input(31)).expect(200);
        expect((await b.agent.get(path(id)).expect(200)).body).toMatchObject({
            version: 2,
            rule: input(20).rule,
        });
    });
    it('A03/A04/A12/A13: histórico rastreável, snapshot preservado e nenhum fato financeiro criado', async () => {
        const a = await browser('Criador');
        const id = await shared(a);
        const beforeSpaces = await db.query('SELECT * FROM spaces ORDER BY id');
        const first = await a.put(id).expect(200);
        const snapshot = (await repository.find(id))!.rule.snapshot;
        const suggestion =
            SettlementRule.from(snapshot).suggestTargetDate('2026-09-11');
        await a.put(id, input(20, 1)).expect(200);
        expect(snapshot).toEqual(input().rule);
        expect(suggestion).toBe('2026-10-10');
        expect(
            SettlementRule.from(snapshot).suggestTargetDate('2026-09-11'),
        ).toBe('2026-10-10');
        expect(await db.query('SELECT * FROM spaces ORDER BY id')).toEqual(
            beforeSpaces,
        );
        const saved = await state(id);
        expect(saved.history).toMatchObject([
            {
                version: 1,
                actor_person_id: a.context.person.id,
                previous_kind: null,
                previous_day_of_month: null,
                day_of_month: 10,
            },
            {
                version: 2,
                previous_kind: 'MONTHLY_DAY',
                previous_day_of_month: 10,
                day_of_month: 20,
            },
        ]);
        expect(saved.history[0].occurred_at.toISOString()).toBe(
            first.body.updatedAt,
        );
        expect(saved.receipts).toHaveLength(2);
        expect(
            await db.query(
                'SELECT (SELECT count(*) FROM financial_commitments)::int AS commitments, (SELECT count(*) FROM financial_disbursements)::int AS disbursements, (SELECT count(*) FROM inter_member_obligations)::int AS obligations, (SELECT count(*) FROM settlement_cycles)::int AS cycles',
            ),
        ).toEqual([
            { commitments: 0, disbursements: 0, obligations: 0, cycles: 0 },
        ]);
    });
    it('A03/A10/A11: no-op não duplica histórico; versão obsoleta conflita; replay devolve versão histórica', async () => {
        const a = await browser('Criador');
        const b = await browser('Membro');
        const id = await shared(a, b);
        const key = randomUUID();
        const first = await a.put(id, input(), key).expect(200);
        expect(first.body).toMatchObject({
            version: 1,
            changed: true,
            replayed: false,
        });
        const noop = await a.put(id, input(10, 1)).expect(200);
        expect(noop.body).toMatchObject({
            version: 1,
            changed: false,
            replayed: false,
        });
        expect((await state(id)).history).toHaveLength(1);
        expect((await a.put(id, input()).expect(409)).body.code).toBe(
            'CONCURRENT_MODIFICATION',
        );
        await b.put(id, input(20, 1)).expect(200);
        const before = await state(id);
        const replay = await a.put(id, input(), key).expect(200);
        expect(replay.body).toEqual({ ...first.body, replayed: true });
        expect(await state(id)).toEqual(before);
        expect(
            (await a.agent.get(path(id)).expect(200)).body.rule.dayOfMonth,
        ).toBe(20);
        for (const body of [input(11), input(10, 2)])
            expect((await a.put(id, body, key).expect(409)).body.code).toBe(
                'IDEMPOTENCY_KEY_REUSED',
            );
        const other = await shared(a);
        expect((await a.put(other, input(), key).expect(409)).body.code).toBe(
            'IDEMPOTENCY_KEY_REUSED',
        );
        const otherActor = await b.put(id, input(25, 2), key).expect(200);
        expect(otherActor.body).toMatchObject({ replayed: false, version: 3 });
        await db.query(
            'DELETE FROM space_members WHERE space_id=$1 AND person_id=$2',
            [id, a.context.person.id],
        );
        expect((await a.put(id, input(), key).expect(404)).body.code).toBe(
            'SPACE_NOT_FOUND',
        );
        await a.agent.get(path(id)).expect(404);
        expect((await state(id)).history).toHaveLength(3);
    });
    it.each(['CLOSING', 'CLOSED'])(
        'A09/A11: %s mantém leitura/replay autorizado e bloqueia nova escrita/no-op',
        async (status) => {
            const a = await browser('Criador');
            const id = await shared(a);
            const key = randomUUID();
            await a.put(id, input(), key).expect(200);
            await db.query('UPDATE spaces SET status=$2 WHERE id=$1', [
                id,
                status,
            ]);
            const before = await state(id);
            expect(
                (await a.agent.get(path(id)).expect(200)).body.rule.dayOfMonth,
            ).toBe(10);
            expect(
                (await a.put(id, input(), key).expect(200)).body.replayed,
            ).toBe(true);
            for (const day of [10, 20])
                expect(
                    (await a.put(id, input(day, 1)).expect(409)).body.code,
                ).toBe('SPACE_NOT_ACTIVE');
            expect(await state(id)).toEqual(before);
        },
    );
    it('A07/A08: pessoal, terceiro, inexistente, membership inativo e sessão ausente não expõem regra', async () => {
        const a = await browser('Criador');
        const b = await browser('Membro');
        const c = await browser('Terceiro');
        const id = await shared(a, b);
        await a.put(id).expect(200);
        expect(
            (await a.agent.get(path(a.context.personalSpace.id)).expect(409))
                .body.code,
        ).toBe('SHARED_SPACE_REQUIRED');
        expect(
            (await a.put(a.context.personalSpace.id).expect(409)).body.code,
        ).toBe('SHARED_SPACE_REQUIRED');
        for (const target of [id, randomUUID()]) {
            expect(
                (await c.agent.get(path(target)).expect(404)).body.code,
            ).toBe('SPACE_NOT_FOUND');
            expect((await c.put(target).expect(404)).body.code).toBe(
                'SPACE_NOT_FOUND',
            );
        }
        await db.query(
            'DELETE FROM space_members WHERE space_id=$1 AND person_id=$2',
            [id, b.context.person.id],
        );
        await b.agent.get(path(id)).expect(404);
        await b.put(id).expect(404);
        expect(
            (await request(app.getHttpServer()).get(path(id)).expect(401)).body
                .code,
        ).toBe('UNAUTHENTICATED');
        const anonymous = request.agent(app.getHttpServer());
        const csrf = (await anonymous.get('/v2/auth/csrf').expect(200)).body
            .csrfToken;
        expect(
            (
                await anonymous
                    .put(path(id))
                    .set('Origin', 'http://localhost:3000')
                    .set('X-CSRF-Token', csrf)
                    .set('Idempotency-Key', randomUUID())
                    .send(input())
                    .expect(401)
            ).body.code,
        ).toBe('UNAUTHENTICATED');
    });
    it('A06/A14: DTO fechado, limites, headers, UUID e OpenAPI coerentes', async () => {
        const a = await browser('Criador');
        const id = await shared(a);
        const invalid = [
            input(0),
            input(32),
            input(1.5),
            input(10, -1),
            input(10, 0.5),
            input(10, Number.MAX_SAFE_INTEGER + 1),
            { ...input(), rule: { kind: 'MONTHLY_DAY', dayOfMonth: '10' } },
            { ...input(), rule: { kind: 'MONTHLY_DAY', dayOfMonth: null } },
            { ...input(), expectedVersion: '0' },
            { ...input(), rule: 'MONTHLY_DAY' },
            { ...input(), rule: [] },
            { expectedVersion: 0, rule: null },
            { ...input(), actorId: randomUUID() },
            { ...input(), rule: { kind: 'WEEKLY', dayOfMonth: 10 } },
            { ...input(), rule: { ...input().rule, extra: true } },
        ];
        for (const body of invalid)
            expect((await a.put(id, body).expect(400)).body.code).toBe(
                'VALIDATION_ERROR',
            );
        const fieldError = (await a.put(id, input(32)).expect(400)).body;
        expect(fieldError.details.fields).toContainEqual({
            field: 'rule.dayOfMonth',
            messages: ['O dia do acerto deve ser entre 1 e 31.'],
        });
        await a.agent.get(path('invalid')).expect(400);
        expect(
            (
                await a.agent
                    .put(path(id))
                    .set(a.headers())
                    .send(input())
                    .expect(400)
            ).body.code,
        ).toBe('VALIDATION_ERROR');
        expect(
            (await a.put(id, input(), 'invalid').expect(400)).body.code,
        ).toBe('VALIDATION_ERROR');
        expect(
            (
                await a.agent
                    .put(path(id))
                    .set('Origin', 'http://localhost:3000')
                    .set('Idempotency-Key', randomUUID())
                    .send(input())
                    .expect(403)
            ).body.code,
        ).toBe('INVALID_CSRF_TOKEN');
        expect(await state(id)).toEqual({
            rules: [],
            history: [],
            receipts: [],
        });
        const document = (await a.agent.get('/v2/openapi.json').expect(200))
            .body;
        const endpoint =
            document.paths['/v2/spaces/{spaceId}/default-settlement-rule'];
        expect(
            endpoint.get.responses['200'].content['application/json'].examples
                .absent.value.rule,
        ).toBeNull();
        expect(
            endpoint.put.parameters
                .filter((p: { in: string }) => p.in === 'header')
                .map((p: { name: string }) => p.name),
        ).toEqual(['X-CSRF-Token', 'Idempotency-Key']);
        expect(Object.keys(endpoint.put.responses)).toEqual(
            expect.arrayContaining([
                '200',
                '400',
                '401',
                '403',
                '404',
                '409',
                '429',
                '500',
            ]),
        );
        expect(
            document.components.schemas.SettlementRule.properties.dayOfMonth,
        ).toMatchObject({ minimum: 1, maximum: 31 });
        expect(
            document.components.schemas.ConfigureDefaultSettlementRuleRequest
                .additionalProperties,
        ).toBe(false);
    });
    it.each([0, 1])(
        'A12: CAS simultâneo controlado com versão %s produz um sucesso e um conflito',
        async (version) => {
            const a = await browser('Criador');
            const b = await browser('Membro');
            const id = await shared(a, b);
            if (version) await a.put(id).expect(200);
            const original = repository.find.bind(repository);
            let arrivals = 0;
            let release!: () => void;
            const barrier = new Promise<void>((resolve) => {
                release = resolve;
            });
            vi.spyOn(repository, 'find').mockImplementation(async (target) => {
                const value = await original(target);
                if (++arrivals === 2) release();
                await barrier;
                return value;
            });
            const results = await Promise.all([
                a.put(id, input(20, version)),
                b.put(id, input(25, version)),
            ]);
            expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
            expect(results.find((r) => r.status === 409)!.body.code).toBe(
                'CONCURRENT_MODIFICATION',
            );
            const saved = await state(id);
            expect(saved.rules[0].version).toBe(version + 1);
            expect(saved.history).toHaveLength(version + 1);
            expect(saved.receipts).toHaveLength(version + 1);
        },
    );
    it('A10/A12: mesma chave simultânea recupera recibo depois do rollback, sem efeito duplicado', async () => {
        const a = await browser('Criador');
        const id = await shared(a);
        const key = randomUUID();
        const original = repository.find.bind(repository);
        let arrivals = 0;
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.spyOn(repository, 'find').mockImplementation(async (target) => {
            const value = await original(target);
            if (++arrivals === 2) release();
            await barrier;
            return value;
        });
        const results = await Promise.all([
            a.put(id, input(), key),
            a.put(id, input(), key),
        ]);
        expect(results.map((r) => r.status)).toEqual([200, 200]);
        expect(results.map((r) => r.body.replayed).sort()).toEqual([
            false,
            true,
        ]);
        const saved = await state(id);
        expect(saved.rules).toHaveLength(1);
        expect(saved.history).toHaveLength(1);
        expect(saved.receipts).toHaveLength(1);
    });
    it.each([0, 1])(
        'A13: falha após salvar recibo reverte configuração, histórico e recibo (v%s)',
        async (version) => {
            const a = await browser('Criador');
            const id = await shared(a);
            if (version) await a.put(id).expect(200);
            const before = await state(id);
            const save = receipts.save.bind(receipts);
            vi.spyOn(receipts, 'save').mockImplementation(async (...args) => {
                await save(...args);
                throw new Error('controlled receipt failure');
            });
            await expect(
                app
                    .get(ConfigureDefaultSettlementRuleHandler)
                    .execute(command(a, id, 20, version)),
            ).rejects.toThrow('controlled receipt failure');
            expect(await state(id)).toEqual(before);
        },
    );
    it.each(['state', 'membership'])(
        'A08/A09: revalidação anterior à persistência detecta perda de %s',
        async (reason) => {
            const a = await browser('Criador');
            const id = await shared(a);
            const access = app.get<SpaceAccessPort>(SPACE_ACCESS_PORT);
            const original = access.assertCanWrite.bind(access);
            let count = 0;
            const manager = app.get(DataSource);
            vi.spyOn(access, 'assertCanWrite').mockImplementation(
                async (...args) => {
                    if (++count === 2) {
                        if (reason === 'state')
                            await manager.query(
                                'UPDATE spaces SET status=$2 WHERE id=$1',
                                [id, 'CLOSED'],
                            );
                        else
                            await manager.query(
                                'DELETE FROM space_members WHERE space_id=$1 AND person_id=$2',
                                [id, a.context.person.id],
                            );
                    }
                    return original(...args);
                },
            );
            await expect(
                app
                    .get(ConfigureDefaultSettlementRuleHandler)
                    .execute(command(a, id)),
            ).rejects.toMatchObject({
                code:
                    reason === 'state' ? 'SPACE_NOT_ACTIVE' : 'SPACE_NOT_FOUND',
            });
            expect(await state(id)).toEqual({
                rules: [],
                history: [],
                receipts: [],
            });
        },
    );
    it('A14: constraints SQL protegem configuração, histórico e referência do recibo', async () => {
        const a = await browser('Criador');
        const id = await shared(a);
        await a.put(id).expect(200);
        const before = await state(id);
        for (const sql of [
            'UPDATE default_settlement_rules SET day_of_month=0 WHERE space_id=$1',
            "UPDATE default_settlement_rules SET kind='WEEKLY' WHERE space_id=$1",
            'UPDATE default_settlement_rules SET version=0 WHERE space_id=$1',
            'UPDATE default_settlement_rule_changes SET previous_day_of_month=5 WHERE space_id=$1',
            'UPDATE default_settlement_rule_changes SET day_of_month=32 WHERE space_id=$1',
            "UPDATE finances_command_receipts SET status='PENDING' WHERE result_space_id=$1",
            "UPDATE finances_command_receipts SET request_hash=decode('00','hex') WHERE result_space_id=$1",
        ])
            await expect(db.query(sql, [id])).rejects.toMatchObject({
                driverError: { code: '23514' },
            });
        await expect(
            db.query(
                'UPDATE finances_command_receipts SET result_version=99 WHERE result_space_id=$1',
                [id],
            ),
        ).rejects.toMatchObject({ driverError: { code: '23503' } });
        await expect(
            db.query(
                'UPDATE default_settlement_rules SET space_id=$2 WHERE space_id=$1',
                [id, randomUUID()],
            ),
        ).rejects.toMatchObject({ driverError: { code: '23503' } });
        expect(await state(id)).toEqual(before);
    });
    it('A08: leitura reautoriza após carregar configuração sem expor resultado revogado', async () => {
        const a = await browser('Criador');
        const id = await shared(a);
        await a.put(id).expect(200);
        const find = repository.find.bind(repository);
        vi.spyOn(repository, 'find').mockImplementation(async (target) => {
            const result = await find(target);
            await db.query(
                'DELETE FROM space_members WHERE space_id=$1 AND person_id=$2',
                [id, a.context.person.id],
            );
            return result;
        });
        await expect(
            app
                .get(GetDefaultSettlementRuleQuery)
                .execute(PersonId.from(a.context.person.id), SpaceId.from(id)),
        ).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
    });
    it('A10/A12: corrida no-op da mesma chave recupera recibo após unique/rollback', async () => {
        const a = await browser('Criador');
        const id = await shared(a);
        await a.put(id).expect(200);
        const key = randomUUID();
        const original = receipts.find.bind(receipts);
        let count = 0;
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.spyOn(receipts, 'find').mockImplementation(async (cmd) => {
            const found = await original(cmd);
            if (cmd.key === key && count < 2) {
                if (++count === 2) release();
                await barrier;
            }
            return found;
        });
        const results = await Promise.all([
            a.put(id, input(10, 1), key),
            a.put(id, input(10, 1), key),
        ]);
        expect(results.map((r) => r.status)).toEqual([200, 200]);
        expect(results.map((r) => r.body.replayed).sort()).toEqual([
            false,
            true,
        ]);
        expect(results.map((r) => r.body.changed)).toEqual([false, false]);
        const saved = await state(id);
        expect(saved.rules[0].version).toBe(1);
        expect(saved.history).toHaveLength(1);
        expect(saved.receipts).toHaveLength(2);
    });
    it('A14: migration down/up remove só objetos do card e preserva Auth/Spaces com dados', async () => {
        const a = await browser('Criador');
        const id = await shared(a);
        await a.put(id).expect(200);
        const tables = [
            'persons',
            'spaces',
            'space_members',
            'space_invitations',
            'space_command_receipts',
            'auth_sessions',
            'auth_credentials',
        ];
        const legacy = await Promise.all(
            tables.map((t) => db.query(`SELECT * FROM ${t} ORDER BY 1`)),
        );
        const source = new DataSource({ ...migrationDataSource.options });
        await source.initialize();
        try {
            expect(
                (
                    await source.query(
                        'SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 20',
                    )
                ).map((m: { name: string }) => m.name),
            ).toEqual([
                'InstallmentAnticipations1792165500000',
                'FiniteInstallmentCommitments1792165400000',
                'RecurringMaintenance1792165300000',
                'VariableRecurringOccurrences1792165200000',
                'FixedRecurringCommitments1792165100000',
                'PlannedExpenses1792165000000',
                'ReverseSettlementResolution1792164211588',
                'WaiveInterMemberObligation1792163371690',
                'FinalizeSettlementCycle1792162609967',
                'RecordSettlementOffset1792162181991',
                'CustomSettlementAssignment1792160969556',
                'FinancialCommandAudit1792154979034',
                'ExternalLiabilitySettlements1792110000000',
                'RecordCreditCardPurchase1792087652424',
                'PartialFinancialFulfillment1792022400000',
                'RecordIncomeAndReceipt1792022348501',
                'RecordPersonalExpense1791995573673',
                'RecordManualSettlementTransfer1791850000000',
                'OptionalExpectedPayer1791728636456',
                'RecordSharedCashExpense1791655785713',
            ]);
            while (
                (
                    await source.query(
                        'SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 1',
                    )
                )[0]?.name !== 'ConfigureDefaultSettlementRule1791590400000'
            ) {
                await source.undoLastMigration();
            }
            const latest = (
                await source.query(
                    'SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 1',
                )
            )[0].name;
            expect(latest).toBe('ConfigureDefaultSettlementRule1791590400000');
            await source.undoLastMigration();
            expect(
                (
                    await source.query(
                        "SELECT to_regclass('default_settlement_rules') AS table_name",
                    )
                )[0].table_name,
            ).toBeNull();
            const applied = await source.runMigrations();
            expect(applied.map((m) => m.name)).toEqual([
                'ConfigureDefaultSettlementRule1791590400000',
                'RecordSharedCashExpense1791655785713',
                'OptionalExpectedPayer1791728636456',
                'RecordManualSettlementTransfer1791850000000',
                'RecordPersonalExpense1791995573673',
                'RecordIncomeAndReceipt1792022348501',
                'PartialFinancialFulfillment1792022400000',
                'RecordCreditCardPurchase1792087652424',
                'ExternalLiabilitySettlements1792110000000',
                'FinancialCommandAudit1792154979034',
                'CustomSettlementAssignment1792160969556',
                'RecordSettlementOffset1792162181991',
                'FinalizeSettlementCycle1792162609967',
                'WaiveInterMemberObligation1792163371690',
                'ReverseSettlementResolution1792164211588',
                'PlannedExpenses1792165000000',
                'FixedRecurringCommitments1792165100000',
                'VariableRecurringOccurrences1792165200000',
                'RecurringMaintenance1792165300000',
                'FiniteInstallmentCommitments1792165400000',
                'InstallmentAnticipations1792165500000',
            ]);
        } finally {
            await source.destroy();
        }
        expect(
            await Promise.all(
                tables.map((t) => db.query(`SELECT * FROM ${t} ORDER BY 1`)),
            ),
        ).toEqual(legacy);
        expect(
            (await a.agent.get('/v2/auth/me').expect(200)).body.person.id,
        ).toBe(a.context.person.id);
        expect((await a.agent.get(path(id)).expect(200)).body.rule).toBeNull();
    });
});
