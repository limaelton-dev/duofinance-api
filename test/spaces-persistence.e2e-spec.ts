import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from './setup-env.js';
import migrationDataSource from '../dist/shared/technical/database/typeorm/data-source.js';
import { InitialCard0011789556956788 } from '../dist/shared/technical/database/typeorm/migrations/1789556956788-InitialCard001.js';
import { TransactionContext } from '../dist/shared/technical/database/typeorm/transaction-context.js';
import { EntityManagerProvider } from '../dist/shared/technical/database/typeorm/entity-manager.provider.js';
import { TypeOrmUnitOfWork } from '../dist/shared/technical/database/typeorm/typeorm-unit-of-work.js';
import { TypeOrmSpaceRepository } from '../dist/modules/spaces/infrastructure/typeorm/repositories/typeorm-space.repository.js';
import { TypeOrmSpaceCommandReceipts } from '../dist/modules/spaces/infrastructure/typeorm/repositories/typeorm-space-command-receipts.js';
import { NodeInvitationTokenGenerator } from '../dist/modules/spaces/infrastructure/security/node-invitation-token-generator.js';
import { SpaceMemberOrmEntity } from '../dist/modules/spaces/infrastructure/typeorm/entities/space-member.orm-entity.js';
import { SpaceInvitationOrmEntity } from '../dist/modules/spaces/infrastructure/typeorm/entities/space-invitation.orm-entity.js';
import { PersonOrmEntity } from '../dist/modules/spaces/infrastructure/typeorm/entities/person.orm-entity.js';
import { ConcurrentModificationError } from '../dist/modules/spaces/application/errors/concurrent-modification.error.js';
import { IdempotencyKeyReusedError } from '../dist/modules/spaces/application/errors/idempotency-key-reused.error.js';
import { SpaceCommandReceiptConflictError } from '../dist/modules/spaces/application/errors/space-command-receipt-conflict.error.js';
import type { SpaceCommand } from '../dist/modules/spaces/application/ports/private/space-command-receipts.js';
import { PersonId } from '../dist/modules/spaces/domain/person/person-id.js';
import { SpaceId } from '../dist/modules/spaces/domain/space/space-id.js';
import { Space, SpaceType } from '../dist/modules/spaces/domain/space/space.js';
import { MemberId } from '../dist/modules/spaces/domain/member/member-id.js';
import { InvitationId } from '../dist/modules/spaces/domain/invitation/invitation-id.js';
import { InvitationStatus } from '../dist/modules/spaces/domain/invitation/invitation.js';
import { SpaceOrmEntity } from '../dist/modules/spaces/infrastructure/typeorm/entities/space.orm-entity.js';
import { SpaceCommandReceiptOrmEntity } from '../dist/modules/spaces/infrastructure/typeorm/entities/space-command-receipt.orm-entity.js';
import { AuthCredentialOrmEntity } from '../dist/modules/identity/infrastructure/typeorm/entities/auth-credential.orm-entity.js';
import { AuthSessionOrmEntity } from '../dist/modules/identity/infrastructure/typeorm/entities/auth-session.orm-entity.js';
import { ConfigService } from '@nestjs/config';
import { SpaceInvitationCommandService } from '../dist/modules/spaces/application/services/space-invitation-command.service.js';
import { CreateSharedSpaceHandler } from '../dist/modules/spaces/application/handlers/create-shared-space.handler.js';
import { IssueSpaceInvitationHandler } from '../dist/modules/spaces/application/handlers/issue-space-invitation.handler.js';
import { ReplaceSpaceInvitationHandler } from '../dist/modules/spaces/application/handlers/replace-space-invitation.handler.js';
import { ListAccessibleSpacesQuery } from '../dist/modules/spaces/application/queries/list-accessible-spaces.query.js';
import { GetSpaceDetailsQuery } from '../dist/modules/spaces/application/queries/get-space-details.query.js';
import { TypeOrmSpaceReadQueries } from '../dist/modules/spaces/infrastructure/typeorm/queries/typeorm-space-read-queries.js';
import { TypeOrmSpaceAccessQueries } from '../dist/modules/spaces/infrastructure/typeorm/queries/typeorm-space-access-queries.js';
import { SpaceAccessService } from '../dist/modules/spaces/application/services/space-access.service.js';

