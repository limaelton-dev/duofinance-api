import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
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
import { AppModule } from '../dist/app.module.js';
import migrationSource from '../dist/shared/technical/database/typeorm/data-source.js';
import { TEST_DATABASE_URL } from './setup-env.js';
import { RecordSharedCashExpenseHandler } from '../dist/modules/finances/application/handlers/record-shared-cash-expense.handler.js';
import { PersonId } from '../dist/modules/spaces/domain/person/person-id.js';
import { SpaceId } from '../dist/modules/spaces/domain/space/space-id.js';
import type { RecordSharedCashExpenseCommand } from '../dist/modules/finances/application/models/shared-cash-expense.js';
import { FINANCES_CLOCK } from '../dist/modules/finances/application/ports/private/shared-expense.repositories.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../dist/modules/spaces/application/ports/public/space-financial-context.port.js';
import {
    UNIT_OF_WORK,
    type UnitOfWork,
} from '../dist/shared/application/unit-of-work.js';
import type { INestApplication } from '@nestjs/common';
import { IssueSpaceInvitationHandler } from '../dist/modules/spaces/application/handlers/issue-space-invitation.handler.js';
import { RespondToSharedSpaceInvitationHandler } from '../dist/modules/spaces/application/handlers/respond-to-shared-space-invitation.handler.js';
describe('CARD-006 atomic PostgreSQL persistence', () => {
    let app: INestApplication,
        db: DataSource,
        handler: RecordSharedCashExpenseHandler;
    let a: string, b: string, ma: string, mb: string, space: string;
    beforeAll(async () => {
        if (
            migrationSource.options.type !== 'postgres' ||
            migrationSource.options.url !== TEST_DATABASE_URL
        )
            throw new Error('Expected disposable PostgreSQL');
        await migrationSource.initialize();
        await migrationSource.dropDatabase();
        await migrationSource.runMigrations();
        await migrationSource.destroy();
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
        await app.init();
        db = app.get(DataSource);
        handler = app.get(RecordSharedCashExpenseHandler);
        await db.query('TRUNCATE persons CASCADE');
        a = randomUUID();
        b = randomUUID();
        ma = randomUUID();
        mb = randomUUID();
        space = randomUUID();
        await db.query(
            `INSERT INTO persons(id,display_name,version,created_at) VALUES($1,'A',1,now()),($2,'B',1,now())`,
            [a, b],
        );
        await db.query(
            `INSERT INTO spaces(id,type,status,name,created_by_person_id,version,created_at,updated_at) VALUES($1,'SHARED','ACTIVE','Test',$2,2,now(),now())`,
            [space, a],
        );
        await db.query(
            `INSERT INTO space_members(id,space_id,person_id,status,slot,joined_at) VALUES($1,$3,$4,'ACTIVE',1,now()),($2,$3,$5,'ACTIVE',2,now())`,
            [ma, mb, space, a, b],
        );
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await app?.close();
    });
    it('roundtrips an absent planned payer while preserving debt and history', async () => {
        const result = await handler.execute({
            ...command(),
            expectedPayerMemberId: null,
        });
        expect(result.commitment.expectedPayerMemberId).toBeNull();
        expect(result.obligation?.originalAmountInCents).toBe(20000);
        const [row] = await db.query(
            'SELECT expected_payer_member_id FROM financial_commitment_versions WHERE commitment_id=$1',
            [result.commitment.id],
        );
        expect(row.expected_payer_member_id).toBeNull();
        expect(
            (
                await db.query(
                    'SELECT count(*)::int AS count FROM inter_member_obligation_changes',
                )
            )[0].count,
        ).toBe(1);
    });
    const command = (): RecordSharedCashExpenseCommand => ({
        actorId: PersonId.from(a),
        spaceId: SpaceId.from(space),
        idempotencyKey: randomUUID(),
        expectedSpaceVersion: 2,
        description: 'Mercado',
        amountInCents: 50000,
        factDate: '2026-10-09',
        responsibilitySplit: {
            mode: 'AMOUNTS',
            shares: [
                { memberId: ma, amountInCents: 20000 },
                { memberId: mb, amountInCents: 30000 },
            ],
        },
        expectedPayerMemberId: ma,
        disbursement: { payerMemberId: mb, method: 'DEBIT' },
        settlement: { mode: 'DATE', targetDate: '2026-10-31' },
    });
    async function counts() {
        return (
            await db.query(
                `SELECT (SELECT count(*) FROM financial_commitments)::int AS commitments, (SELECT count(*) FROM financial_disbursements)::int AS payments, (SELECT count(*) FROM inter_member_obligations)::int AS obligations, (SELECT count(*) FROM settlement_cycles)::int AS cycles, (SELECT count(*) FROM financial_expense_command_receipts)::int AS receipts`,
            )
        )[0];
    }
    it('commits one atomic traceable expense with history', async () => {
        const result = await handler.execute(command());
        expect(result.obligation).toMatchObject({
            debtorMemberId: ma,
            creditorMemberId: mb,
            originalAmountInCents: 20000,
        });
        expect(await counts()).toEqual({
            commitments: 1,
            payments: 1,
            obligations: 1,
            cycles: 1,
            receipts: 1,
        });
        expect(
            (
                await db.query(
                    'SELECT count(*)::int AS n FROM inter_member_obligation_changes',
                )
            )[0].n,
        ).toBe(1);
    });
    it('persists original percentages and nullable amounts without losing a residual cent', async () => {
        const input = command();
        const result = await handler.execute({
            ...input,
            amountInCents: 101,
            responsibilitySplit: {
                mode: 'PERCENTAGES',
                shares: [
                    { memberId: mb, basisPoints: 5000 },
                    { memberId: ma, basisPoints: 5000 },
                ],
            },
        });
        expect(
            result.commitment.responsibilitySplit.calculatedShares.reduce(
                (n, s) => n + s.amountInCents,
                0,
            ),
        ).toBe(101);
        const shares = await db.query(
            'SELECT basis_points, original_amount_in_cents FROM financial_commitment_shares WHERE commitment_id=$1',
            [result.commitment.id],
        );
        expect(shares).toEqual([
            { basis_points: 5000, original_amount_in_cents: null },
            { basis_points: 5000, original_amount_in_cents: null },
        ]);
        await expect(
            db.query(
                'UPDATE financial_commitment_shares SET basis_points=NULL WHERE commitment_id=$1',
                [result.commitment.id],
            ),
        ).rejects.toThrow();
    });
    it('serializes concurrent new origins on a unique date cycle', async () => {
        const [first, second] = await Promise.all([
            handler.execute(command()),
            handler.execute(command()),
        ]);
        expect(first.settlementCycle?.id).toBe(second.settlementCycle?.id);
        expect(first.commitment.id).not.toBe(second.commitment.id);
        expect(await counts()).toEqual({
            commitments: 2,
            payments: 2,
            obligations: 2,
            cycles: 1,
            receipts: 2,
        });
    });
    it('recovers a concurrent receipt only after rollback and preserves original replay', async () => {
        const input = command();
        const results = await Promise.all([
            handler.execute(input),
            handler.execute(input),
        ]);
        expect(results[0].commitment.id).toBe(results[1].commitment.id);
        expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
        expect(await counts()).toEqual({
            commitments: 1,
            payments: 1,
            obligations: 1,
            cycles: 1,
            receipts: 1,
        });
        await db.query(`UPDATE spaces SET status='CLOSED' WHERE id=$1`, [
            space,
        ]);
        expect((await handler.execute(input)).replayed).toBe(true);
        await expect(handler.execute(command())).rejects.toMatchObject({
            code: 'SPACE_NOT_ACTIVE',
        });
    });
    it.each([
        'settlement_cycles',
        'financial_commitments',
        'financial_commitment_versions',
        'financial_commitment_shares',
        'financial_disbursements',
        'inter_member_obligations',
        'inter_member_obligation_changes',
        'financial_expense_command_receipts',
    ])('rolls back all effects on failed write to %s', async (table) => {
        await db.query(
            `CREATE FUNCTION fail_expense_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected test failure'; END $$`,
        );
        await db.query(
            `CREATE TRIGGER fail_write BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_expense_write()`,
        );
        try {
            await expect(handler.execute(command())).rejects.toThrow();
            expect(await counts()).toEqual({
                commitments: 0,
                payments: 0,
                obligations: 0,
                cycles: 0,
                receipts: 0,
            });
            expect(
                (
                    await db.query(
                        `SELECT (SELECT count(*) FROM financial_commitment_versions)::int AS versions, (SELECT count(*) FROM financial_commitment_shares)::int AS shares, (SELECT count(*) FROM inter_member_obligation_changes)::int AS history`,
                    )
                )[0],
            ).toEqual({ versions: 0, shares: 0, history: 0 });
        } finally {
            await db.query(`DROP TRIGGER fail_write ON ${table}`);
            await db.query('DROP FUNCTION fail_expense_write()');
        }
    });
    it('rejects finalized cycle and stale context without partial facts', async () => {
        await db.query(
            `INSERT INTO settlement_cycles(id,space_id,target_date,status,version,finalized_at) VALUES($1,$2,'2026-10-31','FINALIZED',1,now())`,
            [randomUUID(), space],
        );
        await expect(handler.execute(command())).rejects.toMatchObject({
            code: 'SETTLEMENT_CYCLE_FINALIZED',
        });
        await expect(
            handler.execute({ ...command(), expectedSpaceVersion: 1 }),
        ).rejects.toMatchObject({ code: 'EXPENSE_OPTIONS_CHANGED' });
        expect((await counts()).commitments).toBe(0);
    });
    it('persists safe maximum cents and recovers normalized order under the same key', async () => {
        const input = {
            ...command(),
            amountInCents: Number.MAX_SAFE_INTEGER,
            responsibilitySplit: {
                mode: 'PERCENTAGES' as const,
                shares: [
                    { memberId: ma, basisPoints: 4000 },
                    { memberId: mb, basisPoints: 6000 },
                ],
            },
        };
        const result = await handler.execute(input);
        const replay = await handler.execute({
            ...input,
            responsibilitySplit: {
                ...input.responsibilitySplit,
                shares: [...input.responsibilitySplit.shares]
                    .reverse()
                    .map((s) => ({ ...s, memberId: s.memberId.toUpperCase() })),
            },
            expectedPayerMemberId: input.expectedPayerMemberId!.toUpperCase(),
            disbursement: {
                ...input.disbursement,
                payerMemberId: input.disbursement.payerMemberId.toUpperCase(),
            },
        });
        expect(replay.commitment.id).toBe(result.commitment.id);
        expect(replay.replayed).toBe(true);
        expect(
            (
                await db.query(
                    'SELECT amount_in_cents FROM financial_commitment_versions WHERE commitment_id=$1',
                    [result.commitment.id],
                )
            )[0].amount_in_cents,
        ).toBe(String(Number.MAX_SAFE_INTEGER));
        await expect(
            handler.execute({ ...input, description: 'Changed' }),
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    });
    it('enforces scoped member references and initial database checks', async () => {
        const result = await handler.execute(command());
        await expect(
            db.query(
                `UPDATE inter_member_obligations SET debtor_member_id=creditor_member_id WHERE id=$1`,
                [result.obligation!.id],
            ),
        ).rejects.toThrow();
        await expect(
            db.query(
                `UPDATE financial_disbursements SET amount_in_cents=9007199254740992 WHERE id=$1`,
                [result.disbursement.id],
            ),
        ).rejects.toThrow();
        await expect(
            db.query(
                `UPDATE financial_commitment_shares SET amount_in_cents=-1 WHERE commitment_id=$1`,
                [result.commitment.id],
            ),
        ).rejects.toThrow();
        await expect(
            db.query(
                `UPDATE financial_commitment_shares SET original_amount_in_cents=NULL WHERE commitment_id=$1`,
                [result.commitment.id],
            ),
        ).rejects.toThrow();
        const foreignSpace = randomUUID(),
            foreignMember = randomUUID();
        await db.query(
            `INSERT INTO spaces(id,type,status,name,created_by_person_id,version,created_at,updated_at) VALUES($1,'SHARED','ACTIVE','Foreign',$2,1,now(),now())`,
            [foreignSpace, a],
        );
        await db.query(
            `INSERT INTO space_members(id,space_id,person_id,status,slot,joined_at) VALUES($1,$2,$3,'ACTIVE',1,now())`,
            [foreignMember, foreignSpace, a],
        );
        await expect(
            db.query(
                `UPDATE financial_disbursements SET payer_member_id=$1 WHERE id=$2`,
                [foreignMember, result.disbursement.id],
            ),
        ).rejects.toThrow();
        await expect(
            db.query(
                `UPDATE financial_commitment_versions SET expected_payer_member_id=$1 WHERE commitment_id=$2`,
                [foreignMember, result.commitment.id],
            ),
        ).rejects.toThrow();
        await expect(
            db.query(
                `UPDATE inter_member_obligations SET creditor_member_id=$1 WHERE id=$2`,
                [foreignMember, result.obligation!.id],
            ),
        ).rejects.toThrow();
    });
    it('protects context against concurrent membership acceptance on the Space root', async () => {
        await db.query('DELETE FROM space_members WHERE id=$1', [mb]);
        await db.query('UPDATE spaces SET version=1 WHERE id=$1', [space]);
        const invitation = await app.get(IssueSpaceInvitationHandler).execute({
            actorId: PersonId.from(a),
            spaceId: SpaceId.from(space),
            expectedVersion: 1,
            key: randomUUID(),
        });
        const invitationToken = new URLSearchParams(
            new URL(invitation.inviteUrl!).hash.slice(1),
        ).get('token')!;
        const access = app.get<SpaceFinancialContextPort>(
            SPACE_FINANCIAL_CONTEXT_PORT,
        );
        const uow = app.get<UnitOfWork>(UNIT_OF_WORK);
        let unlock!: () => void, locked!: () => void;
        const lockReady = new Promise<void>((resolve) => {
            locked = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            unlock = resolve;
        });
        const protectedRead = uow.execute(async () => {
            const context = await access.lockForWrite(
                PersonId.from(a),
                SpaceId.from(space),
            );
            locked();
            await gate;
            return context;
        });
        await lockReady;
        let accepted = false;
        const acceptance = (async () => {
            await app.get(RespondToSharedSpaceInvitationHandler).execute({
                actorId: PersonId.from(b),
                key: randomUUID(),
                token: invitationToken,
                decision: 'ACCEPT',
                expectedVersion: invitation.space.version,
            });
            accepted = true;
        })();
        let blocked = 0;
        for (let attempt = 0; attempt < 30 && blocked === 0; attempt++) {
            blocked = (
                await db.query(
                    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`,
                )
            )[0].n;
        }
        expect(blocked).toBeGreaterThan(0);
        expect(accepted).toBe(false);
        unlock();
        const before = await protectedRead;
        await acceptance;
        expect(before.members).toHaveLength(1);
        expect(before.version).toBe(invitation.space.version);
        expect(
            (await access.read(PersonId.from(a), SpaceId.from(space))).members,
        ).toHaveLength(2);
        await expect(
            handler.execute({ ...command(), expectedSpaceVersion: 1 }),
        ).rejects.toMatchObject({ code: 'EXPENSE_OPTIONS_CHANGED' });
    });
    const financialSnapshot = async () => {
        const tables = [
            'financial_commitments',
            'financial_commitment_versions',
            'financial_commitment_shares',
            'financial_disbursements',
            'inter_member_obligations',
            'inter_member_obligation_changes',
            'financial_expense_command_receipts',
        ];
        return Promise.all(
            tables.map((table) =>
                db.query(`SELECT * FROM ${table} ORDER BY 1`),
            ),
        );
    };
    it('rejects rollback with null historical payer and preserves all facts and receipts', async () => {
        await handler.execute({ ...command(), expectedPayerMemberId: null });
        const before = await financialSnapshot();
        const migrations = await db.query(
            'SELECT * FROM migrations ORDER BY id',
        );
        await migrationSource.initialize();
        try {
            await migrationSource.undoLastMigration();
            await migrationSource.undoLastMigration();
            await migrationSource.undoLastMigration();
            await expect(migrationSource.undoLastMigration()).rejects.toThrow(
                'historical expenses without an expected payer exist',
            );
            await migrationSource.runMigrations();
        } finally {
            await migrationSource.runMigrations();
            await migrationSource.destroy();
        }
        expect(await financialSnapshot()).toEqual(before);
        expect(
            (
                await db.query('SELECT name FROM migrations ORDER BY timestamp')
            ).map((migration: { name: string }) => migration.name),
        ).toEqual(
            migrations.map((migration: { name: string }) => migration.name),
        );
    });
    it('preserves legacy planned facts and receipts across optional down/up', async () => {
        const input = command();
        await handler.execute(input);
        const before = await financialSnapshot();
        await migrationSource.initialize();
        try {
            await migrationSource.undoLastMigration();
            await migrationSource.undoLastMigration();
            await migrationSource.undoLastMigration();
            await migrationSource.undoLastMigration();
            await migrationSource.runMigrations();
        } finally {
            await migrationSource.destroy();
        }
        expect(await financialSnapshot()).toEqual(before);
        expect((await handler.execute(input)).replayed).toBe(true);
    });
    it('migration down/up preserves all existing Spaces and CARD005 data', async () => {
        await db.query(
            `INSERT INTO default_settlement_rules(space_id,kind,day_of_month,version,created_at,updated_at) VALUES($1,'MONTHLY_DAY',10,1,now(),now())`,
            [space],
        );
        const prior = await db.query('SELECT * FROM default_settlement_rules');
        await migrationSource.initialize();
        try {
            await migrationSource.undoLastMigration();
            await migrationSource.undoLastMigration();
            await migrationSource.undoLastMigration();
            await migrationSource.undoLastMigration();
            await migrationSource.undoLastMigration();
            expect(
                await db.query('SELECT * FROM default_settlement_rules'),
            ).toEqual(prior);
            expect(
                (await db.query('SELECT count(*)::int AS n FROM persons'))[0].n,
            ).toBe(2);
            await migrationSource.runMigrations();
        } finally {
            await migrationSource.destroy();
        }
        expect(
            await db.query('SELECT * FROM default_settlement_rules'),
        ).toEqual(prior);
        expect(
            (
                await db.query(
                    `SELECT count(*)::int AS n FROM space_members WHERE space_id=$1`,
                    [space],
                )
            )[0].n,
        ).toBe(2);
    });
});
