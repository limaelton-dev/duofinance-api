import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
    beforeAll,
    beforeEach,
    afterEach,
    describe,
    it,
    expect,
    vi,
} from 'vitest';
import { TEST_DATABASE_URL } from './setup-env.js';
import { AppModule } from '../dist/app.module.js';
import migrationSource from '../dist/shared/technical/database/typeorm/data-source.js';
import { RecordPersonalExpenseHandler } from '../dist/modules/finances/application/handlers/record-personal-expense.handler.js';
import { RecordSharedCashExpenseHandler } from '../dist/modules/finances/application/handlers/record-shared-cash-expense.handler.js';
import { PersonId } from '../dist/modules/spaces/domain/person/person-id.js';
import { SpaceId } from '../dist/modules/spaces/domain/space/space-id.js';
import {
    FINANCES_CLOCK,
    FINANCIAL_COMMITMENT_REPOSITORY,
    type FinancialCommitmentRepository,
} from '../dist/modules/finances/application/ports/private/shared-expense.repositories.js';
import {
    PERSONAL_EXPENSE_RECEIPTS,
    type PersonalExpenseReceipts,
} from '../dist/modules/finances/application/ports/private/personal-expense.ports.js';
import type { RecordPersonalExpenseCommand } from '../dist/modules/finances/application/models/personal-expense.js';