const now = new Date('2026-09-28T12:00:00.000Z');

describe('CARD-002 — persistência PostgreSQL', () => {
    let db: DataSource;
    let repository: TypeOrmSpaceRepository;
    let receipts: TypeOrmSpaceCommandReceipts;
    let uow: TypeOrmUnitOfWork;
    let reads: TypeOrmSpaceReadQueries;
    let createSpace: CreateSharedSpaceHandler;
    let issueInvitation: IssueSpaceInvitationHandler;
    let replaceInvitation: ReplaceSpaceInvitationHandler;
    let listSpaces: ListAccessibleSpacesQuery;
    let getDetails: GetSpaceDetailsQuery;
    let upgradeVerified = false;

    const tokens = new NodeInvitationTokenGenerator();

    beforeAll(async () => {
        if (
            process.env.NODE_ENV !== 'test' ||
            migrationDataSource.options.type !== 'postgres' ||
            migrationDataSource.options.url !== TEST_DATABASE_URL
        ) {
            throw new Error('Expected the isolated test database');
        }

        const initial = new DataSource({
            type: 'postgres',
            url: TEST_DATABASE_URL,
            synchronize: false,
            migrations: [InitialCard0011789556956788],
        });

        const personId = randomUUID();
        const spaceId = randomUUID();

        await initial.initialize();

        try {
            await initial.dropDatabase();
            await initial.runMigrations();

            await initial.query(
                `INSERT INTO persons
                    (id, display_name, version, created_at)
                 VALUES ($1, 'Pessoa anterior', 1, $2)`,
                [personId, now],
            );

            await initial.query(
                `INSERT INTO spaces
                    (id, type, status, personal_owner_person_id,
                     version, created_at, updated_at)
                 VALUES ($1, 'PERSONAL', 'ACTIVE', $2, 1, $3, $3)`,
                [spaceId, personId, now],
            );
        } finally {
            await initial.destroy();
        }

        db = new DataSource({
            ...migrationDataSource.options,
            entities: [
                PersonOrmEntity,
                SpaceOrmEntity,
                SpaceMemberOrmEntity,
                SpaceInvitationOrmEntity,
                SpaceCommandReceiptOrmEntity,
                AuthCredentialOrmEntity,
                AuthSessionOrmEntity,
            ],
        });

        await db.initialize();

        const applied = await db.runMigrations();

        expect(applied.map((migration) => migration.name)).toEqual([
            expect.stringMatching(/^Card002SharedSpaces\d+$/),
            expect.stringMatching(/^Card003InvitationResponses\d+$/),
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
        ]);

        const context = new TransactionContext();
        const managerProvider = new EntityManagerProvider(db, context);

        repository = new TypeOrmSpaceRepository(managerProvider);
        receipts = new TypeOrmSpaceCommandReceipts(managerProvider);
        uow = new TypeOrmUnitOfWork(db, context);
        reads = new TypeOrmSpaceReadQueries(managerProvider);
        const access = new SpaceAccessService(
            new TypeOrmSpaceAccessQueries(managerProvider),
        );

        const commands = new SpaceInvitationCommandService(
            uow,
            repository,
            receipts,
            tokens,
            reads,
            new ConfigService({ WEB_ORIGIN: 'https://app.example.com' }),
            access,
        );

        createSpace = new CreateSharedSpaceHandler(commands);
        issueInvitation = new IssueSpaceInvitationHandler(commands);
        replaceInvitation = new ReplaceSpaceInvitationHandler(commands);
        listSpaces = new ListAccessibleSpacesQuery(reads);
        getDetails = new GetSpaceDetailsQuery(reads, access);

        const personal = await repository.findPersonalByOwnerPersonId(
            PersonId.from(personId),
        );

        expect(personal?.id.value).toBe(spaceId);
        expect(personal?.type).toBe(SpaceType.PERSONAL);
        expect(personal?.version).toBe(1);
        upgradeVerified = true;
    });

    beforeEach(async () => {
        await db.query(`
            TRUNCATE TABLE
                space_command_receipts,
                space_invitations,
                space_members,
                auth_sessions,
                auth_credentials,
                spaces,
                persons CASCADE
        `);
    });

    afterAll(async () => {
        if (db?.isInitialized) {
            await db.destroy();
        }
    });

    async function createPerson(): Promise<PersonId> {
        const id = PersonId.create();

        await db.getRepository(PersonOrmEntity).insert({
            id: id.value,
            displayName: 'Pessoa de teste',
            version: 1,
            createdAt: now,
        });

        return id;
    }

    function aggregate(actorId: PersonId) {
        const invitationId = InvitationId.create();
        const generated = tokens.generate();
        const space = Space.createShared({
            id: SpaceId.create(),
            name: 'Casa',
            createdByPersonId: actorId,
            creatorMemberId: MemberId.create(),
            invitationId,
            now,
        });

        return {
            space,
            invitationId,
            token: generated.token,
            tokenHash: generated.tokenHash,
        };
    }

    async function persist(actorId: PersonId) {
        const input = aggregate(actorId);

        await uow.execute(() =>
            repository.createShared(input.space, {
                invitationId: input.invitationId,
                tokenHash: input.tokenHash,
            }),
        );

        return input;
    }

    async function counts(): Promise<number[]> {
        const rows: {
            spaces: number;
            members: number;
            invitations: number;
            receipts: number;
        }[] = await db.query(`
            SELECT
                (SELECT count(*)::int FROM spaces) AS spaces,
                (SELECT count(*)::int FROM space_members) AS members,
                (SELECT count(*)::int FROM space_invitations) AS invitations,
                (SELECT count(*)::int FROM space_command_receipts) AS receipts
        `);

        const result = rows[0];

        return [
            result.spaces,
            result.members,
            result.invitations,
            result.receipts,
        ];
    }

    it('preserva o espaço pessoal durante o upgrade', () => {
        expect(upgradeVerified).toBe(true);
    });

    it('persiste o agregado e somente o hash do token', async () => {
        const actorId = await createPerson();
        const input = await persist(actorId);
        const restored = await repository.findById(input.space.id);

        expect(restored?.name).toBe('Casa');
        expect(restored?.members).toHaveLength(1);
        expect(restored?.invitations).toHaveLength(1);
        expect(restored?.invitations[0].id.value).toBe(
            input.invitationId.value,
        );
        expect(await counts()).toEqual([1, 1, 1, 0]);

        const rows = await db.query(
            'SELECT * FROM space_invitations WHERE id = $1',
            [input.invitationId.value],
        );

        expect(rows[0].token_hash).toEqual(Buffer.from(input.tokenHash));
        expect(JSON.stringify(rows)).not.toContain(input.token);
        expect(rows[0]).not.toHaveProperty('token');
        expect(rows[0]).not.toHaveProperty('invite_url');
    });

    it('recusa escrita compartilhada fora da transação', async () => {
        const actorId = await createPerson();
        const input = aggregate(actorId);

        await expect(
            repository.createShared(input.space, input),
        ).rejects.toThrow('Shared-space writes require a transaction');

        expect(await counts()).toEqual([0, 0, 0, 0]);
    });

    it('reverte espaço, filhos e recibo quando a operação falha', async () => {
        const actorId = await createPerson();
        const input = aggregate(actorId);
        const command: SpaceCommand = {
            actorId,
            operation: 'CREATE_SPACE',
            key: randomUUID(),
            name: 'Casa',
        };

        await expect(
            uow.execute(async () => {
                await repository.createShared(input.space, input);
                await receipts.save(command, {
                    resultSpaceId: input.space.id,
                    resultInvitationId: input.invitationId,
                    createdAt: now,
                });

                throw new Error('Injected failure');
            }),
        ).rejects.toThrow('Injected failure');

        expect(await counts()).toEqual([0, 0, 0, 0]);
        expect(await receipts.find(command)).toBeNull();
    });

    it('substitui e conserva o histórico sem carregar tudo na leitura', async () => {
        const actorId = await createPerson();
        const input = await persist(actorId);
        const space = await repository.findById(input.space.id);

        if (!space) {
            throw new Error('Expected persisted space');
        }

        const nextId = InvitationId.create();
        const generated = tokens.generate();

        space.replaceInvitation(
            actorId,
            input.invitationId,
            nextId,
            new Date(now.getTime() + 1000),
        );

        await uow.execute(() =>
            repository.saveInvitationChange(space, 1, {
                invitationId: nextId,
                tokenHash: generated.tokenHash,
            }),
        );

        const oldRows = await db.query(
            'SELECT * FROM space_invitations WHERE id = $1',
            [input.invitationId.value],
        );

        expect(oldRows[0].status).toBe('CANCELLED');
        expect(oldRows[0].cancellation_reason).toBe('REPLACED');
        expect(oldRows[0].replaced_by_invitation_id).toBe(nextId.value);

        const restored = await repository.findById(space.id);

        expect(restored?.version).toBe(2);
        expect(restored?.invitations).toHaveLength(1);
        expect(restored?.invitations[0].id.value).toBe(nextId.value);
        expect(await counts()).toEqual([1, 1, 2, 0]);
    });

    it('reverte o cancelamento se a inserção do novo convite falhar', async () => {
        const actorId = await createPerson();
        const input = await persist(actorId);
        const space = await repository.findById(input.space.id);

        if (!space) {
            throw new Error('Expected persisted space');
        }

        const nextId = InvitationId.create();

        space.replaceInvitation(actorId, input.invitationId, nextId, now);

        await expect(
            uow.execute(() =>
                repository.saveInvitationChange(space, 1, {
                    invitationId: nextId,
                    tokenHash: input.tokenHash,
                }),
            ),
        ).rejects.toMatchObject({
            driverError: {
                code: '23505',
                constraint: 'UQ_space_invitations_token_hash',
            },
        });

        const restored = await repository.findById(space.id);

        expect(restored?.version).toBe(1);
        expect(restored?.invitations[0].status).toBe(InvitationStatus.PENDING);
        expect(restored?.invitations[0].replacedByInvitationId).toBeNull();
        expect(await counts()).toEqual([1, 1, 1, 0]);
    });

    it('permite somente uma alteração concorrente da mesma versão', async () => {
        const actorId = await createPerson();
        const input = await persist(actorId);
        const first = await repository.findById(input.space.id);
        const second = await repository.findById(input.space.id);

        if (!first || !second) {
            throw new Error('Expected two aggregate snapshots');
        }

        const firstId = InvitationId.create();
        const secondId = InvitationId.create();

        first.replaceInvitation(actorId, input.invitationId, firstId, now);
        second.replaceInvitation(actorId, input.invitationId, secondId, now);

        const results = await Promise.allSettled([
            uow.execute(() =>
                repository.saveInvitationChange(first, 1, {
                    invitationId: firstId,
                    tokenHash: tokens.generate().tokenHash,
                }),
            ),
            uow.execute(() =>
                repository.saveInvitationChange(second, 1, {
                    invitationId: secondId,
                    tokenHash: tokens.generate().tokenHash,
                }),
            ),
        ]);

        expect(
            results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);

        const rejected = results.find((result) => result.status === 'rejected');

        expect(rejected?.reason).toBeInstanceOf(ConcurrentModificationError);
        expect(await counts()).toEqual([1, 1, 2, 0]);

        const restored = await repository.findById(input.space.id);
        expect(restored?.version).toBe(2);
    });

    it('o banco impede duplicidade de pessoa, slot inválido e terceiro membro', async () => {
        const actorId = await createPerson();
        const input = await persist(actorId);
        const memberRepository = db.getRepository(SpaceMemberOrmEntity);

        const member = {
            id: randomUUID(),
            spaceId: input.space.id.value,
            personId: actorId.value,
            status: 'ACTIVE',
            slot: 2,
            joinedAt: now,
        };

        await expect(memberRepository.insert(member)).rejects.toMatchObject({
            driverError: {
                code: '23505',
                constraint: 'UQ_space_members_active_person',
            },
        });

        const secondPerson = await createPerson();

        await expect(
            memberRepository.insert({
                ...member,
                personId: secondPerson.value,
                slot: 3,
            }),
        ).rejects.toMatchObject({
            driverError: {
                code: '23514',
                constraint: 'CHK_space_members_slot',
            },
        });

        await memberRepository.insert({
            ...member,
            personId: secondPerson.value,
        });

        const thirdPerson = await createPerson();

        await expect(
            memberRepository.insert({
                ...member,
                id: randomUUID(),
                personId: thirdPerson.value,
            }),
        ).rejects.toMatchObject({
            driverError: {
                code: '23505',
                constraint: 'UQ_space_members_active_slot',
            },
        });
    });

    it('o banco impede dois pendentes e hash de tamanho inválido', async () => {
        const actorId = await createPerson();
        const input = await persist(actorId);
        const invitationRepository = db.getRepository(SpaceInvitationOrmEntity);
        const original = await invitationRepository.findOneByOrFail({
            id: input.invitationId.value,
        });

        await expect(
            invitationRepository.insert({
                ...original,
                id: randomUUID(),
                tokenHash: Buffer.from(tokens.generate().tokenHash),
            }),
        ).rejects.toMatchObject({
            driverError: {
                code: '23505',
                constraint: 'UQ_space_invitations_pending',
            },
        });

        await expect(
            invitationRepository.insert({
                ...original,
                id: randomUUID(),
                status: 'REJECTED',
                resolvedAt: now,
                tokenHash: Buffer.alloc(31),
            }),
        ).rejects.toMatchObject({
            driverError: {
                code: '23514',
                constraint: 'CHK_space_invitations_hash',
            },
        });
    });

    it('converge recibos concorrentes e rejeita outra entrada', async () => {
        const actorId = await createPerson();
        const command: SpaceCommand = {
            actorId,
            operation: 'CREATE_SPACE',
            key: randomUUID(),
            name: 'Casa',
        };

        async function attempt() {
            try {
                return await uow.execute(async () => {
                    const previous = await receipts.find(command);

                    if (previous) {
                        return previous;
                    }

                    const input = aggregate(actorId);
                    await repository.createShared(input.space, input);

                    const receipt = {
                        resultSpaceId: input.space.id,
                        resultInvitationId: input.invitationId,
                        createdAt: now,
                    };

                    await receipts.save(command, receipt);
                    return receipt;
                });
            } catch (error) {
                if (!(error instanceof SpaceCommandReceiptConflictError)) {
                    throw error;
                }

                const winner = await receipts.find(command);

                if (!winner) {
                    throw error;
                }

                return winner;
            }
        }

        const [first, second] = await Promise.all([attempt(), attempt()]);

        expect(first.resultSpaceId.value).toBe(second.resultSpaceId.value);
        expect(first.resultInvitationId.value).toBe(
            second.resultInvitationId.value,
        );
        expect(await counts()).toEqual([1, 1, 1, 1]);

        const normalized = await receipts.find({
            ...command,
            name: '  Casa  ',
        });

        expect(normalized?.resultSpaceId.value).toBe(first.resultSpaceId.value);

        await expect(
            receipts.find({ ...command, name: 'Outra casa' }),
        ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);

        const otherActor = await createPerson();

        expect(
            await receipts.find({ ...command, actorId: otherActor }),
        ).toBeNull();

        const stored = await db.query('SELECT * FROM space_command_receipts');

        expect(Object.keys(stored[0]).sort()).toEqual([
            'actor_id',
            'created_at',
            'key',
            'operation',
            'request_hash',
            'result_invitation_id',
            'result_space_id',
        ]);
        expect(stored[0].request_hash).toHaveLength(32);
    });

    it('os handlers convergem na criação concorrente e recuperam o convite original', async () => {
        const actorId = await createPerson();
        const input = {
            actorId,
            key: randomUUID(),
            name: 'Casa',
        };

        const results = await Promise.all([
            createSpace.execute(input),
            createSpace.execute(input),
        ]);

        expect(results[0].space.id).toBe(results[1].space.id);
        expect(results[0].invitation.id).toBe(results[1].invitation.id);
        expect(results.filter((result) => result.replayed)).toHaveLength(1);
        expect(await counts()).toEqual([1, 1, 1, 1]);

        const first = results.find((result) => !result.replayed);

        if (!first) {
            throw new Error('Expected one original emission');
        }

        await replaceInvitation.execute({
            actorId,
            key: randomUUID(),
            spaceId: SpaceId.from(first.space.id),
            invitationId: InvitationId.from(first.invitation.id),
            expectedVersion: 1,
        });

        const replay = await createSpace.execute(input);

        expect(replay.space.id).toBe(first.space.id);
        expect(replay.space.version).toBe(2);
        expect(replay.invitation.id).toBe(first.invitation.id);
        expect(replay.invitation.status).toBe('CANCELLED');
        expect(replay.inviteUrl).toBeNull();
        expect(replay.linkAvailable).toBe(false);
        expect(replay.replayed).toBe(true);
        expect(await counts()).toEqual([1, 1, 2, 2]);
    });

    it('a substituição concorrente com a mesma chave produz um único efeito', async () => {
        const actorId = await createPerson();
        const created = await createSpace.execute({
            actorId,
            key: randomUUID(),
            name: 'Casa',
        });

        const input = {
            actorId,
            key: randomUUID(),
            spaceId: SpaceId.from(created.space.id),
            invitationId: InvitationId.from(created.invitation.id),
            expectedVersion: 1,
        };

        const results = await Promise.all([
            replaceInvitation.execute(input),
            replaceInvitation.execute(input),
        ]);

        expect(results[0].invitation.id).toBe(results[1].invitation.id);
        expect(results.filter((result) => result.replayed)).toHaveLength(1);
        expect(results.filter((result) => result.linkAvailable)).toHaveLength(
            1,
        );
        expect(await counts()).toEqual([1, 1, 2, 2]);

        const replay = await replaceInvitation.execute(input);

        expect(replay.replayed).toBe(true);
        expect(replay.space.version).toBe(2);
        expect(replay.inviteUrl).toBeNull();
        expect(await counts()).toEqual([1, 1, 2, 2]);
    });

    it('o handler de emissão normaliza o convite expirado', async () => {
        const actorId = await createPerson();
        const issuedAt = new Date(Date.now() - 73 * 60 * 60 * 1000);
        const invitationId = InvitationId.create();
        const space = Space.createShared({
            id: SpaceId.create(),
            name: 'Casa',
            createdByPersonId: actorId,
            creatorMemberId: MemberId.create(),
            invitationId,
            now: issuedAt,
        });

        await uow.execute(() =>
            repository.createShared(space, {
                invitationId,
                tokenHash: tokens.generate().tokenHash,
            }),
        );

        const result = await issueInvitation.execute({
            actorId,
            key: randomUUID(),
            spaceId: space.id,
            expectedVersion: 1,
        });

        expect(result.space.version).toBe(2);
        expect(result.invitation.id).not.toBe(invitationId.value);
        expect(result.invitation.status).toBe('PENDING');

        const rows = await db.query(
            'SELECT status FROM space_invitations WHERE id = $1',
            [invitationId.value],
        );

        expect(rows[0].status).toBe('EXPIRED');
        expect(await counts()).toEqual([1, 1, 2, 1]);
    });

    it('o handler de criação reverte tudo se falhar após gravar o recibo', async () => {
        const actorId = await createPerson();
        const originalSave = receipts.save.bind(receipts);
        const failure = new Error('Failure after receipt');
        const spy = vi
            .spyOn(receipts, 'save')
            .mockImplementationOnce(async (command, receipt) => {
                await originalSave(command, receipt);
                throw failure;
            });

        try {
            await expect(
                createSpace.execute({
                    actorId,
                    key: randomUUID(),
                    name: 'Casa',
                }),
            ).rejects.toBe(failure);
        } finally {
            spy.mockRestore();
        }

        expect(await counts()).toEqual([0, 0, 0, 0]);
    });

    it('o handler de substituição preserva o anterior quando o recibo falha', async () => {
        const actorId = await createPerson();
        const created = await createSpace.execute({
            actorId,
            key: randomUUID(),
            name: 'Casa',
        });

        const failure = new Error('Receipt persistence failed');
        const spy = vi.spyOn(receipts, 'save').mockRejectedValueOnce(failure);

        try {
            await expect(
                replaceInvitation.execute({
                    actorId,
                    key: randomUUID(),
                    spaceId: SpaceId.from(created.space.id),
                    invitationId: InvitationId.from(created.invitation.id),
                    expectedVersion: 1,
                }),
            ).rejects.toBe(failure);
        } finally {
            spy.mockRestore();
        }

        const restored = await repository.findById(
            SpaceId.from(created.space.id),
        );

        expect(restored?.version).toBe(1);
        expect(restored?.invitations[0].status).toBe('PENDING');
        expect(restored?.invitations[0].replacedByInvitationId).toBeNull();
        expect(await counts()).toEqual([1, 1, 1, 1]);
    });

    it('as consultas isolam pessoas, ordenam espaços e ocultam segredos', async () => {
        const actorId = await createPerson();
        const otherActor = await createPerson();
        const personal = Space.createPersonal(SpaceId.create(), actorId);

        await uow.execute(() => repository.save(personal));

        const first = await createSpace.execute({
            actorId,
            key: randomUUID(),
            name: 'Casa A',
        });
        const second = await createSpace.execute({
            actorId,
            key: randomUUID(),
            name: 'Casa B',
        });

        const list = await listSpaces.execute(actorId);

        expect(list.items.map((item) => item.id)).toEqual([
            personal.id.value,
            first.space.id,
            second.space.id,
        ]);
        expect(await listSpaces.execute(otherActor)).toEqual({ items: [] });

        const personalDetails = await getDetails.execute(actorId, personal.id);

        expect(personalDetails.actorMembership).toBeNull();
        expect(personalDetails.activeMemberCount).toBe(0);
        expect(personalDetails.invitation).toBeNull();

        await expect(
            getDetails.execute(otherActor, SpaceId.from(first.space.id)),
        ).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });

        await expect(
            getDetails.execute(actorId, SpaceId.create()),
        ).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });

        const details = await getDetails.execute(
            actorId,
            SpaceId.from(first.space.id),
        );

        expect(details.invitation?.canReplace).toBe(true);
        expect(details.invitation?.canIssue).toBe(false);
        expect(details).not.toHaveProperty('inviteUrl');
        expect(JSON.stringify(details)).not.toContain('tokenHash');
        expect(JSON.stringify(details)).not.toContain('token_hash');

        await db.getRepository(SpaceMemberOrmEntity).insert({
            id: randomUUID(),
            spaceId: first.space.id,
            personId: otherActor.value,
            status: 'ACTIVE',
            slot: 2,
            joinedAt: new Date(),
        });

        const memberDetails = await getDetails.execute(
            otherActor,
            SpaceId.from(first.space.id),
        );

        expect(memberDetails.activeMemberCount).toBe(2);
        expect(memberDetails.invitation).toBeNull();

        const creatorDetails = await getDetails.execute(
            actorId,
            SpaceId.from(first.space.id),
        );

        expect(creatorDetails.invitation?.canIssue).toBe(false);
        expect(creatorDetails.invitation?.canReplace).toBe(false);

        expect(
            await reads.findInvitationResult(
                otherActor,
                SpaceId.from(first.space.id),
                InvitationId.from(first.invitation.id),
                new Date(),
            ),
        ).toBeNull();

        await expect(
            issueInvitation.execute({
                actorId: otherActor,
                key: randomUUID(),
                spaceId: SpaceId.from(first.space.id),
                expectedVersion: 1,
            }),
        ).rejects.toMatchObject({ code: 'INVITATION_ISSUER_REQUIRED' });
    });

    it('a consulta apresenta EXPIRED sem gravar a expiração', async () => {
        const actorId = await createPerson();
        const input = await persist(actorId);
        const expiration = input.space.invitations[0].expiresAt;

        const details = await reads.findDetails(
            actorId,
            input.space.id,
            expiration,
        );

        expect(details?.invitation?.status).toBe('EXPIRED');
        expect(details?.invitation?.canIssue).toBe(true);
        expect(details?.invitation?.canReplace).toBe(false);

        const restored = await repository.findById(input.space.id);

        expect(restored?.version).toBe(1);
        expect(restored?.invitations[0].status).toBe('PENDING');
    });
});
