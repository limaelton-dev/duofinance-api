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
import { RecordPersonalExpense1791995573673 } from '../dist/shared/technical/database/typeorm/migrations/1791995573673-RecordPersonalExpense.js';
const id = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
describe('CARD-011 PostgreSQL transaction and migration compatibility', () => {
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
        await migrationSource.initialize();
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
        await migrationSource.runMigrations();
        await migrationSource.destroy();
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
        expect(first.disbursement.id).toBe(second.disbursement.id);
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
                [r.disbursement.id],
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
    it('prevents rollback before changing or discarding any personal data', async () => {
        const r = await handler.execute(command()),
            before = await counts();
        await migrationSource.undoLastMigration();
        await migrationSource.undoLastMigration();
        await expect(migrationSource.undoLastMigration()).rejects.toThrow(
            'Personal financial facts prevent schema rollback',
        );
        expect(await counts()).toEqual(before);
        expect(
            (
                await db.query(
                    'SELECT personal_owner_person_id FROM financial_commitments WHERE id=$1',
                    [r.commitment.id],
                )
            )[0].personal_owner_person_id,
        ).toBe(actor);
        expect(
            (
                await db.query(
                    'SELECT name FROM migrations ORDER BY id DESC LIMIT 1',
                )
            )[0].name,
        ).toBe(new RecordPersonalExpense1791995573673().name);
    });
    it('upgrades Wave 1 facts without altering identities, snapshots or literal legacy receipt hash and supports safe rollback', async () => {
        await migrationSource.undoLastMigration();
        await migrationSource.undoLastMigration();
        await migrationSource.undoLastMigration();
        await db.query('TRUNCATE persons CASCADE');
        await db.query(
            `INSERT INTO persons(id,display_name,version,created_at) VALUES($1,'A',1,now()),($2,'B',1,now())`,
            [id(1), id(9)],
        );
        await db.query(
            `INSERT INTO spaces(id,type,status,name,created_by_person_id,version,created_at,updated_at) VALUES($1,'SHARED','ACTIVE','Wave 1',$2,2,now(),now())`,
            [id(4), id(1)],
        );
        await db.query(
            `INSERT INTO space_members(id,space_id,person_id,status,slot,joined_at) VALUES($1,$3,$4,'ACTIVE',1,now()),($2,$3,$5,'ACTIVE',2,now())`,
            [id(2), id(3), id(4), id(1), id(9)],
        );
        const split = {
            mode: 'AMOUNTS',
            shares: [
                { memberId: id(2), amountInCents: 20000 },
                { memberId: id(3), amountInCents: 30000 },
            ],
        };
        const registered = '2026-10-09T15:00:00.000Z',
            fact = '2026-10-09';
        const result = {
            spaceId: id(4),
            commitment: {
                id: id(6),
                version: 1,
                kind: 'EXPENSE',
                modality: 'ONE_TIME',
                description: 'Mercado',
                amountInCents: 50000,
                factDate: fact,
                registeredAt: registered,
                createdByPersonId: id(1),
                expectedPayerMemberId: id(2),
                responsibilitySplit: {
                    ...split,
                    mode: 'AMOUNTS',
                    calculatedShares: split.shares,
                },
                settlementRuleSnapshot: null,
                settlementRuleSourceVersion: 0,
                suggestedTargetDate: null,
            },
            disbursement: {
                id: id(7),
                payerMemberId: id(3),
                method: 'DEBIT',
                amountInCents: 50000,
                factDate: fact,
                registeredAt: registered,
            },
            obligation: {
                id: id(8),
                originCommitmentId: id(6),
                originDisbursementId: id(7),
                debtorMemberId: id(2),
                creditorMemberId: id(3),
                originalAmountInCents: 20000,
                remainingAmountInCents: 20000,
                status: 'OPEN',
                cycleId: null,
            },
            settlementCycle: null,
            replayed: false,
        };
        await db.query(
            `INSERT INTO financial_commitments(id,space_id,kind,modality,description,created_by,version,registered_at) VALUES($1,$2,'EXPENSE','ONE_TIME','Mercado',$3,1,$4)`,
            [id(6), id(4), id(1), registered],
        );
        await db.query(
            `INSERT INTO financial_commitment_versions(commitment_id,version,space_id,amount_in_cents,expected_payer_member_id,fact_date,split_mode,split_input,rule_snapshot,rule_source_version,suggested_target_date) VALUES($1,1,$2,50000,$3,$4,'AMOUNTS',$5,NULL,0,NULL)`,
            [id(6), id(4), id(2), fact, split],
        );
        await db.query(
            `INSERT INTO financial_commitment_shares(commitment_id,version,member_id,space_id,amount_in_cents,split_mode,original_amount_in_cents,basis_points) VALUES($1,1,$2,$4,20000,'AMOUNTS',20000,NULL),($1,1,$3,$4,30000,'AMOUNTS',30000,NULL)`,
            [id(6), id(2), id(3), id(4)],
        );
        await db.query(
            `INSERT INTO financial_disbursements(id,space_id,commitment_id,version,payer_member_id,amount_in_cents,method,fact_date,registered_at) VALUES($1,$2,$3,1,$4,50000,'DEBIT',$5,$6)`,
            [id(7), id(4), id(6), id(3), fact, registered],
        );
        await db.query(
            `INSERT INTO inter_member_obligations(id,space_id,commitment_id,disbursement_id,debtor_member_id,creditor_member_id,original_amount_in_cents,remaining_amount_in_cents,status,cycle_id,version,fact_date,registered_at) VALUES($1,$2,$3,$4,$5,$6,20000,20000,'OPEN',NULL,1,$7,$8)`,
            [id(8), id(4), id(6), id(7), id(2), id(3), fact, registered],
        );
        await db.query(
            `INSERT INTO financial_expense_command_receipts(actor_id,operation,idempotency_key,request_hash,status,commitment_id,result,created_at) VALUES($1,'RECORD_SHARED_CASH_EXPENSE',$2,decode('a47e4f8722ca73d26a9b01612d72bb04b3cc73e3462ff2b5edf1b9b9dbadf298','hex'),'COMPLETED',$3,$4,$5)`,
            [id(1), id(5), id(6), result, registered],
        );
        const snapshot = async () => ({
            commitment: await db.query(
                'SELECT id,space_id,kind,modality,description,created_by,version,registered_at FROM financial_commitments',
            ),
            versions: await db.query(
                'SELECT * FROM financial_commitment_versions',
            ),
            shares: await db.query(
                'SELECT * FROM financial_commitment_shares ORDER BY member_id',
            ),
            disbursement: await db.query(
                'SELECT id,space_id,commitment_id,version,payer_member_id,amount_in_cents,method,fact_date,registered_at FROM financial_disbursements',
            ),
            obligations: (
                await db.query('SELECT * FROM inter_member_obligations')
            ).map(
                ({
                    receipt_id: _receiptId,
                    recognized_amount_in_cents: _recognized,
                    ...legacy
                }: Record<string, unknown>) => legacy,
            ),
            receipts: await db.query(
                'SELECT * FROM financial_expense_command_receipts',
            ),
        });
        const before = await snapshot();
        await migrationSource.runMigrations();
        expect(await snapshot()).toEqual(before);
        const replay = await app.get(RecordSharedCashExpenseHandler).execute({
            actorId: PersonId.from(id(1)),
            spaceId: SpaceId.from(id(4)),
            idempotencyKey: id(5),
            expectedSpaceVersion: 2,
            description: 'Mercado',
            amountInCents: 50000,
            factDate: fact,
            expectedPayerMemberId: id(2),
            responsibilitySplit: { ...split, mode: 'AMOUNTS' },
            disbursement: { payerMemberId: id(3), method: 'DEBIT' },
            settlement: { mode: 'NONE' },
        });
        expect(replay).toEqual({ ...result, replayed: true });
        expect(await snapshot()).toEqual(before);
        await migrationSource.undoLastMigration();
        expect(await snapshot()).toEqual(before);
        await migrationSource.runMigrations();
        expect(await snapshot()).toEqual(before);
        const constraints = await db.query(
            `SELECT conname FROM pg_constraint WHERE conname IN ('FK_obligation_changes_allocation','UQ_obligation_changes_allocation','default_settlement_rules_version_check','finances_command_receipts_request_hash_check','FK_financial_disbursements_recorder','FK_financial_disbursements_personal_payer')`,
        );
        expect(constraints).toHaveLength(6);
        const personalSpace = id(10);
        await db.query(
            `INSERT INTO spaces(id,type,status,personal_owner_person_id,version,created_at,updated_at) VALUES($1,'PERSONAL','ACTIVE',$2,1,now(),now())`,
            [personalSpace, id(1)],
        );
        const personal = await handler.execute({
            ...command(),
            actorId: PersonId.from(id(1)),
            spaceId: SpaceId.from(personalSpace),
            idempotencyKey: id(5),
        });
        expect(personal.replayed).toBe(false);
        expect(personal.commitment.id).not.toBe(id(6));
        expect(
            await db.query(
                `SELECT operation FROM financial_expense_command_receipts WHERE actor_id=$1 AND idempotency_key=$2 ORDER BY operation`,
                [id(1), id(5)],
            ),
        ).toEqual([
            { operation: 'RECORD_PERSONAL_EXPENSE' },
            { operation: 'RECORD_SHARED_CASH_EXPENSE' },
        ]);
        expect(
            (
                await db.query(
                    `SELECT encode(request_hash,'hex') AS hash,result FROM financial_expense_command_receipts WHERE operation='RECORD_SHARED_CASH_EXPENSE'`,
                )
            )[0],
        ).toEqual({
            hash: 'a47e4f8722ca73d26a9b01612d72bb04b3cc73e3462ff2b5edf1b9b9dbadf298',
            result,
        });
    });
});
