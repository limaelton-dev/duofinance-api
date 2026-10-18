import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
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
import migrationDataSource from '../dist/shared/technical/database/typeorm/data-source.js';
import { TypeOrmSpaceRepository } from '../dist/modules/spaces/infrastructure/typeorm/repositories/typeorm-space.repository.js';
import { TypeOrmSpaceCommandReceipts } from '../dist/modules/spaces/infrastructure/typeorm/repositories/typeorm-space-command-receipts.js';
import type { AuthenticatedContext } from '../dist/modules/identity/application/models/authenticated-context.js';

const unavailable = {
    code: 'INVITATION_UNAVAILABLE',
    message:
        'Não foi possível usar este convite. Ele pode ter sido cancelado, expirado ou já utilizado.',
    details: {},
};
const unknownToken = 'a'.repeat(43);
const endpoints = ['preview', 'respond'] as const;

describe('CARD-003 — contrato HTTP com PostgreSQL', () => {
    let app: INestApplication<Server>;
    let db: DataSource;

    beforeAll(async () => {
        if (
            process.env.NODE_ENV !== 'test' ||
            migrationDataSource.options.type !== 'postgres' ||
            migrationDataSource.options.url !== TEST_DATABASE_URL
        ) {
            throw new Error('Expected the isolated test database');
        }
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
        ) {
            throw new Error('Expected the isolated test database');
        }
        await db.query(`
            TRUNCATE TABLE space_command_receipts, space_invitations, space_members,
                auth_sessions, auth_credentials, spaces, persons CASCADE
        `);
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        await app?.close();
    });

    async function csrf(
        agent: ReturnType<typeof request.agent>,
    ): Promise<string> {
        const response = await agent
            .get('/v2/auth/csrf')
            .expect(200)
            .expect('Cache-Control', 'no-store');
        return response.body.csrfToken as string;
    }

    async function browser(displayName = 'Pessoa convidada') {
        const agent = request.agent(app.getHttpServer());
        const firstCsrf = await csrf(agent);
        const registration = await agent
            .post('/v2/auth/register')
            .set('Origin', 'http://localhost:3000')
            .set('X-CSRF-Token', firstCsrf)
            .send({
                displayName,
                email: randomUUID() + '@example.com',
                password: 'uma-senha-de-teste',
            })
            .expect(201);
        let csrfToken = await csrf(agent);
        return {
            agent,
            context: registration.body as AuthenticatedContext,
            async renewCsrf() {
                csrfToken = await csrf(agent);
            },
            post(
                path: string,
                body: object,
                key: string | null = randomUUID(),
            ) {
                const call = agent
                    .post(path)
                    .set('Origin', 'http://localhost:3000')
                    .set('X-CSRF-Token', csrfToken);
                if (key !== null) call.set('Idempotency-Key', key);
                return call.send(body);
            },
        };
    }

    async function invitation(creator: Awaited<ReturnType<typeof browser>>) {
        const created = await creator
            .post('/v2/spaces', { name: 'Casa de teste' })
            .expect(201);
        const token = new URLSearchParams(
            new URL(created.body.inviteUrl).hash.slice(1),
        ).get('token')!;
        return {
            token,
            space: created.body.space as { id: string; version: number },
            invitation: created.body.invitation as {
                id: string;
                expiresAt: string;
            },
        };
    }

    async function state(id: string) {
        const rows = await db.query(
            `SELECT s.version,
                (SELECT count(*)::int FROM space_members WHERE space_id = s.id) AS members,
                (SELECT count(*)::int FROM space_command_receipts WHERE result_space_id = s.id) AS receipts,
                (SELECT status FROM space_invitations WHERE space_id = s.id ORDER BY issued_at, id LIMIT 1) AS status
             FROM spaces s WHERE s.id = $1`,
            [id],
        );
        return rows[0];
    }

    function input(
        token: string,
        decision: 'ACCEPT' | 'REJECT' = 'ACCEPT',
        expectedVersion = 1,
    ) {
        return { token, decision, expectedVersion };
    }

    function noSecrets(response: request.Response, token: string) {
        const serialized = JSON.stringify(response.body);
        expect(serialized).not.toContain(token);
        expect(serialized).not.toContain(
            createHash('sha256').update(token, 'utf8').digest('hex'),
        );
        expect(response.body).not.toHaveProperty('inviteUrl');
        expect(response.body).not.toHaveProperty('tokenHash');
        expect(response.get('Cache-Control')).toBe('no-store');
    }

    it('preview autenticado é mínimo, sem chave idempotente, escrita ou acesso geral', async () => {
        const creator = await browser('Pessoa criadora');
        const invite = await invitation(creator);
        const recipient = await browser();
        const before = await state(invite.space.id);
        const preview = await recipient
            .post('/v2/invitations/preview', { token: invite.token }, null)
            .expect(200);
        expect(preview.body).toEqual({
            invitation: {
                id: invite.invitation.id,
                status: 'PENDING',
                expiresAt: invite.invitation.expiresAt,
            },
            space: { id: invite.space.id, label: 'Casa de teste', version: 1 },
            invitedBy: { displayName: 'Pessoa criadora' },
            canRespond: true,
        });
        noSecrets(preview, invite.token);
        expect(JSON.stringify(preview.body)).not.toContain(
            creator.context.person.id,
        );
        expect(JSON.stringify(preview.body)).not.toContain(
            creator.context.person.email,
        );
        expect(await state(invite.space.id)).toEqual(before);
        await recipient.agent.get('/v2/spaces/' + invite.space.id).expect(404);
        const list = await recipient.agent.get('/v2/spaces').expect(200);
        expect(list.body.items).toHaveLength(1);
        expect(list.body.items[0].id).toBe(recipient.context.personalSpace.id);
    });

    it.each(['ACCEPT', 'REJECT'] as const)(
        '%s mantém contrato, replay e autorização das consultas',
        async (decision) => {
            const creator = await browser('Pessoa criadora');
            const invite = await invitation(creator);
            const recipient = await browser();
            const key = randomUUID();
            const first = await recipient
                .post(
                    '/v2/invitations/respond',
                    input(invite.token, decision),
                    key,
                )
                .expect(200);
            expect(Object.keys(first.body).sort()).toEqual([
                'actorMembership',
                'decision',
                'invitation',
                'replayed',
                'spaceId',
            ]);
            expect(first.body).toMatchObject({
                decision,
                replayed: false,
                spaceId: invite.space.id,
                invitation: {
                    id: invite.invitation.id,
                    status: decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
                    resolvedAt: expect.any(String),
                },
            });
            noSecrets(first, invite.token);
            expect(first.body.actorMembership === null).toBe(
                decision === 'REJECT',
            );
            if (decision === 'ACCEPT')
                expect(first.body.actorMembership).toEqual({
                    id: expect.any(String),
                    personId: recipient.context.person.id,
                    status: 'ACTIVE',
                });
            const beforeReplay = await state(invite.space.id);
            const replay = await recipient
                .post(
                    '/v2/invitations/respond',
                    input(invite.token, decision),
                    key,
                )
                .expect(200);
            expect(replay.body).toEqual({ ...first.body, replayed: true });
            noSecrets(replay, invite.token);
            expect(await state(invite.space.id)).toEqual(beforeReplay);
            expect(beforeReplay).toMatchObject({
                version: 2,
                members: decision === 'ACCEPT' ? 2 : 1,
                receipts: 2,
            });
            const detail = await recipient.agent
                .get('/v2/spaces/' + invite.space.id)
                .expect(decision === 'ACCEPT' ? 200 : 404);
            if (decision === 'ACCEPT')
                expect(detail.body).toMatchObject({
                    activeMemberCount: 2,
                    invitation: null,
                    actorMembership: first.body.actorMembership,
                });
            const creatorDetail = await creator.agent
                .get('/v2/spaces/' + invite.space.id)
                .expect(200);
            expect(creatorDetail.body.invitation.status).toBe(
                decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
            );
            const context = await recipient.agent
                .get('/v2/auth/me')
                .expect(200);
            expect(context.body.personalSpace).toEqual(
                recipient.context.personalSpace,
            );
            const used = await recipient
                .post('/v2/invitations/respond', input(invite.token, decision))
                .expect(404);
            expect(used.body).toEqual(unavailable);
            noSecrets(used, invite.token);
            expect(
                (
                    await recipient
                        .post(
                            '/v2/invitations/preview',
                            { token: invite.token },
                            null,
                        )
                        .expect(404)
                ).body,
            ).toEqual(unavailable);
        },
    );

    it.each(['ACCEPT', 'REJECT'] as const)(
        'recupera %s após vencer a validade sem repetir escrita',
        async (decision) => {
            const creator = await browser();
            const invite = await invitation(creator);
            const recipient = await browser();
            const key = randomUUID();
            const first = await recipient
                .post(
                    '/v2/invitations/respond',
                    input(invite.token, decision),
                    key,
                )
                .expect(200);
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(
                new Date(Date.parse(invite.invitation.expiresAt) + 1),
            );
            await recipient.renewCsrf();
            const replay = await recipient
                .post(
                    '/v2/invitations/respond',
                    input(invite.token, decision),
                    key,
                )
                .expect(200);
            expect(replay.body).toEqual({ ...first.body, replayed: true });
            expect(await state(invite.space.id)).toMatchObject({
                version: 2,
                receipts: 2,
                members: decision === 'ACCEPT' ? 2 : 1,
            });
        },
    );

    it.each(['ACCEPT', 'REJECT'] as const)(
        'criador não pode %s nem cancelar por meio da recusa',
        async (decision) => {
            const creator = await browser();
            const invite = await invitation(creator);
            expect(
                (
                    await creator
                        .post(
                            '/v2/invitations/preview',
                            { token: invite.token },
                            null,
                        )
                        .expect(200)
                ).body.canRespond,
            ).toBe(false);
            const denied = await creator
                .post('/v2/invitations/respond', input(invite.token, decision))
                .expect(403);
            expect(denied.body.code).toBe('INVITATION_RESPONSE_NOT_ALLOWED');
            noSecrets(denied, invite.token);
            expect(await state(invite.space.id)).toMatchObject({
                version: 1,
                members: 1,
                receipts: 1,
                status: 'PENDING',
            });
        },
    );

    it('recusa permite nova emissão sem reativar o link antigo', async () => {
        const creator = await browser();
        const invite = await invitation(creator);
        const recipient = await browser();
        const key = randomUUID();
        const rejected = await recipient
            .post('/v2/invitations/respond', input(invite.token, 'REJECT'), key)
            .expect(200);
        const next = await creator
            .post('/v2/spaces/' + invite.space.id + '/invitations', {
                expectedVersion: 2,
            })
            .expect(201);
        expect(next.body.space.version).toBe(3);
        const replay = await recipient
            .post('/v2/invitations/respond', input(invite.token, 'REJECT'), key)
            .expect(200);
        expect(replay.body).toEqual({ ...rejected.body, replayed: true });
        expect(
            (
                await recipient
                    .post(
                        '/v2/invitations/preview',
                        { token: invite.token },
                        null,
                    )
                    .expect(404)
            ).body,
        ).toEqual(unavailable);
    });

    it('convite substituído e token desconhecido retornam a mesma indisponibilidade', async () => {
        const creator = await browser();
        const invite = await invitation(creator);
        const recipient = await browser();
        await creator
            .post(
                '/v2/spaces/' +
                    invite.space.id +
                    '/invitations/' +
                    invite.invitation.id +
                    '/replace',
                { expectedVersion: 1 },
            )
            .expect(201);
        for (const token of [invite.token, unknownToken]) {
            for (const endpoint of endpoints) {
                const response = await recipient
                    .post(
                        '/v2/invitations/' + endpoint,
                        endpoint === 'preview' ? { token } : input(token),
                    )
                    .expect(404);
                expect(response.body).toEqual(unavailable);
                noSecrets(response, token);
            }
        }
        expect(await state(invite.space.id)).toMatchObject({
            version: 2,
            members: 1,
            receipts: 2,
        });
    });

    it.each([-1, 0, 1])(
        'HTTP respeita a expiração em %i ms e não grava na prévia',
        async (offset) => {
            const creator = await browser();
            const invite = await invitation(creator);
            const recipient = await browser();
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(
                new Date(Date.parse(invite.invitation.expiresAt) + offset),
            );
            await recipient.renewCsrf();
            const preview = await recipient
                .post('/v2/invitations/preview', { token: invite.token }, null)
                .expect(offset < 0 ? 200 : 404);
            noSecrets(preview, invite.token);
            expect(await state(invite.space.id)).toMatchObject({
                version: 1,
                members: 1,
                receipts: 1,
                status: 'PENDING',
            });
            await recipient
                .post('/v2/invitations/respond', input(invite.token))
                .expect(offset < 0 ? 200 : 404);
        },
    );

    it.each(endpoints)(
        '%s exige sessão mesmo com CSRF válido',
        async (endpoint) => {
            const agent = request.agent(app.getHttpServer());
            const csrfToken = await csrf(agent);
            const response = await agent
                .post('/v2/invitations/' + endpoint)
                .set('Origin', 'http://localhost:3000')
                .set('X-CSRF-Token', csrfToken)
                .set('Idempotency-Key', randomUUID())
                .send(
                    endpoint === 'preview'
                        ? { token: unknownToken }
                        : input(unknownToken),
                )
                .expect(401);
            expect(response.body.code).toBe('UNAUTHENTICATED');
            noSecrets(response, unknownToken);
        },
    );

    it.each(endpoints)(
        '%s exige CSRF e não promete prioridade de 401 sem ele',
        async (endpoint) => {
            const recipient = await browser();
            const response = await recipient.agent
                .post('/v2/invitations/' + endpoint)
                .set('Origin', 'http://localhost:3000')
                .set('Idempotency-Key', randomUUID())
                .send(
                    endpoint === 'preview'
                        ? { token: unknownToken }
                        : input(unknownToken),
                )
                .expect(403);
            expect(response.body.code).toBe('INVALID_CSRF_TOKEN');
            noSecrets(response, unknownToken);
            const anonymous = await request(app.getHttpServer())
                .post('/v2/invitations/' + endpoint)
                .send(input(unknownToken))
                .expect(403);
            expect(anonymous.body.code).toBe('INVALID_CSRF_TOKEN');
        },
    );

    it('sessão expirada não decide nem revela o convite', async () => {
        const creator = await browser();
        const invite = await invitation(creator);
        const recipient = await browser();
        await db.query(
            'UPDATE auth_sessions SET expires_at = $1 WHERE person_id = $2',
            [new Date(Date.now() - 1), recipient.context.person.id],
        );
        const response = await recipient
            .post('/v2/invitations/respond', input(invite.token))
            .expect(401);
        expect(response.body.code).toBe('UNAUTHENTICATED');
        expect(await state(invite.space.id)).toMatchObject({
            version: 1,
            members: 1,
            receipts: 1,
        });
        noSecrets(response, invite.token);
    });

    it.each(
        endpoints.flatMap((endpoint) =>
            [
                undefined,
                null,
                42,
                {},
                '',
                'a'.repeat(42),
                'a'.repeat(44),
                '!'.repeat(43),
                ' ' + 'a'.repeat(42),
                'a'.repeat(42) + ' ',
            ].map((token) => ({ endpoint, token })),
        ),
    )(
        'valida token de $endpoint sem normalizar/ecoar',
        async ({ endpoint, token }) => {
            const recipient = await browser();
            const body =
                endpoint === 'preview'
                    ? { token }
                    : { ...input(unknownToken), token };
            const response = await recipient
                .post('/v2/invitations/' + endpoint, body)
                .expect(400);
            expect(response.body.code).toBe('VALIDATION_ERROR');
            expect(response.get('Cache-Control')).toBe('no-store');
            if (typeof token === 'string' && token.length >= 42)
                expect(JSON.stringify(response.body)).not.toContain(token);
        },
    );

    it.each([undefined, null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1])(
        'valida versão positiva segura sem coerção: %j',
        async (expectedVersion) => {
            const recipient = await browser();
            const response = await recipient
                .post('/v2/invitations/respond', {
                    token: unknownToken,
                    decision: 'ACCEPT',
                    expectedVersion,
                })
                .expect(400);
            expect(response.body.code).toBe('VALIDATION_ERROR');
            noSecrets(response, unknownToken);
        },
    );

    it.each([undefined, null, 'accept', 'REJECTED', 1])(
        'valida decisão exata: %j',
        async (decision) => {
            const recipient = await browser();
            const response = await recipient
                .post('/v2/invitations/respond', {
                    token: unknownToken,
                    decision,
                    expectedVersion: 1,
                })
                .expect(400);
            expect(response.body.code).toBe('VALIDATION_ERROR');
        },
    );

    it.each(endpoints)(
        '%s rejeita IDs/ator/status/datas adicionais',
        async (endpoint) => {
            const recipient = await browser();
            for (const field of [
                'actorPersonId',
                'personId',
                'memberId',
                'spaceId',
                'status',
                'resolvedAt',
            ]) {
                const body =
                    endpoint === 'preview'
                        ? { token: unknownToken }
                        : input(unknownToken);
                const response = await recipient
                    .post('/v2/invitations/' + endpoint, {
                        ...body,
                        [field]: randomUUID(),
                    })
                    .expect(400);
                expect(response.body.code).toBe('VALIDATION_ERROR');
            }
        },
    );

    it.each([null, '', 'chave-invalida'])(
        'resposta exige chave UUID: %j',
        async (key) => {
            const recipient = await browser();
            const response = await recipient
                .post('/v2/invitations/respond', input(unknownToken), key)
                .expect(400);
            expect(response.body.code).toBe('VALIDATION_ERROR');
        },
    );

    it('versão antiga retorna conflito sem consumir a decisão', async () => {
        const creator = await browser();
        const invite = await invitation(creator);
        const recipient = await browser();
        const response = await recipient
            .post('/v2/invitations/respond', input(invite.token, 'ACCEPT', 2))
            .expect(409);
        expect(response.body.code).toBe('CONCURRENT_MODIFICATION');
        expect(await state(invite.space.id)).toMatchObject({
            version: 1,
            members: 1,
            receipts: 1,
            status: 'PENDING',
        });
        noSecrets(response, invite.token);
    });

    it.each(['decision', 'token', 'expectedVersion'] as const)(
        'mesma chave com mudança de %s retorna 409',
        async (field) => {
            const creator = await browser();
            const invite = await invitation(creator);
            const recipient = await browser();
            const key = randomUUID();
            const body = input(invite.token, 'REJECT');
            await recipient
                .post('/v2/invitations/respond', body, key)
                .expect(200);
            const changed = { ...body };
            if (field === 'decision') changed.decision = 'ACCEPT';
            if (field === 'token') changed.token = unknownToken;
            if (field === 'expectedVersion') changed.expectedVersion = 2;
            const response = await recipient
                .post('/v2/invitations/respond', changed, key)
                .expect(409);
            expect(response.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
            expect(await state(invite.space.id)).toMatchObject({
                version: 2,
                members: 1,
                receipts: 2,
            });
            noSecrets(response, invite.token);
        },
    );

    it('outro ator não recupera recibo nem recebe acesso pelo token consumido', async () => {
        const creator = await browser();
        const invite = await invitation(creator);
        const first = await browser();
        const third = await browser();
        const key = randomUUID();
        await first
            .post('/v2/invitations/respond', input(invite.token), key)
            .expect(200);
        const denied = await third
            .post('/v2/invitations/respond', input(invite.token), key)
            .expect(404);
        expect(denied.body).toEqual(unavailable);
        noSecrets(denied, invite.token);
        await third.agent.get('/v2/spaces/' + invite.space.id).expect(404);
    });

    it.each(['CLOSING', 'CLOSED'] as const)(
        'estado %s bloqueia preview e decisão',
        async (status) => {
            const creator = await browser();
            const invite = await invitation(creator);
            const recipient = await browser();
            await db.query('UPDATE spaces SET status = $1 WHERE id = $2', [
                status,
                invite.space.id,
            ]);
            for (const endpoint of endpoints) {
                const response = await recipient
                    .post(
                        '/v2/invitations/' + endpoint,
                        endpoint === 'preview'
                            ? { token: invite.token }
                            : input(invite.token),
                    )
                    .expect(409);
                expect(response.body.code).toBe('SPACE_NOT_ACTIVE');
                noSecrets(response, invite.token);
            }
            expect(await state(invite.space.id)).toMatchObject({
                version: 1,
                members: 1,
                receipts: 1,
            });
        },
    );

    it('vaga indisponível impede terceiro; membro atual também não pode responder', async () => {
        const creator = await browser();
        const invite = await invitation(creator);
        const existing = await browser();
        const third = await browser();
        await db.query(
            `INSERT INTO space_members (id, space_id, person_id, status, slot, joined_at)
            VALUES ($1, $2, $3, 'ACTIVE', 2, $4)`,
            [
                randomUUID(),
                invite.space.id,
                existing.context.person.id,
                new Date(),
            ],
        );
        for (const endpoint of endpoints) {
            const response = await third
                .post(
                    '/v2/invitations/' + endpoint,
                    endpoint === 'preview'
                        ? { token: invite.token }
                        : input(invite.token),
                )
                .expect(409);
            expect(response.body.code).toBe('SPACE_MEMBER_LIMIT_REACHED');
        }
        const denied = await existing
            .post('/v2/invitations/respond', input(invite.token, 'REJECT'))
            .expect(403);
        expect(denied.body.code).toBe('INVITATION_RESPONSE_NOT_ALLOWED');
        expect(await state(invite.space.id)).toMatchObject({
            version: 1,
            members: 2,
            receipts: 1,
            status: 'PENDING',
        });
    });

    it.each([
        { endpoint: 'preview', limit: 30 },
        { endpoint: 'respond', limit: 10 },
    ])(
        '$endpoint limita $limit chamadas por IP/rota com Retry-After',
        async ({ endpoint, limit }) => {
            const recipient = await browser();
            for (let attempt = 0; attempt < limit; attempt++) {
                await recipient
                    .post(
                        '/v2/invitations/' + endpoint,
                        endpoint === 'preview'
                            ? { token: unknownToken }
                            : input(unknownToken),
                    )
                    .expect(404);
            }
            const response = await recipient
                .post(
                    '/v2/invitations/' + endpoint,
                    endpoint === 'preview'
                        ? { token: unknownToken }
                        : input(unknownToken),
                )
                .expect(429);
            expect(response.body.code).toBe('TOO_MANY_REQUESTS');
            expect(Number(response.get('Retry-After'))).toBeGreaterThan(0);
            expect(response.get('Access-Control-Expose-Headers')).toContain(
                'Retry-After',
            );
            noSecrets(response, unknownToken);
            const other = endpoint === 'preview' ? 'respond' : 'preview';
            await recipient
                .post(
                    '/v2/invitations/' + other,
                    other === 'preview'
                        ? { token: unknownToken }
                        : input(unknownToken),
                )
                .expect(404);
        },
    );

    it('falha de recibo retorna 500 genérico e reverte aceite sem vazar token', async () => {
        const creator = await browser();
        const invite = await invitation(creator);
        const recipient = await browser();
        const logger = vi
            .spyOn(Logger.prototype, 'error')
            .mockImplementation(() => {});
        vi.spyOn(
            app.get(TypeOrmSpaceCommandReceipts),
            'save',
        ).mockRejectedValueOnce(new Error('Injected receipt failure'));
        const response = await recipient
            .post('/v2/invitations/respond', input(invite.token))
            .expect(500);
        expect(response.body).toEqual({
            code: 'INTERNAL_ERROR',
            message: 'Ocorreu um erro interno. Tente novamente mais tarde.',
            details: {},
        });
        noSecrets(response, invite.token);
        expect(
            logger.mock.calls.map((call) => String(call[0])).join(' '),
        ).not.toContain(invite.token);
        expect(await state(invite.space.id)).toMatchObject({
            version: 1,
            members: 1,
            receipts: 1,
            status: 'PENDING',
        });
    });

    it('mesma chave em duas requisições concorrentes confirma um único aceite', async () => {
        const creator = await browser();
        const invite = await invitation(creator);
        const recipient = await browser();
        const key = randomUUID();
        const repository = app.get(TypeOrmSpaceRepository);
        const original = repository.findByInvitationTokenHash.bind(repository);
        let arrivals = 0;
        let release!: () => void;
        const both = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.spyOn(repository, 'findByInvitationTokenHash').mockImplementation(
            async (hash) => {
                const snapshot = await original(hash);
                arrivals++;
                if (arrivals === 2) release();
                await both;
                return snapshot;
            },
        );
        const responses = await Promise.all([
            recipient.post('/v2/invitations/respond', input(invite.token), key),
            recipient.post('/v2/invitations/respond', input(invite.token), key),
        ]);
        expect(responses.map((response) => response.status)).toEqual([
            200, 200,
        ]);
        expect(
            responses.map((response) => response.body.replayed).sort(),
        ).toEqual([false, true]);
        expect(responses[0].body.actorMembership).toEqual(
            responses[1].body.actorMembership,
        );
        expect(await state(invite.space.id)).toMatchObject({
            version: 2,
            members: 2,
            receipts: 2,
            status: 'ACCEPTED',
        });
    });

    it.each(['ACCEPT', 'REJECT'] as const)(
        '%s compete com substituição do criador usando a mesma raiz',
        async (decision) => {
            const creator = await browser();
            const invite = await invitation(creator);
            const recipient = await browser();
            const repository = app.get(TypeOrmSpaceRepository);
            const byHash =
                repository.findByInvitationTokenHash.bind(repository);
            const byId = repository.findById.bind(repository);
            let arrivals = 0;
            let release!: () => void;
            const both = new Promise<void>((resolve) => {
                release = resolve;
            });
            async function hold() {
                arrivals++;
                if (arrivals === 2) release();
                await both;
            }
            vi.spyOn(
                repository,
                'findByInvitationTokenHash',
            ).mockImplementation(async (hash) => {
                const snapshot = await byHash(hash);
                await hold();
                return snapshot;
            });
            vi.spyOn(repository, 'findById').mockImplementation(async (id) => {
                const snapshot = await byId(id);
                await hold();
                return snapshot;
            });
            const responses = await Promise.all([
                recipient.post(
                    '/v2/invitations/respond',
                    input(invite.token, decision),
                ),
                creator.post(
                    '/v2/spaces/' +
                        invite.space.id +
                        '/invitations/' +
                        invite.invitation.id +
                        '/replace',
                    { expectedVersion: 1 },
                ),
            ]);
            expect(
                responses.filter(
                    (response) =>
                        response.status === 200 || response.status === 201,
                ),
            ).toHaveLength(1);
            expect(
                responses.find((response) => response.status === 409)?.body
                    .code,
            ).toBe('CONCURRENT_MODIFICATION');
            expect(await state(invite.space.id)).toMatchObject({
                version: 2,
                receipts: 2,
            });
            const old = await db.query(
                'SELECT status FROM space_invitations WHERE id = $1',
                [invite.invitation.id],
            );
            expect(['ACCEPTED', 'REJECTED', 'CANCELLED']).toContain(
                old[0].status,
            );
        },
    );

    it('permite participação em mais de um compartilhado e preserva contexto pessoal', async () => {
        const creator = await browser();
        const first = await invitation(creator);
        const second = await invitation(creator);
        const recipient = await browser();
        await recipient
            .post('/v2/invitations/respond', input(first.token))
            .expect(200);
        await recipient
            .post('/v2/invitations/respond', input(second.token))
            .expect(200);
        const list = await recipient.agent.get('/v2/spaces').expect(200);
        expect(list.body.items).toHaveLength(3);
        expect(
            (await recipient.agent.get('/v2/auth/me').expect(200)).body
                .personalSpace,
        ).toEqual(recipient.context.personalSpace);
    });

    it('publica contrato composto sem referências quebradas ou exemplos de segredo', async () => {
        const response = await request(app.getHttpServer())
            .get('/v2/openapi.json')
            .expect(200);
        const document = response.body;
        expect(document.info.version).toBe('0.5.0');
        expect(Object.keys(document.paths)).toHaveLength(119);
        expect(
            document.paths[
                '/v2/spaces/{spaceId}/recurring-commitments/{id}/occurrences/{referenceDate}/value'
            ].put.operationId,
        ).toBe('setRecurringOccurrenceValue');
        for (const endpoint of endpoints) {
            const operation =
                document.paths['/v2/invitations/' + endpoint].post;
            expect(operation.security).toEqual([{ sessionCookie: [] }]);
            expect(operation.parameters).toContainEqual({
                $ref: '#/components/parameters/CsrfHeader',
            });
            expect(
                operation.responses['200'].headers['Cache-Control'].schema.enum,
            ).toEqual(['no-store']);
        }
        expect(
            document.paths['/v2/invitations/respond'].post.parameters,
        ).toContainEqual({
            $ref: '#/components/parameters/SpacesIdempotencyKey',
        });
        expect(
            document.components.schemas.SpacesRespondToInvitationRequest,
        ).toMatchObject({
            additionalProperties: false,
            required: ['token', 'decision', 'expectedVersion'],
            properties: {
                token: {
                    minLength: 43,
                    maxLength: 43,
                    writeOnly: true,
                    pattern: '^[A-Za-z0-9_-]{43}$',
                },
                decision: { enum: ['ACCEPT', 'REJECT'] },
                expectedVersion: {
                    minimum: 1,
                    maximum: Number.MAX_SAFE_INTEGER,
                },
            },
        });
        expect(
            document.components.schemas.SpacesRespondToInvitationResponse.oneOf,
        ).toHaveLength(2);
        function visit(value: unknown): void {
            if (typeof value !== 'object' || value === null) return;
            if (
                '$ref' in value &&
                typeof value.$ref === 'string' &&
                value.$ref.startsWith('#/')
            ) {
                let referenced: unknown = document;
                for (const piece of value.$ref.slice(2).split('/')) {
                    referenced = (referenced as Record<string, unknown>)[
                        piece.replaceAll('~1', '/').replaceAll('~0', '~')
                    ];
                }
                expect(referenced).toBeDefined();
            }
            for (const child of Object.values(value)) visit(child);
        }
        visit(document);
        expect(
            document.components.schemas.SpacesInvitationPreviewRequest
                .properties.token,
        ).not.toHaveProperty('example');
        expect(
            document.components.schemas.SpacesInvitationPreviewRequest
                .properties.token,
        ).not.toHaveProperty('default');
        expect(
            document.components.schemas.RegisterAccountRequest.properties
                .password.minLength,
        ).toBe(6);
    });
});