describe('Personal expense transactional persistence', () => {
    let app: INestApplication,
        db: DataSource,
        handler: RecordPersonalExpenseHandler,
        actor: string,
        space: string;
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
                now: () => new Date('2026-10-14T15:00:00Z'),
                today: () => '2026-10-14',
            })
            .compile();
        app = module.createNestApplication();
        await app.init();
        db = app.get(DataSource);
        handler = app.get(RecordPersonalExpenseHandler);
        await db.query('TRUNCATE persons CASCADE');
        actor = randomUUID();
        space = randomUUID();
        await db.query(
            `INSERT INTO persons(id,display_name,version,created_at) VALUES($1,'Titular',1,now())`,
            [actor],
        );
        await db.query(
            `INSERT INTO spaces(id,type,status,personal_owner_person_id,created_by_person_id,version,created_at,updated_at) VALUES($1,'PERSONAL','ACTIVE',$2,NULL,1,now(),now())`,
            [space, actor],
        );
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await app?.close();
    });
    const command = (): RecordPersonalExpenseCommand => ({
        actorId: PersonId.from(actor),
        spaceId: SpaceId.from(space),
        idempotencyKey: randomUUID(),
        description: 'Consulta',
        amountInCents: 12000,
        factDate: '2026-10-14',
        disbursement: { method: 'PIX' },
    });
    it('scopes the same idempotency key to personal and shared expense operations', async () => {
        const otherActor = randomUUID();
        const sharedSpace = randomUUID();
        const member = randomUUID();
        const otherMember = randomUUID();
        const key = randomUUID();
        await db.query(
            `INSERT INTO persons(id,display_name,version,created_at) VALUES($1,'Participante',1,now())`,
            [otherActor],
        );
        await db.query(
            `INSERT INTO spaces(id,type,status,name,created_by_person_id,version,created_at,updated_at) VALUES($1,'SHARED','ACTIVE','Casa',$2,1,now(),now())`,
            [sharedSpace, actor],
        );
        await db.query(
            `INSERT INTO space_members(id,space_id,person_id,status,slot,joined_at) VALUES($1,$3,$4,'ACTIVE',1,now()),($2,$3,$5,'ACTIVE',2,now())`,
            [member, otherMember, sharedSpace, actor, otherActor],
        );
        const sharedInput = {
            actorId: PersonId.from(actor),
            spaceId: SpaceId.from(sharedSpace),
            idempotencyKey: key,
            expectedSpaceVersion: 1,
            description: 'Mercado',
            amountInCents: 12000,
            factDate: '2026-10-14',
            expectedPayerMemberId: member,
            responsibilitySplit: {
                mode: 'AMOUNTS' as const,
                shares: [
                    { memberId: member, amountInCents: 6000 },
                    { memberId: otherMember, amountInCents: 6000 },
                ],
            },
            disbursement: { payerMemberId: member, method: 'PIX' as const },
            settlement: { mode: 'NONE' as const },
        };
        const sharedHandler = app.get(RecordSharedCashExpenseHandler);
        const shared = await sharedHandler.execute(sharedInput);
        const personalInput = { ...command(), idempotencyKey: key };
        const personal = await handler.execute(personalInput);
        expect(personal.replayed).toBe(false);
        expect(personal.commitment.id).not.toBe(shared.commitment.id);
        expect(await sharedHandler.execute(sharedInput)).toEqual({
            ...shared,
            replayed: true,
        });
        expect(await handler.execute(personalInput)).toEqual({
            ...personal,
            replayed: true,
        });
        expect(
            await db.query(
                `SELECT operation FROM financial_expense_command_receipts WHERE actor_id=$1 AND idempotency_key=$2 ORDER BY operation`,
                [actor, key],
            ),
        ).toEqual([
            { operation: 'RECORD_PERSONAL_EXPENSE' },
            { operation: 'RECORD_SHARED_CASH_EXPENSE' },
        ]);
    });
    async function counts() {
        return (
            await db.query(
                `SELECT (SELECT count(*) FROM financial_commitments)::int AS commitments,(SELECT count(*) FROM financial_commitment_versions)::int AS versions,(SELECT count(*) FROM financial_disbursements)::int AS disbursements,(SELECT count(*) FROM financial_expense_command_receipts)::int AS receipts`,
            )
        )[0];
    }
    it('rolls back all facts after the root has been saved but before receipt completion', async () => {
        const receipts = app.get<PersonalExpenseReceipts>(
            PERSONAL_EXPENSE_RECEIPTS,
        );
        vi.spyOn(receipts, 'save').mockRejectedValueOnce(
            new Error('Receipt unavailable'),
        );
        const c = command();
        await expect(handler.execute(c)).rejects.toThrow('Receipt unavailable');
        expect(await counts()).toEqual({
            commitments: 0,
            versions: 0,
            disbursements: 0,
            receipts: 0,
        });
        await handler.execute(c);
        expect(await counts()).toEqual({
            commitments: 1,
            versions: 1,
            disbursements: 1,
            receipts: 1,
        });
    });
    it('rolls back a failure between version and disbursement writes', async () => {
        const c = command();
        await db.query(
            `CREATE FUNCTION fail_personal_disbursement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Disbursement unavailable'; END $$`,
        );
        await db.query(
            `CREATE TRIGGER reject_personal_disbursement BEFORE INSERT ON financial_disbursements FOR EACH ROW EXECUTE FUNCTION fail_personal_disbursement()`,
        );
        try {
            await expect(handler.execute(c)).rejects.toThrow(
                'Disbursement unavailable',
            );
            expect(await counts()).toEqual({
                commitments: 0,
                versions: 0,
                disbursements: 0,
                receipts: 0,
            });
        } finally {
            await db.query(
                'DROP TRIGGER reject_personal_disbursement ON financial_disbursements',
            );
            await db.query('DROP FUNCTION fail_personal_disbursement()');
        }
    });
    it('has one effect for two forced simultaneous receipt misses and replays the winner in a clean transaction', async () => {
        const receipts = app.get<PersonalExpenseReceipts>(
                PERSONAL_EXPENSE_RECEIPTS,
            ),
            find = receipts.find.bind(receipts);
        let reached = 0,
            release!: () => void;
        const barrier = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.spyOn(receipts, 'find').mockImplementation(async (c) => {
            const result = await find(c);
            if (++reached <= 2) {
                if (reached === 2) release();
                await barrier;
            }
            return result;
        });
        const c = command(),
            [first, second] = await Promise.all([
                handler.execute(c),
                handler.execute(c),
            ]);
        expect(first.commitment.id).toBe(second.commitment.id);
        expect(first.disbursement!.id).toBe(second.disbursement!.id);
        expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
        expect(reached).toBe(3);
        expect(await counts()).toEqual({
            commitments: 1,
            versions: 1,
            disbursements: 1,
            receipts: 1,
        });
    });
    it('conflicts with a simultaneous altered input while preserving only the winner', async () => {
        const receipts = app.get<PersonalExpenseReceipts>(
                PERSONAL_EXPENSE_RECEIPTS,
            ),
            find = receipts.find.bind(receipts);
        let reached = 0,
            release!: () => void;
        const barrier = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.spyOn(receipts, 'find').mockImplementation(async (c) => {
            const result = await find(c);
            if (++reached <= 2) {
                if (reached === 2) release();
                await barrier;
            }
            return result;
        });
        const c = command(),
            results = await Promise.allSettled([
                handler.execute(c),
                handler.execute({ ...c, amountInCents: 1 }),
            ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.find((r) => r.status === 'rejected')).toMatchObject({
            reason: { code: 'IDEMPOTENCY_KEY_REUSED' },
        });
        expect(await counts()).toEqual({
            commitments: 1,
            versions: 1,
            disbursements: 1,
            receipts: 1,
        });
    });
    it('rejects writes through the root adapter outside a transaction', async () => {
        const c = command(),
            saved = await handler.execute(c),
            repository = app.get<FinancialCommitmentRepository>(
                FINANCIAL_COMMITMENT_REPOSITORY,
            );
        await expect(
            repository.save({ id: saved.commitment.id } as never),
        ).rejects.toThrow('Expense writes require a transaction');
    });
    it.each([
        'UPDATE financial_disbursements SET payer_person_id = NULL',
        'UPDATE financial_disbursements SET payer_member_id = $1',
        "UPDATE financial_commitment_versions SET split_input = '{}'::jsonb",
        "UPDATE financial_commitment_versions SET split_mode = 'AMOUNTS'",
        'UPDATE financial_commitment_versions SET expected_payer_member_id = $1',
        'UPDATE financial_commitments SET personal_owner_person_id = $1',
    ])('rejects invalid local variant data: %s', async (sql) => {
        const c = command();
        await handler.execute(c);
        const other = randomUUID();
        await db.query(
            `INSERT INTO persons(id,display_name,version,created_at) VALUES($1,'Other',1,now())`,
            [other],
        );
        await expect(
            db.query(sql, sql.includes('$1') ? [other] : []),
        ).rejects.toMatchObject({ driverError: { code: '23514' } });
        expect(await counts()).toEqual({
            commitments: 1,
            versions: 1,
            disbursements: 1,
            receipts: 1,
        });
    });
    it('keeps disbursement identity unique and preserves the personal payer and author FKs', async () => {
        const r = await handler.execute(command());
        await expect(
            db.query(
                'INSERT INTO financial_disbursements SELECT * FROM financial_disbursements WHERE id=$1',
                [r.disbursement!.id],
            ),
        ).rejects.toMatchObject({
            driverError: {
                code: '23505',
            },
        });
        await expect(
            db.query('UPDATE financial_disbursements SET payer_person_id=$1', [
                randomUUID(),
            ]),
        ).rejects.toMatchObject({
            driverError: {
                code: '23503',
                constraint: 'FK_financial_disbursements_personal_payer',
            },
        });
        await expect(
            db.query(
                'UPDATE financial_disbursements SET recorded_by_person_id=$1',
                [randomUUID()],
            ),
        ).rejects.toMatchObject({
            driverError: {
                code: '23503',
                constraint: 'FK_financial_disbursements_recorder',
            },
        });
    });
});
