import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import {
    Inject,
    Injectable,
    Module,
    type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from './setup-env.js';
import { AppModule } from '../dist/app.module.js';
import { configureApp } from '../dist/configure-app.js';
import migrationDataSource from '../dist/shared/technical/database/typeorm/data-source.js';
import {
    UNIT_OF_WORK,
    type UnitOfWork,
} from '../dist/shared/application/unit-of-work.js';
import { SpacesModule } from '../dist/modules/spaces/spaces.module.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../dist/modules/spaces/application/ports/public/space-access.port.js';
import { GetSpaceDetailsQuery } from '../dist/modules/spaces/application/queries/get-space-details.query.js';
import { TypeOrmSpaceReadQueries } from '../dist/modules/spaces/infrastructure/typeorm/queries/typeorm-space-read-queries.js';
import { PersonId } from '../dist/modules/spaces/domain/person/person-id.js';
import { SpaceId } from '../dist/modules/spaces/domain/space/space-id.js';
import type { AuthenticatedContext } from '../dist/modules/identity/application/models/authenticated-context.js';

@Injectable()
class AccessConsumer {
    constructor(@Inject(SPACE_ACCESS_PORT) readonly access: SpaceAccessPort) {}
}

@Module({ imports: [SpacesModule], providers: [AccessConsumer] })
class ConsumerModule {}

describe('Space authorization and isolation HTTP/PostgreSQL', () => {
    let app: INestApplication<Server>;
    let db: DataSource;
    let access: SpaceAccessPort;

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
            imports: [AppModule, ConsumerModule],
        }).compile();
        app = module.createNestApplication();
        configureApp(app);
        await app.init();
        db = app.get(DataSource);
        if (
            db.options.type !== 'postgres' ||
            db.options.url !== TEST_DATABASE_URL
        )
            throw new Error('Expected the isolated test database');
        access = app.get(AccessConsumer).access;
        await db.query(
            'TRUNCATE TABLE space_command_receipts, space_invitations, space_members, auth_sessions, auth_credentials, spaces, persons CASCADE',
        );
    });

    afterEach(async () => {
        await app?.close();
    });

    async function browser(displayName: string) {
        const agent = request.agent(app.getHttpServer());
        const csrf = async () =>
            (await agent.get('/v2/auth/csrf').expect(200)).body
                .csrfToken as string;
        const firstCsrf = await csrf();
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
        const csrfToken = await csrf();
        return {
            agent,
            context: registration.body as AuthenticatedContext,
            post(path: string, body: object, key = randomUUID()) {
                return agent
                    .post(path)
                    .set('Origin', 'http://localhost:3000')
                    .set('X-CSRF-Token', csrfToken)
                    .set('Idempotency-Key', key)
                    .send(body);
            },
        };
    }

    async function shared(
        creator: Awaited<ReturnType<typeof browser>>,
        name: string,
        member?: Awaited<ReturnType<typeof browser>>,
    ) {
        const key = randomUUID();
        const created = await creator
            .post('/v2/spaces', { name }, key)
            .expect(201);
        const token = new URLSearchParams(
            new URL(created.body.inviteUrl).hash.slice(1),
        ).get('token')!;
        if (member)
            await member
                .post('/v2/invitations/respond', {
                    token,
                    decision: 'ACCEPT',
                    expectedVersion: 1,
                })
                .expect(200);
        return {
            id: created.body.space.id as string,
            invitationId: created.body.invitation.id as string,
            key,
            name,
            version: member ? 2 : 1,
        };
    }

    async function fixture() {
        const a = await browser('Pessoa A');
        const b = await browser('Pessoa B');
        const c = await browser('Pessoa C');
        const s1 = await shared(a, 'S1 A/B', b);
        const s2 = await shared(a, 'S2 A/C', c);
        const s3 = await shared(a, 'S3 somente A');
        return { a, b, c, s1, s2, s3 };
    }

    async function state(id: string) {
        return (
            await db.query(
                `SELECT s.version, s.status,
            (SELECT count(*)::int FROM space_members WHERE space_id = s.id) AS members,
            (SELECT count(*)::int FROM space_invitations WHERE space_id = s.id) AS invitations,
            (SELECT count(*)::int FROM space_command_receipts WHERE result_space_id = s.id) AS receipts
            FROM spaces s WHERE s.id = $1`,
                [id],
            )
        )[0];
    }

    const actor = (person: Awaited<ReturnType<typeof browser>>) =>
        PersonId.from(person.context.person.id);

    it('enforces session ownership and membership while exposing only minimal context', async () => {
        const f = await fixture();
        const personal = await access.assertCanWrite(
            actor(f.a),
            SpaceId.from(f.a.context.personalSpace.id),
        );
        expect(personal).toEqual({
            spaceId: f.a.context.personalSpace.id,
            type: 'PERSONAL',
            status: 'ACTIVE',
            actorMemberId: null,
        });
        for (const person of [f.a, f.b]) {
            const context = await access.assertCanWrite(
                actor(person),
                SpaceId.from(f.s1.id),
            );
            expect(Object.keys(context).sort()).toEqual([
                'actorMemberId',
                'spaceId',
                'status',
                'type',
            ]);
            expect(context.actorMemberId).toEqual(expect.any(String));
            const detail = await person.agent
                .get(`/v2/spaces/${f.s1.id}`)
                .expect(200)
                .expect('Cache-Control', 'no-store');
            expect(detail.body.space.label).toBe('S1 A/B');
            expect(detail.body.actorMembership.personId).toBe(
                person.context.person.id,
            );
            if (person === f.b) expect(detail.body.invitation).toBeNull();
        }
        await f.a.agent.get(`/v2/spaces/${f.s3.id}`).expect(200);
        const list = await f.b.agent.get('/v2/spaces').expect(200);
        expect(list.body.items.map((s: { id: string }) => s.id)).toEqual([
            f.b.context.personalSpace.id,
            f.s1.id,
        ]);
        const denied = [];
        for (const id of [
            f.a.context.personalSpace.id,
            f.s2.id,
            f.s3.id,
            randomUUID(),
        ]) {
            denied.push(
                (await f.b.agent.get(`/v2/spaces/${id}`).expect(404)).body,
            );
            const write = await f.b
                .post(`/v2/spaces/${id}/invitations`, { expectedVersion: 1 })
                .expect(404);
            expect(write.body.code).toBe('SPACE_NOT_FOUND');
            await expect(
                access.assertCanWrite(actor(f.b), SpaceId.from(id)),
            ).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
        }
        for (const body of denied) expect(body).toEqual(denied[0]);
        await f.b
            .post(`/v2/spaces/${f.s1.id}/invitations`, { expectedVersion: 2 })
            .expect(403)
            .expect(({ body }) =>
                expect(body.code).toBe('INVITATION_ISSUER_REQUIRED'),
            );
        await f.b
            .post(`/v2/spaces/${f.s3.id}/invitations`, {
                expectedVersion: 1,
                actorId: f.a.context.person.id,
            })
            .expect(400);
        await f.b.agent.get('/v2/spaces/invalid').expect(400);
        await request(app.getHttpServer())
            .get(`/v2/spaces/${f.s1.id}`)
            .expect(401);
    });

    it.each(['CLOSING', 'CLOSED'] as const)(
        'preserves reads and rejects new effects without writes in %s',
        async (status) => {
            const f = await fixture();
            for (const space of [f.s1, f.s3])
                await db.query('UPDATE spaces SET status = $2 WHERE id = $1', [
                    space.id,
                    status,
                ]);
            for (const person of [f.a, f.b]) {
                const detail = await person.agent
                    .get(`/v2/spaces/${f.s1.id}`)
                    .expect(200);
                expect(detail.body.space.status).toBe(status);
                await expect(
                    access.assertCanWrite(actor(person), SpaceId.from(f.s1.id)),
                ).rejects.toMatchObject({ code: 'SPACE_NOT_ACTIVE' });
            }
            await expect(
                access.assertCanWrite(actor(f.c), SpaceId.from(f.s1.id)),
            ).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
            const before = await state(f.s3.id);
            for (const path of [
                `/v2/spaces/${f.s3.id}/invitations`,
                `/v2/spaces/${f.s3.id}/invitations/${f.s3.invitationId}/replace`,
            ]) {
                const result = await f.a
                    .post(path, { expectedVersion: 1 })
                    .expect(409);
                expect(result.body.code).toBe('SPACE_NOT_ACTIVE');
                expect(await state(f.s3.id)).toEqual(before);
            }
            const creatorOnly = await f.b
                .post(`/v2/spaces/${f.s1.id}/invitations`, {
                    expectedVersion: 2,
                })
                .expect(403);
            expect(creatorOnly.body.code).toBe('INVITATION_ISSUER_REQUIRED');
            const stale = await f.a
                .post(`/v2/spaces/${f.s3.id}/invitations`, {
                    expectedVersion: 99,
                })
                .expect(409);
            expect(stale.body.code).toBe('CONCURRENT_MODIFICATION');
        },
    );

    it.each(['CLOSING', 'CLOSED'] as const)(
        'preserves authorized creation, invitation issuance and replacement replay in %s',
        async (status) => {
            const a = await browser('Criador');
            const space = await shared(a, 'Replay');
            await db.query(
                "UPDATE space_invitations SET expires_at = now() - interval '1 day', issued_at = now() - interval '4 days' WHERE space_id = $1",
                [space.id],
            );
            const issueKey = randomUUID();
            const issued = await a
                .post(
                    `/v2/spaces/${space.id}/invitations`,
                    { expectedVersion: 1 },
                    issueKey,
                )
                .expect(201);
            const replacePath = `/v2/spaces/${space.id}/invitations/${issued.body.invitation.id}/replace`;
            const replaceKey = randomUUID();
            await a
                .post(replacePath, { expectedVersion: 2 }, replaceKey)
                .expect(201);
            await db.query('UPDATE spaces SET status = $2 WHERE id = $1', [
                space.id,
                status,
            ]);
            const before = await state(space.id);
            for (const [path, body, key] of [
                ['/v2/spaces', { name: 'Replay' }, space.key],
                [
                    `/v2/spaces/${space.id}/invitations`,
                    { expectedVersion: 1 },
                    issueKey,
                ],
                [replacePath, { expectedVersion: 2 }, replaceKey],
            ] as const) {
                const replay = await a.post(path, body, key).expect(201);
                expect(replay.body.replayed).toBe(true);
                expect(replay.body.inviteUrl).toBeNull();
                expect(replay.body.space.status).toBe(status);
                expect(await state(space.id)).toEqual(before);
            }
            const reused = await a
                .post(replacePath, { expectedVersion: 99 }, replaceKey)
                .expect(409);
            expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        },
    );

    it('revalidates reads, writes and replay after controlled membership removal', async () => {
        const f = await fixture();
        await access.assertCanRead(actor(f.b), SpaceId.from(f.s1.id));
        await access.assertCanWrite(actor(f.b), SpaceId.from(f.s1.id));
        const member = (
            await db.query(
                'SELECT * FROM space_members WHERE space_id = $1 AND person_id = $2',
                [f.s1.id, f.b.context.person.id],
            )
        )[0];
        await db.query('DELETE FROM space_members WHERE id = $1', [member.id]);
        await expect(
            access.assertCanRead(actor(f.b), SpaceId.from(f.s1.id)),
        ).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
        await expect(
            access.assertCanWrite(actor(f.b), SpaceId.from(f.s1.id)),
        ).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
        await f.b.agent.get(`/v2/spaces/${f.s1.id}`).expect(404);
        await f.b
            .post(`/v2/spaces/${f.s1.id}/invitations`, { expectedVersion: 2 })
            .expect(404);
        await db.query(
            'INSERT INTO space_members (id, space_id, person_id, status, slot, joined_at) VALUES ($1, $2, $3, $4, $5, $6)',
            [
                member.id,
                member.space_id,
                member.person_id,
                member.status,
                member.slot,
                member.joined_at,
            ],
        );
        await f.b.agent.get(`/v2/spaces/${f.s1.id}`).expect(200);
        await db.query(
            'DELETE FROM space_members WHERE space_id = $1 AND person_id = $2',
            [f.s3.id, f.a.context.person.id],
        );
        await f.a.post('/v2/spaces', { name: f.s3.name }, f.s3.key).expect(404);
    });

    it('closes the detail access gap through the actual filter after port validation', async () => {
        const f = await fixture();
        const query = new GetSpaceDetailsQuery(
            app.get(TypeOrmSpaceReadQueries),
            {
                assertCanRead: async (actorId, spaceId) => {
                    const context = await access.assertCanRead(
                        actorId,
                        spaceId,
                    );
                    await db.query(
                        'DELETE FROM space_members WHERE space_id = $1 AND person_id = $2',
                        [spaceId.value, actorId.value],
                    );
                    return context;
                },
                assertCanWrite: access.assertCanWrite.bind(access),
            },
        );
        await expect(
            query.execute(actor(f.b), SpaceId.from(f.s1.id)),
        ).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
    });

    it('observes uncommitted UnitOfWork changes and rollback through the access adapter', async () => {
        const a = await browser('Criador');
        const space = await shared(a, 'Transação');
        const uow = app.get<UnitOfWork>(UNIT_OF_WORK);
        const provider = app.get(TypeOrmSpaceReadQueries);
        const { EntityManagerProvider } =
            await import('../dist/shared/technical/database/typeorm/entity-manager.provider.js');
        const manager = app.get(EntityManagerProvider);
        await expect(
            uow.execute(async () => {
                await manager
                    .get()
                    .query('UPDATE spaces SET status = $2 WHERE id = $1', [
                        space.id,
                        'CLOSED',
                    ]);
                expect(
                    (
                        await access.assertCanRead(
                            actor(a),
                            SpaceId.from(space.id),
                        )
                    ).status,
                ).toBe('CLOSED');
                expect(
                    (
                        await provider.findDetails(
                            actor(a),
                            SpaceId.from(space.id),
                            new Date(),
                        )
                    )?.space.status,
                ).toBe('CLOSED');
                await access.assertCanWrite(actor(a), SpaceId.from(space.id));
            }),
        ).rejects.toMatchObject({ code: 'SPACE_NOT_ACTIVE' });
        expect(
            (await access.assertCanWrite(actor(a), SpaceId.from(space.id)))
                .status,
        ).toBe('ACTIVE');
    });
});
