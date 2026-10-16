import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { TEST_DATABASE_URL } from './setup-env.js';
import migrationDataSource from '../dist/shared/technical/database/typeorm/data-source.js';
import { InitialCard0011789556956788 } from '../dist/shared/technical/database/typeorm/migrations/1789556956788-InitialCard001.js';
import { Card002SharedSpaces1790597980318 } from '../dist/shared/technical/database/typeorm/migrations/1790597980318-Card002SharedSpaces.js';
import { Card003InvitationResponses1791585518092 } from '../dist/shared/technical/database/typeorm/migrations/1791585518092-Card003InvitationResponses.js';
import { TransactionContext } from '../dist/shared/technical/database/typeorm/transaction-context.js';
import { EntityManagerProvider } from '../dist/shared/technical/database/typeorm/entity-manager.provider.js';
import { TypeOrmUnitOfWork } from '../dist/shared/technical/database/typeorm/typeorm-unit-of-work.js';
import { TypeOrmSpaceRepository } from '../dist/modules/spaces/infrastructure/typeorm/repositories/typeorm-space.repository.js';
import { TypeOrmSpaceCommandReceipts } from '../dist/modules/spaces/infrastructure/typeorm/repositories/typeorm-space-command-receipts.js';
import { TypeOrmSpaceReadQueries } from '../dist/modules/spaces/infrastructure/typeorm/queries/typeorm-space-read-queries.js';
import { GetInvitationPreviewQuery } from '../dist/modules/spaces/application/queries/get-invitation-preview.query.js';
import { RespondToSharedSpaceInvitationHandler } from '../dist/modules/spaces/application/handlers/respond-to-shared-space-invitation.handler.js';
import { NodeInvitationTokenGenerator } from '../dist/modules/spaces/infrastructure/security/node-invitation-token-generator.js';
import { ConcurrentModificationError } from '../dist/modules/spaces/application/errors/concurrent-modification.error.js';
import { IdempotencyKeyReusedError } from '../dist/modules/spaces/application/errors/idempotency-key-reused.error.js';
import type {
    RespondToInvitationCommand,
    SpaceCommand,
} from '../dist/modules/spaces/application/ports/private/space-command-receipts.js';
import { PersonId } from '../dist/modules/spaces/domain/person/person-id.js';
import { SpaceId } from '../dist/modules/spaces/domain/space/space-id.js';
import { Space } from '../dist/modules/spaces/domain/space/space.js';
import { MemberId } from '../dist/modules/spaces/domain/member/member-id.js';
import { InvitationId } from '../dist/modules/spaces/domain/invitation/invitation-id.js';
import { PersonOrmEntity } from '../dist/modules/spaces/infrastructure/typeorm/entities/person.orm-entity.js';
import { SpaceOrmEntity } from '../dist/modules/spaces/infrastructure/typeorm/entities/space.orm-entity.js';
import { SpaceMemberOrmEntity } from '../dist/modules/spaces/infrastructure/typeorm/entities/space-member.orm-entity.js';
import { SpaceInvitationOrmEntity } from '../dist/modules/spaces/infrastructure/typeorm/entities/space-invitation.orm-entity.js';
import { SpaceCommandReceiptOrmEntity } from '../dist/modules/spaces/infrastructure/typeorm/entities/space-command-receipt.orm-entity.js';
import { AuthCredentialOrmEntity } from '../dist/modules/identity/infrastructure/typeorm/entities/auth-credential.orm-entity.js';
import { AuthSessionOrmEntity } from '../dist/modules/identity/infrastructure/typeorm/entities/auth-session.orm-entity.js';

const now = new Date('2026-10-09T12:00:00.000Z');
const tokens = new NodeInvitationTokenGenerator();
const entities = [
    PersonOrmEntity,
    SpaceOrmEntity,
    SpaceMemberOrmEntity,
    SpaceInvitationOrmEntity,
    SpaceCommandReceiptOrmEntity,
    AuthCredentialOrmEntity,
    AuthSessionOrmEntity,
];

