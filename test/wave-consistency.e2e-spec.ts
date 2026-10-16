import {
    INTER_MEMBER_OBLIGATION_REPOSITORY,
    type InterMemberObligationRepository,
} from '../dist/modules/finances/application/ports/private/shared-expense.repositories.js';
import { RecordSharedCashExpenseHandler } from '../dist/modules/finances/application/handlers/record-shared-cash-expense.handler.js';
import { INCOME_REPOSITORY } from '../dist/modules/finances/application/ports/private/income.ports.js';
import { PERSONAL_EXPENSE_READER } from '../dist/modules/finances/application/ports/private/personal-expense.ports.js';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
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
import migrationSource from '../dist/shared/technical/database/typeorm/data-source.js';
import { EntityManagerProvider } from '../dist/shared/technical/database/typeorm/entity-manager.provider.js';
import { RecordPersonalExpenseHandler } from '../dist/modules/finances/application/handlers/record-personal-expense.handler.js';
import { RecordIncomeHandler } from '../dist/modules/finances/application/handlers/record-income.handler.js';
import { RecordCreditCardPurchaseHandler } from '../dist/modules/finances/application/handlers/record-credit-card-purchase.handler.js';
import { RecordExpenseDisbursementHandler } from '../dist/modules/finances/application/handlers/record-expense-disbursement.handler.js';
import { SettleExternalLiabilityHandler } from '../dist/modules/finances/application/handlers/settle-external-liability.handler.js';
import { TypeOrmPersonalExpenseReader } from '../dist/modules/finances/infrastructure/typeorm/queries/typeorm-personal-expense-reader.js';
import { TypeOrmIncomeRepository } from '../dist/modules/finances/infrastructure/typeorm/repositories/typeorm-income.repository.js';
import { TypeOrmFinancialCommitmentRepository } from '../dist/modules/finances/infrastructure/typeorm/repositories/typeorm-financial-commitment.repository.js';
import { FinancialCommandAudit1792154979034 } from '../dist/shared/technical/database/typeorm/migrations/1792154979034-FinancialCommandAudit.js';
import {
    FINANCES_CLOCK,
    FINANCIAL_COMMITMENT_REPOSITORY,
} from '../dist/modules/finances/application/ports/private/shared-expense.repositories.js';
import { PersonId } from '../dist/modules/spaces/domain/person/person-id.js';
import { SpaceId } from '../dist/modules/spaces/domain/space/space-id.js';