describe('CARD-003 — persistência e migration', () => {
    let db: DataSource;
    let repository: TypeOrmSpaceRepository;
    let receipts: TypeOrmSpaceCommandReceipts;
    let uow: TypeOrmUnitOfWork;
    let reads: TypeOrmSpaceReadQueries;
    let preview: GetInvitationPreviewQuery;
    let respond: RespondToSharedSpaceInvitationHandler;
    let upgradeVerified = false;

    function configure(source: DataSource) {
        const context = new TransactionContext();
        const provider = new EntityManagerProvider(source, context);
        repository = new TypeOrmSpaceRepository(provider);
        receipts = new TypeOrmSpaceCommandReceipts(provider);
        uow = new TypeOrmUnitOfWork(source, context);
        reads = new TypeOrmSpaceReadQueries(provider);
        preview = new GetInvitationPreviewQuery(reads, tokens);
        respond = new RespondToSharedSpaceInvitationHandler(
            uow,
            repository,
            receipts,
            tokens,
            reads,
        );
    }

    beforeAll(async () => {
        if (
            process.env.NODE_ENV !== 'test' ||
            migrationDataSource.options.type !== 'postgres' ||
            migrationDataSource.options.url !== TEST_DATABASE_URL
        ) {
            throw new Error('Expected the isolated test database');
        }

        const previous = new DataSource({
            ...migrationDataSource.options,
            entities,
            migrations: [
                InitialCard0011789556956788,
                Card002SharedSpaces1790597980318,
            ],
        });
        await previous.initialize();

        try {
            await previous.dropDatabase();
            await previous.runMigrations();
            configure(previous);
            db = previous;
            const actor = await createPerson();
            const legacy = await persist(actor);
            const command: SpaceCommand = {
                operation: 'CREATE_SPACE',
                actorId: actor,
                key: randomUUID(),
                name: 'Casa',
            };
            await uow.execute(() =>
                receipts.save(command, {
                    resultSpaceId: legacy.space.id,
                    resultInvitationId: legacy.invitationId,
                    createdAt: now,
                }),
            );

            await previous.destroy();
            db = new DataSource({ ...migrationDataSource.options, entities });
            await db.initialize();
            configure(db);
            const applied = await db.runMigrations();
            expect(applied.map((item) => item.name)).toEqual([
                'Card003InvitationResponses1791585518092',
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
            ]);
            expect(await receipts.find(command)).not.toBeNull();
            expect((await repository.findById(legacy.space.id))?.version).toBe(
                1,
            );
            expect(await state(legacy.space.id)).toMatchObject({
                members: 1,
                receipts: 1,
                invitationStatus: 'PENDING',
            });
            upgradeVerified = true;
        } finally {
            if (previous.isInitialized) {
                await previous.destroy();
            }
        }
    });

    beforeEach(async () => {
        await db.query(`
            TRUNCATE TABLE space_command_receipts, space_invitations,
                space_members, auth_sessions, auth_credentials, spaces, persons CASCADE
        `);
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(now);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    afterAll(async () => {
        if (db?.isInitialized) {
            await db.destroy();
        }
    });

    async function createPerson(): Promise<PersonId> {
        const id = PersonId.create();
        await db.query(
            `INSERT INTO persons (id, display_name, version, created_at)
             VALUES ($1, 'Pessoa de teste', 1, $2)`,
            [id.value, now],
        );
        return id;
    }

    async function persist(creator: PersonId) {
        const invitationId = InvitationId.create();
        const generated = tokens.generate();
        const space = Space.createShared({
            id: SpaceId.create(),
            name: 'Casa',
            createdByPersonId: creator,
            creatorMemberId: MemberId.create(),
            invitationId,
            now,
        });
        await uow.execute(() =>
            repository.createShared(space, {
                invitationId,
                tokenHash: generated.tokenHash,
            }),
        );
        return { space, invitationId, ...generated };
    }

    async function state(spaceId: SpaceId) {
        const rows = await db.query(
            `SELECT s.version,
                (SELECT count(*)::int FROM space_members WHERE space_id = s.id) AS members,
                (SELECT count(*)::int FROM space_command_receipts WHERE result_space_id = s.id) AS receipts,
                i.status AS "invitationStatus", i.resolved_at AS "resolvedAt", i.token_hash AS hash
             FROM spaces s JOIN space_invitations i ON i.space_id = s.id
             WHERE s.id = $1 ORDER BY i.issued_at, i.id`,
            [spaceId.value],
        );
        return rows[0];
    }

    async function resolve(decision: 'ACCEPT' | 'REJECT') {
        const input = await persist(await createPerson());
        const actorId = await createPerson();
        const command: RespondToInvitationCommand = {
            operation: 'RESPOND_INVITATION',
            actorId,
            key: randomUUID(),
            tokenHash: input.tokenHash,
            decision,
            expectedVersion: 1,
        };
        const target = await repository.findByInvitationTokenHash(
            input.tokenHash,
        );
        expect(target?.invitationId.equals(input.invitationId)).toBe(true);
        const space = target!.space;
        const memberId = decision === 'ACCEPT' ? MemberId.create() : null;
        if (memberId) {
            space.acceptInvitation(actorId, input.invitationId, memberId, now);
        } else {
            space.rejectInvitation(actorId, input.invitationId, now);
        }
        return {
            input,
            actorId,
            command,
            space,
            response: { invitationId: input.invitationId, memberId },
        };
    }

    async function write(f: Awaited<ReturnType<typeof resolve>>) {
        await repository.saveInvitationResponse(f.space, 1, f.response);
        await receipts.save(f.command, {
            resultSpaceId: f.space.id,
            resultInvitationId: f.input.invitationId,
            createdAt: now,
        });
    }

    it('preserva agregado e recibos do CARD-002 no upgrade', () => {
        expect(upgradeVerified).toBe(true);
    });

    it.each(['ACCEPT', 'REJECT'] as const)(
        'persiste %s e recibo atomicamente sem alterar hash',
        async (decision) => {
            const f = await resolve(decision);
            await uow.execute(() => write(f));
            expect(await state(f.space.id)).toMatchObject({
                version: 2,
                invitationStatus:
                    decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
                resolvedAt: now,
                members: decision === 'ACCEPT' ? 2 : 1,
                receipts: 1,
                hash: Buffer.from(f.input.tokenHash),
            });
            expect(await receipts.find(f.command)).not.toBeNull();
            const target = await repository.findByInvitationTokenHash(
                tokens.hash(f.input.token),
            );
            expect(target?.invitationId.equals(f.input.invitationId)).toBe(
                true,
            );
            expect(target?.space.invitations[0].status).toBe(
                decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
            );
            const stored = await db.query(
                'SELECT * FROM space_command_receipts',
            );
            expect(stored[0].request_hash).toHaveLength(32);
            expect(JSON.stringify(stored)).not.toContain(f.input.token);
        },
    );

    it('não escreve resposta fora da transação', async () => {
        const f = await resolve('ACCEPT');
        await expect(write(f)).rejects.toThrow(
            'Shared-space writes require a transaction',
        );
        expect(await state(f.space.id)).toMatchObject({
            version: 1,
            members: 1,
            receipts: 0,
            invitationStatus: 'PENDING',
        });
    });

    it.each(['ACCEPT', 'REJECT'] as const)(
        'reverte %s quando uma etapa posterior falha',
        async (decision) => {
            const f = await resolve(decision);
            await expect(
                uow.execute(async () => {
                    await write(f);
                    throw new Error('Injected failure');
                }),
            ).rejects.toThrow('Injected failure');
            expect(await state(f.space.id)).toMatchObject({
                version: 1,
                members: 1,
                receipts: 0,
                invitationStatus: 'PENDING',
                resolvedAt: null,
            });
        },
    );

    it('reverte raiz e convite quando o insert do membro falha', async () => {
        const input = await persist(await createPerson());
        const space = (await repository.findByInvitationTokenHash(
            input.tokenHash,
        ))!.space;
        const memberId = MemberId.create();
        space.acceptInvitation(
            PersonId.create(),
            input.invitationId,
            memberId,
            now,
        );
        await expect(
            uow.execute(() =>
                repository.saveInvitationResponse(space, 1, {
                    invitationId: input.invitationId,
                    memberId,
                }),
            ),
        ).rejects.toMatchObject({
            driverError: { code: '23503' },
        });
        expect(await state(space.id)).toMatchObject({
            version: 1,
            members: 1,
            receipts: 0,
            invitationStatus: 'PENDING',
            resolvedAt: null,
        });
    });

    it('reverte raiz, convite e membro quando o recibo falha', async () => {
        const f = await resolve('ACCEPT');
        f.command = { ...f.command, actorId: PersonId.create() };
        await expect(uow.execute(() => write(f))).rejects.toMatchObject({
            driverError: { code: '23503' },
        });
        expect(await state(f.space.id)).toMatchObject({
            version: 1,
            members: 1,
            receipts: 0,
            invitationStatus: 'PENDING',
        });
    });

    it('reverte o CAS se o convite persistido já não está pendente', async () => {
        const f = await resolve('REJECT');
        await db.query(
            "UPDATE space_invitations SET status = 'REJECTED', resolved_at = $1 WHERE id = $2",
            [now, f.input.invitationId.value],
        );
        await expect(uow.execute(() => write(f))).rejects.toBeInstanceOf(
            ConcurrentModificationError,
        );
        expect(await state(f.space.id)).toMatchObject({
            version: 1,
            members: 1,
            receipts: 0,
            invitationStatus: 'REJECTED',
        });
    });

    it('resolve o convite exato, inclusive cancelado, sem trocar pelo mais recente', async () => {
        const input = await persist(await createPerson());
        const creator = input.space.createdByPersonId!;
        const nextId = InvitationId.create();
        const nextToken = tokens.generate();
        input.space.replaceInvitation(creator, input.invitationId, nextId, now);
        await uow.execute(() =>
            repository.saveInvitationChange(input.space, 1, {
                invitationId: nextId,
                tokenHash: nextToken.tokenHash,
            }),
        );
        const old = await repository.findByInvitationTokenHash(input.tokenHash);
        const current = await repository.findByInvitationTokenHash(
            nextToken.tokenHash,
        );
        expect(old?.invitationId.value).toBe(input.invitationId.value);
        expect(old?.space.invitations).toHaveLength(1);
        expect(old?.space.invitations[0].status).toBe('CANCELLED');
        expect(current?.invitationId.value).toBe(nextId.value);
        expect(current?.space.invitations[0].status).toBe('PENDING');
        expect(
            await repository.findByInvitationTokenHash(
                tokens.generate().tokenHash,
            ),
        ).toBeNull();
        await expect(
            repository.findByInvitationTokenHash(new Uint8Array(31)),
        ).rejects.toThrow('Expected an invitation token hash');
    });

    it.each(['decision', 'tokenHash', 'expectedVersion'] as const)(
        'hash do recibo detecta mudança de %s',
        async (field) => {
            const f = await resolve('REJECT');
            await uow.execute(() => write(f));
            const changed = { ...f.command };
            if (field === 'decision') changed.decision = 'ACCEPT';
            if (field === 'tokenHash')
                changed.tokenHash = tokens.generate().tokenHash;
            if (field === 'expectedVersion') changed.expectedVersion = 2;
            await expect(receipts.find(changed)).rejects.toBeInstanceOf(
                IdempotencyKeyReusedError,
            );
            expect(
                await receipts.find({
                    ...f.command,
                    actorId: await createPerson(),
                }),
            ).toBeNull();
        },
    );

    it.each([
        'accept-accept',
        'accept-reject',
        'accept-replace',
        'reject-replace',
    ] as const)('CAS arbitra a corrida %s', async (race) => {
        const input = await persist(await createPerson());
        const first = (await repository.findByInvitationTokenHash(
            input.tokenHash,
        ))!.space;
        const second = (await repository.findByInvitationTokenHash(
            input.tokenHash,
        ))!.space;
        const firstMember = race.startsWith('accept')
            ? MemberId.create()
            : null;
        if (firstMember)
            first.acceptInvitation(
                await createPerson(),
                input.invitationId,
                firstMember,
                now,
            );
        else
            first.rejectInvitation(
                await createPerson(),
                input.invitationId,
                now,
            );
        const firstWrite = () =>
            repository.saveInvitationResponse(first, 1, {
                invitationId: input.invitationId,
                memberId: firstMember,
            });
        let secondWrite: () => Promise<void>;
        if (race.endsWith('replace')) {
            const nextId = InvitationId.create();
            second.replaceInvitation(
                input.space.createdByPersonId!,
                input.invitationId,
                nextId,
                now,
            );
            secondWrite = () =>
                repository.saveInvitationChange(second, 1, {
                    invitationId: nextId,
                    tokenHash: tokens.generate().tokenHash,
                });
        } else {
            const memberId = race.endsWith('accept') ? MemberId.create() : null;
            if (memberId)
                second.acceptInvitation(
                    await createPerson(),
                    input.invitationId,
                    memberId,
                    now,
                );
            else
                second.rejectInvitation(
                    await createPerson(),
                    input.invitationId,
                    now,
                );
            secondWrite = () =>
                repository.saveInvitationResponse(second, 1, {
                    invitationId: input.invitationId,
                    memberId,
                });
        }
        const results = await Promise.allSettled([
            uow.execute(firstWrite),
            uow.execute(secondWrite),
        ]);
        expect(
            results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        const failure = results.find((result) => result.status === 'rejected');
        expect(failure?.reason).toBeInstanceOf(ConcurrentModificationError);
        expect((await state(input.space.id)).version).toBe(2);
        const rows = await db.query(
            'SELECT count(*)::int AS total FROM space_members WHERE space_id = $1',
            [input.space.id.value],
        );
        expect(rows[0].total).toBeLessThanOrEqual(2);
    });

    it('migration down/up preserva recibos antigos', async () => {
        const input = await persist(await createPerson());
        const command: SpaceCommand = {
            operation: 'CREATE_SPACE',
            actorId: input.space.createdByPersonId!,
            key: randomUUID(),
            name: 'Casa',
        };
        await uow.execute(() =>
            receipts.save(command, {
                resultSpaceId: input.space.id,
                resultInvitationId: input.invitationId,
                createdAt: now,
            }),
        );
        const migration = new Card003InvitationResponses1791585518092();
        await db.transaction(async (manager) =>
            migration.down(manager.queryRunner!),
        );
        await db.transaction(async (manager) =>
            migration.up(manager.queryRunner!),
        );
        expect(await receipts.find(command)).not.toBeNull();
    });

    it('rollback da migration recusa descartar recibos de respostas existentes', async () => {
        const f = await resolve('REJECT');
        await uow.execute(() => write(f));
        await expect(
            db.transaction(async (manager) =>
                new Card003InvitationResponses1791585518092().down(
                    manager.queryRunner!,
                ),
            ),
        ).rejects.toMatchObject({
            driverError: { code: '23514' },
        });
        expect(await receipts.find(f.command)).not.toBeNull();
        expect(await state(f.space.id)).toMatchObject({
            version: 2,
            receipts: 1,
            invitationStatus: 'REJECTED',
        });
    });

    function responseInput(
        input: Awaited<ReturnType<typeof persist>>,
        actorId: PersonId,
        decision: 'ACCEPT' | 'REJECT' = 'ACCEPT',
    ) {
        return {
            actorId,
            key: randomUUID(),
            token: input.token,
            decision,
            expectedVersion: 1,
        };
    }

    function holdBothReads() {
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
    }

    it('preview é somente leitura e não concede acesso ao destinatário', async () => {
        const input = await persist(await createPerson());
        const actor = await createPerson();
        const before = await state(input.space.id);
        expect(await preview.execute(actor, input.token)).toEqual({
            invitation: {
                id: input.invitationId.value,
                status: 'PENDING',
                expiresAt: input.space.invitations[0].expiresAt.toISOString(),
            },
            space: { id: input.space.id.value, label: 'Casa', version: 1 },
            invitedBy: { displayName: 'Pessoa de teste' },
            canRespond: true,
        });
        expect(await state(input.space.id)).toEqual(before);
        expect(await reads.findDetails(actor, input.space.id, now)).toBeNull();
        expect(await reads.listAccessible(actor)).toEqual([]);
        expect(
            (await preview.execute(input.space.createdByPersonId!, input.token))
                .canRespond,
        ).toBe(false);
    });

    it('preview não grava expiração e a decisão não reutiliza o instante da prévia', async () => {
        const input = await persist(await createPerson());
        const actor = await createPerson();
        const expiry = input.space.invitations[0].expiresAt;
        vi.setSystemTime(new Date(expiry.getTime() - 1));
        expect((await preview.execute(actor, input.token)).canRespond).toBe(
            true,
        );
        vi.setSystemTime(expiry);
        await expect(preview.execute(actor, input.token)).rejects.toMatchObject(
            { code: 'INVITATION_UNAVAILABLE' },
        );
        await expect(
            respond.execute(responseInput(input, actor)),
        ).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
        expect(await state(input.space.id)).toMatchObject({
            version: 1,
            members: 1,
            receipts: 0,
            invitationStatus: 'PENDING',
        });
    });

    it.each(['ACCEPT', 'REJECT'] as const)(
        'recupera resposta perdida de %s depois da expiração',
        async (decision) => {
            const input = await persist(await createPerson());
            const actor = await createPerson();
            const command = responseInput(input, actor, decision);
            const first = await respond.execute(command);
            const before = await state(input.space.id);
            vi.setSystemTime(
                new Date(input.space.invitations[0].expiresAt.getTime() + 1),
            );
            const replay = await respond.execute(command);
            expect(replay).toEqual({ ...first, replayed: true });
            expect(await state(input.space.id)).toEqual(before);
            expect(
                (await reads.findDetails(actor, input.space.id, new Date())) ===
                    null,
            ).toBe(decision === 'REJECT');
            if (decision === 'ACCEPT') {
                const details = await reads.findDetails(
                    actor,
                    input.space.id,
                    new Date(),
                );
                expect(details).toMatchObject({
                    activeMemberCount: 2,
                    invitation: null,
                    actorMembership: first.actorMembership,
                });
            }
            await expect(
                respond.execute({ ...command, actorId: await createPerson() }),
            ).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
        },
    );

    it('recusa recupera o convite exato mesmo depois de nova emissão', async () => {
        const input = await persist(await createPerson());
        const command = responseInput(input, await createPerson(), 'REJECT');
        const first = await respond.execute(command);
        const root = (await repository.findById(input.space.id))!;
        const nextId = InvitationId.create();
        root.issueInvitation(
            root.createdByPersonId!,
            nextId,
            new Date(now.getTime() + 1),
        );
        await uow.execute(() =>
            repository.saveInvitationChange(root, 2, {
                invitationId: nextId,
                tokenHash: tokens.generate().tokenHash,
            }),
        );
        expect(await respond.execute(command)).toEqual({
            ...first,
            replayed: true,
        });
        expect((await repository.findById(input.space.id))?.version).toBe(3);
        expect(first.actorMembership).toBeNull();
    });

    it.each(['decision', 'token', 'expectedVersion'] as const)(
        'handler detecta reutilização da chave mudando %s',
        async (field) => {
            const input = await persist(await createPerson());
            const command = responseInput(
                input,
                await createPerson(),
                'REJECT',
            );
            await respond.execute(command);
            const changed = { ...command };
            if (field === 'decision') changed.decision = 'ACCEPT';
            if (field === 'token') changed.token = tokens.generate().token;
            if (field === 'expectedVersion') changed.expectedVersion = 2;
            await expect(respond.execute(changed)).rejects.toBeInstanceOf(
                IdempotencyKeyReusedError,
            );
            expect(await state(input.space.id)).toMatchObject({
                version: 2,
                members: 1,
                receipts: 1,
            });
        },
    );

    it('duas execuções concorrentes da mesma chave recuperam um único resultado', async () => {
        const input = await persist(await createPerson());
        const command = responseInput(input, await createPerson());
        holdBothReads();
        const results = await Promise.all([
            respond.execute(command),
            respond.execute(command),
        ]);
        expect(results.map((result) => result.replayed).sort()).toEqual([
            false,
            true,
        ]);
        expect(results[0].actorMembership).toEqual(results[1].actorMembership);
        expect(await state(input.space.id)).toMatchObject({
            version: 2,
            members: 2,
            receipts: 1,
            invitationStatus: 'ACCEPTED',
        });
    });

    it.each(['ACCEPT', 'REJECT'] as const)(
        'handler arbitra aceite contra %s de outro ator',
        async (decision) => {
            const input = await persist(await createPerson());
            const first = responseInput(input, await createPerson());
            const second = responseInput(input, await createPerson(), decision);
            holdBothReads();
            const results = await Promise.allSettled([
                respond.execute(first),
                respond.execute(second),
            ]);
            expect(
                results.filter((result) => result.status === 'fulfilled'),
            ).toHaveLength(1);
            expect(
                results.find((result) => result.status === 'rejected')?.reason,
            ).toBeInstanceOf(ConcurrentModificationError);
            expect(await state(input.space.id)).toMatchObject({
                version: 2,
                receipts: 1,
            });
        },
    );

    it('resultado recuperado exige ator, token, recibo e convite correspondentes', async () => {
        const input = await persist(await createPerson());
        const actorId = await createPerson();
        const request = responseInput(input, actorId, 'REJECT');
        await respond.execute(request);
        const command: RespondToInvitationCommand = {
            operation: 'RESPOND_INVITATION',
            actorId,
            key: request.key,
            tokenHash: input.tokenHash,
            decision: 'REJECT',
            expectedVersion: 1,
        };
        const receipt = (await receipts.find(command))!;
        expect(
            await reads.findInvitationResponseResult(command, receipt),
        ).not.toBeNull();
        expect(
            await reads.findInvitationResponseResult(
                { ...command, actorId: await createPerson() },
                receipt,
            ),
        ).toBeNull();
        expect(
            await reads.findInvitationResponseResult(
                { ...command, tokenHash: tokens.generate().tokenHash },
                receipt,
            ),
        ).toBeNull();
        expect(
            await reads.findInvitationResponseResult(
                { ...command, key: randomUUID() },
                receipt,
            ),
        ).toBeNull();
        expect(
            await reads.findInvitationResponseResult(command, {
                ...receipt,
                resultInvitationId: InvitationId.create(),
            }),
        ).toBeNull();
    });

    it('replay de aceite revalida membership ativo', async () => {
        const input = await persist(await createPerson());
        const command = responseInput(input, await createPerson());
        const first = await respond.execute(command);
        await db.query('DELETE FROM space_members WHERE id = $1', [
            first.actorMembership!.id,
        ]);
        await expect(respond.execute(command)).rejects.toMatchObject({
            code: 'INVITATION_UNAVAILABLE',
        });
        expect(await state(input.space.id)).toMatchObject({
            version: 2,
            receipts: 1,
            members: 1,
        });
    });

    it('handler não confirma a decisão se o recibo falhar; transação reverte tudo', async () => {
        const input = await persist(await createPerson());
        vi.spyOn(receipts, 'save').mockRejectedValueOnce(
            new Error('Injected receipt failure'),
        );
        await expect(
            respond.execute(responseInput(input, await createPerson())),
        ).rejects.toThrow('Injected receipt failure');
        expect(await state(input.space.id)).toMatchObject({
            version: 1,
            members: 1,
            receipts: 0,
            invitationStatus: 'PENDING',
        });
    });
});