describe('Wave 0–2 financial read consistency and technical audit', () => {
    let app: INestApplication,
        db: DataSource,
        actorId: PersonId,
        spaceId: SpaceId;
    const date = '2026-10-14';
    const context = () => ({ actorId, spaceId, idempotencyKey: randomUUID() });
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
                today: () => date,
                now: () => new Date('2026-10-14T15:00:00Z'),
            })
            .compile();
        app = module.createNestApplication();
        await app.init();
        db = app.get(DataSource);
        await db.query('TRUNCATE persons CASCADE');
        // Audit has deliberately independent operational retention (no cascading FK).
        await db.query('TRUNCATE financial_command_audit');
        actorId = PersonId.create();
        spaceId = SpaceId.create();
        await db.query(
            `INSERT INTO persons(id,display_name,version,created_at) VALUES($1,'Titular',1,now())`,
            [actorId.value],
        );
        await db.query(
            `INSERT INTO spaces(id,type,status,personal_owner_person_id,created_by_person_id,version,created_at,updated_at) VALUES($1,'PERSONAL','ACTIVE',$2,NULL,1,now(),now())`,
            [spaceId.value, actorId.value],
        );
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await app?.close();
    });
    const expense = () =>
        app.get(RecordPersonalExpenseHandler).execute({
            ...context(),
            description: 'Conta',
            amountInCents: 1000,
            factDate: date,
            disbursement: { method: 'PIX', amountInCents: 100 },
        });

    function afterRootRead(write: () => Promise<unknown>) {
        const provider = app.get(EntityManagerProvider),
            original = provider.get.bind(provider);
        let armed = true;
        vi.spyOn(provider, 'get').mockImplementation(() => {
            const manager = original();
            if (armed && manager.queryRunner?.isTransactionActive) {
                armed = false;
                const find = manager.findOneByOrFail.bind(manager);
                vi.spyOn(manager, 'findOneByOrFail').mockImplementationOnce(
                    async (target, where) => {
                        // Writer commits on a separate connection between root/version reads.
                        await write();
                        return find(target, where);
                    },
                );
            }
            return manager;
        });
    }
    async function shared() {
        const other = randomUUID(),
            member = randomUUID(),
            otherMember = randomUUID();
        spaceId = SpaceId.create();
        await db.query(
            `INSERT INTO persons(id,display_name,version,created_at) VALUES($1,'Outra pessoa',1,now())`,
            [other],
        );
        await db.query(
            `INSERT INTO spaces(id,type,status,name,created_by_person_id,version,created_at,updated_at) VALUES($1,'SHARED','ACTIVE','Casa',$2,2,now(),now())`,
            [spaceId.value, actorId.value],
        );
        await db.query(
            `INSERT INTO space_members(id,space_id,person_id,status,slot,joined_at) VALUES($1,$3,$4,'ACTIVE',1,now()),($2,$3,$5,'ACTIVE',2,now())`,
            [member, otherMember, spaceId.value, actorId.value, other],
        );
        return { member, otherMember };
    }
    it('keeps income origin and obligation history on the same snapshot', async () => {
        const { member, otherMember } = await shared(),
            handler = app.get(RecordIncomeHandler);
        const created = await handler.execute({
            ...context(),
            description: 'Renda compartilhada',
            amountInCents: 1000,
            expectedReceiptDate: date,
            expectedSpaceVersion: 2,
            expectedRecipientMemberId: null,
            participationSplit: {
                mode: 'AMOUNTS',
                shares: [
                    { memberId: member, amountInCents: 500 },
                    { memberId: otherMember, amountInCents: 500 },
                ],
            },
            receipt: null,
        });
        const repo = app.get<TypeOrmIncomeRepository>(INCOME_REPOSITORY),
            before = await repo.detail(spaceId.value, created.commitment.id);
        const obligations = app.get<InterMemberObligationRepository>(
                INTER_MEMBER_OBLIGATION_REPOSITORY,
            ),
            history = obligations.history.bind(obligations);
        vi.spyOn(obligations, 'history').mockImplementationOnce(
            async (space, origin) => {
                await handler.recordReceipt({
                    ...context(),
                    commitmentId: created.commitment.id,
                    expectedCommitmentVersion: 1,
                    factDate: date,
                    amountInCents: 100,
                    expectedSpaceVersion: 2,
                    recipientMemberId: member,
                    settlement: { mode: 'NONE' },
                });
                return history(space, origin);
            },
        );
        expect(await repo.detail(spaceId.value, created.commitment.id)).toEqual(
            before,
        );
        expect(
            (await repo.detail(spaceId.value, created.commitment.id))
                ?.obligations,
        ).toHaveLength(1);
    });
    it('audits all eight expense/income actions with their command transaction', async () => {
        const created = await expense();
        await app.get(RecordExpenseDisbursementHandler).execute({
            ...context(),
            commitmentId: created.commitment.id,
            expectedCommitmentVersion: 1,
            factDate: date,
            amountInCents: 100,
            method: 'PIX',
        });
        const incomes = app.get(RecordIncomeHandler),
            income = await incomes.execute({
                ...context(),
                description: 'Renda',
                amountInCents: 1000,
                expectedReceiptDate: date,
                receipt: null,
            });
        await incomes.recordReceipt({
            ...context(),
            commitmentId: income.commitment.id,
            expectedCommitmentVersion: 1,
            factDate: date,
            amountInCents: 100,
        });
        const cards = app.get(RecordCreditCardPurchaseHandler),
            card = await cards.execute({
                ...context(),
                description: 'Compra',
                amountInCents: 1000,
                factDate: date,
                externalLiability: { amountInCents: 400 },
            });
        await cards.execute({
            ...context(),
            commitmentId: card.commitment.id,
            expectedCommitmentVersion: 1,
            factDate: date,
            amountInCents: 200,
        });
        await app.get(SettleExternalLiabilityHandler).execute({
            ...context(),
            commitmentId: card.commitment.id,
            externalLiabilityId: card.externalLiability.id,
            expectedCommitmentVersion: 2,
            factDate: date,
            amountInCents: 100,
        });
        const { member, otherMember } = await shared();
        await app.get(RecordSharedCashExpenseHandler).execute({
            ...context(),
            description: 'Casa',
            amountInCents: 1000,
            factDate: date,
            expectedSpaceVersion: 2,
            expectedPayerMemberId: null,
            responsibilitySplit: {
                mode: 'AMOUNTS',
                shares: [
                    { memberId: member, amountInCents: 500 },
                    { memberId: otherMember, amountInCents: 500 },
                ],
            },
            disbursement: { method: 'PIX', payerMemberId: member },
            settlement: { mode: 'NONE' },
        });
        const rows = await db.query(
            'SELECT action,count(*)::int AS count FROM financial_command_audit GROUP BY action ORDER BY action',
        );
        expect(rows).toEqual(
            [
                'RECORD_CREDIT_CARD_PURCHASE',
                'RECORD_EXPENSE_DISBURSEMENT',
                'RECORD_EXTERNAL_LIABILITY',
                'RECORD_INCOME',
                'RECORD_INCOME_RECEIPT',
                'RECORD_PERSONAL_EXPENSE',
                'RECORD_SHARED_CASH_EXPENSE',
                'SETTLE_EXTERNAL_LIABILITY',
            ]
                .sort()
                .map((action) => ({ action, count: 1 })),
        );
    });
    it('keeps income detail on the original snapshot while another receipt commits', async () => {
        const handler = app.get(RecordIncomeHandler),
            repo = app.get<TypeOrmIncomeRepository>(INCOME_REPOSITORY);
        const created = await handler.execute({
            ...context(),
            description: 'Renda',
            amountInCents: 1000,
            expectedReceiptDate: date,
            receipt: null,
        });
        afterRootRead(() =>
            handler.recordReceipt({
                ...context(),
                commitmentId: created.commitment.id,
                expectedCommitmentVersion: 1,
                factDate: date,
                amountInCents: 100,
            }),
        );
        const before = await repo.detail(spaceId.value, created.commitment.id);
        expect(before?.commitment.version).toBe(1);
        expect(before?.receipts).toEqual([]);
        const after = await repo.detail(spaceId.value, created.commitment.id);
        expect(after?.commitment.version).toBe(2);
        expect(after?.receivedAmountInCents).toBe(100);
    });
    it('keeps expense totals and facts together during a concurrent disbursement', async () => {
        const created = await expense(),
            repo = app.get<TypeOrmFinancialCommitmentRepository>(
                FINANCIAL_COMMITMENT_REPOSITORY,
            );
        afterRootRead(() =>
            app.get(RecordExpenseDisbursementHandler).execute({
                ...context(),
                commitmentId: created.commitment.id,
                expectedCommitmentVersion: 1,
                factDate: date,
                amountInCents: 100,
                method: 'CASH',
            }),
        );
        const before = await repo.find(spaceId.value, created.commitment.id);
        expect(before?.version).toBe(1);
        expect(before?.paidAmountInCents).toBe(100);
        const after = await repo.find(spaceId.value, created.commitment.id);
        expect(after?.version).toBe(2);
        expect(after?.paidAmountInCents).toBe(200);
    });
    it('projects one 21-root page in one query and preserves card/settlement totals', async () => {
        const card = app.get(RecordCreditCardPurchaseHandler);
        const created = await card.execute({
            ...context(),
            description: 'Cartão',
            amountInCents: 1000,
            factDate: date,
            externalLiability: { amountInCents: 600 },
        });
        await app.get(SettleExternalLiabilityHandler).execute({
            ...context(),
            commitmentId: created.commitment.id,
            externalLiabilityId: created.externalLiability.id,
            expectedCommitmentVersion: 1,
            factDate: date,
            amountInCents: 200,
        });
        for (let i = 0; i < 22; i++) await expense();
        const reader = app.get<TypeOrmPersonalExpenseReader>(
                PERSONAL_EXPENSE_READER,
            ),
            query = vi.spyOn(db.manager, 'query');
        const page = await reader.list(spaceId.value, null);
        expect(query).toHaveBeenCalledTimes(1);
        expect(page).toHaveLength(21);
        const last = page.at(-1)!;
        const rest = await reader.list(spaceId.value, {
            factDate: last.relevantDate ?? last.factDate!,
            id: last.id,
        });
        expect(rest).toHaveLength(2);
        expect(new Set([...page, ...rest].map((r) => r.id)).size).toBe(23);
        const projected = [...page, ...rest].find(
            (r) => r.id === created.commitment.id,
        )!;
        const detail = await reader.detail(
            spaceId.value,
            created.commitment.id,
        );
        expect(projected).toMatchObject({
            disbursement: null,
            assumedAmountInCents: 600,
            paidAmountInCents: 0,
            supportedAmountInCents: 600,
            remainingAmountInCents: 400,
            externalOutstandingAmountInCents: 400,
            status: 'PARTIALLY_FULFILLED',
        });
        expect(projected.externalLiabilities).toEqual(
            detail?.externalLiabilities,
        );
    });
    it('writes one allowlisted audit per command and none for replay', async () => {
        const handler = app.get(RecordPersonalExpenseHandler);
        const command = {
            ...context(),
            description: 'Conta',
            amountInCents: 100,
            factDate: date,
            disbursement: { method: 'PIX' as const },
        };
        const result = await handler.execute(command);
        expect((await handler.execute(command)).replayed).toBe(true);
        expect(await db.query('SELECT * FROM financial_command_audit')).toEqual(
            [
                {
                    actor_id: actorId.value,
                    action: 'RECORD_PERSONAL_EXPENSE',
                    idempotency_key: command.idempotencyKey,
                    space_id: spaceId.value,
                    commitment_id: result.commitment.id,
                    registered_at: new Date('2026-10-14T15:00:00Z'),
                },
            ],
        );
    });
    it('rolls back the financial fact and receipt when audit fails', async () => {
        await db.query(
            `CREATE FUNCTION fail_command_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit unavailable'; END $$`,
        );
        await db.query(
            `CREATE TRIGGER reject_command_audit BEFORE INSERT ON financial_command_audit FOR EACH ROW EXECUTE FUNCTION fail_command_audit()`,
        );
        try {
            await expect(expense()).rejects.toThrow('Audit unavailable');
            const [counts] = await db.query(
                `SELECT (SELECT count(*) FROM financial_commitments)::int AS commitments,(SELECT count(*) FROM financial_expense_command_receipts)::int AS receipts,(SELECT count(*) FROM financial_command_audit)::int AS audit`,
            );
            expect(counts).toEqual({ commitments: 0, receipts: 0, audit: 0 });
        } finally {
            await db.query(
                'DROP TRIGGER reject_command_audit ON financial_command_audit',
            );
            await db.query('DROP FUNCTION fail_command_audit()');
        }
    });
    it('reverts and reapplies only the added audit table/index', async () => {
        const created = await expense(),
            runner = db.createQueryRunner(),
            migration = new FinancialCommandAudit1792154979034();
        await runner.connect();
        try {
            await migration.down(runner);
            expect(
                await db.query(
                    'SELECT id FROM financial_commitments WHERE id=$1',
                    [created.commitment.id],
                ),
            ).toHaveLength(1);
            await migration.up(runner);
            expect(
                await db.query('SELECT * FROM financial_command_audit'),
            ).toEqual([]);
        } finally {
            await runner.release();
        }
    });
});
