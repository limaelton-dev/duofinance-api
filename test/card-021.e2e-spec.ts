import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request, {
    type Test as RequestTest,
    type Response as HttpResponse,
} from 'supertest';
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
import {
    SETTLEMENT_ADJUSTMENT_REPOSITORY,
    type SettlementAdjustmentRepository,
} from '../dist/modules/finances/application/ports/private/settlement-adjustment.repository.js';
import { EntityManagerProvider } from '../dist/shared/technical/database/typeorm/entity-manager.provider.js';
import {
    commitmentPath,
    financeBase,
    financeBrowser,
    financeSnapshot,
    recordSharedObligation,
    sharedExpenseInput,
    sharedFinance,
    type SharedFinance,
} from './settlement-fixture.js';

describe('CARD-021 explicit cycle finalization HTTP/PostgreSQL', () => {
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
                now: () => new Date('2026-10-14T15:00:00Z'),
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
        if (migrationSource.isInitialized) {
            await migrationSource.runMigrations();
            await migrationSource.destroy();
        }
        await app?.close();
    });
    const cyclePath = (f: SharedFinance, id: string) =>
        `${financeBase(f.space)}/settlement-cycles/${id}`;
    const finalizeBody = (f: SharedFinance, version = 1) => ({
        expectedSpaceVersion: f.context.version,
        expectedCycleVersion: version,
    });
    const finalize = (
        f: SharedFinance,
        id: string,
        key: string = randomUUID(),
    ) => f.a.post(`${cyclePath(f, id)}/finalize`, finalizeBody(f), key);
    async function emptyCycle(f: SharedFinance, date = '2026-10-20') {
        const id = randomUUID();
        await db.query(
            "INSERT INTO settlement_cycles(id,space_id,target_date,status,version) VALUES($1,$2,$3,'OPEN',1)",
            [id, f.space, date],
        );
        return id;
    }
    function transfer(
        f: SharedFinance,
        entries: { id: string; version: number; amount: number }[],
        payer = f.mb,
        recipient = f.ma,
    ) {
        return f.a.post(`${financeBase(f.space)}/settlement-transfers`, {
            expectedSpaceVersion: f.context.version,
            payerMemberId: payer,
            recipientMemberId: recipient,
            amountInCents: entries.reduce((sum, item) => sum + item.amount, 0),
            factDate: '2026-10-14',
            allocations: entries.map((item) => ({
                obligationId: item.id,
                expectedObligationVersion: item.version,
                amountInCents: item.amount,
            })),
        });
    }

    it('blocks gross reciprocal debt at net zero and finalizes only after explicit offset resolution', async () => {
        const f = await sharedFinance(app);
        const a = await recordSharedObligation(f, 8000, '2026-10-20', f.ma);
        const b = await recordSharedObligation(f, 8000, '2026-10-20', f.mb);
        const id = a.settlementCycle.id as string;
        const before = await financeSnapshot(db);
        const blocked = (await f.a.agent.get(cyclePath(f, id)).expect(200))
            .body;
        expect(blocked.cycle).toMatchObject({
            canFinalize: false,
            finalizationBlockReason: 'OPEN_OBLIGATIONS',
            openObligationCount: 2,
            position: { net: { direction: 'BALANCED', amountInCents: '0' } },
        });
        await finalize(f, id).expect(409);
        expect(await financeSnapshot(db)).toEqual(before);
        await f.a
            .post(`${financeBase(f.space)}/settlement-offsets`, {
                expectedSpaceVersion: f.context.version,
                factDate: '2026-10-14',
                scope: { cycleIds: [id], obligationIds: [] },
                expectedCycleVersions: [{ cycleId: id, version: 1 }],
                allocations: [
                    {
                        obligationId: a.obligation.id,
                        expectedObligationVersion: 1,
                        amountInCents: 8000,
                    },
                    {
                        obligationId: b.obligation.id,
                        expectedObligationVersion: 1,
                        amountInCents: 8000,
                    },
                ],
            })
            .expect(201);
        const zero = (await f.a.agent.get(cyclePath(f, id)).expect(200)).body;
        expect(zero.cycle).toMatchObject({
            status: 'OPEN',
            canFinalize: true,
            finalizationBlockReason: null,
            totals: {
                remainingAmountInCents: '0',
                compensatedAmountInCents: '16000',
                transferredAmountInCents: '0',
            },
        });
        const result = (await finalize(f, id).expect(200)).body;
        expect(result).toMatchObject({
            affectedCycleIds: [id],
            replayed: false,
            cycle: {
                id,
                status: 'FINALIZED',
                version: 2,
                targetDate: '2026-10-20',
                finalizedByPersonId: f.a.context.person.id,
            },
        });
        expect(new Date(result.cycle.finalizedAt).toISOString()).toBe(
            '2026-10-14T15:00:00.000Z',
        );
        const detail = (await f.b.agent.get(cyclePath(f, id)).expect(200)).body;
        expect(detail.cycle).toMatchObject({
            status: 'FINALIZED',
            canFinalize: false,
            finalizationBlockReason: 'SETTLEMENT_CYCLE_FINALIZED',
            totals: zero.cycle.totals,
        });
        expect(detail.items).toEqual(zero.items);
        expect(
            await db.query(
                'SELECT * FROM settlement_cycle_changes WHERE cycle_id=$1',
                [id],
            ),
        ).toHaveLength(1);
    });

    it('requires an explicit command for an overdue empty cycle and preserves authorized replay in CLOSED', async () => {
        const f = await sharedFinance(app);
        const id = await emptyCycle(f, '2026-09-01');
        const key = randomUUID();
        expect(
            (await f.a.agent.get(cyclePath(f, id)).expect(200)).body.cycle,
        ).toMatchObject({
            status: 'OPEN',
            canFinalize: true,
            isOverdue: false,
        });
        const first = (await finalize(f, id, key).expect(200)).body;
        expect(first.cycle.targetDate).toBe('2026-09-01');
        await db.query("UPDATE spaces SET status='CLOSED' WHERE id=$1", [
            f.space,
        ]);
        const before = await financeSnapshot(db);
        expect((await finalize(f, id, key).expect(200)).body).toEqual({
            ...first,
            replayed: true,
        });
        const history = (
            await f.b.agent
                .get(`${financeBase(f.space)}/settlement-cycles`)
                .query({ view: 'FINALIZED' })
                .expect(200)
        ).body;
        expect(history.items.map((item: { id: string }) => item.id)).toEqual([
            id,
        ]);
        await finalize(f, id).expect(409);
        expect(await financeSnapshot(db)).toEqual(before);
        expect(
            await db.query(
                'SELECT * FROM financial_settlement_adjustment_audit WHERE idempotency_key=$1',
                [key],
            ),
        ).toHaveLength(1);
    });

    it('allows finalization after manual settlement and rejects stale, reused or inaccessible confirmation', async () => {
        const f = await sharedFinance(app);
        const entry = await recordSharedObligation(f, 10000, '2026-10-20');
        const id = entry.settlementCycle.id as string;
        await transfer(f, [
            { id: entry.obligation.id, version: 1, amount: 10000 },
        ]).then((r) => expect(r.status).toBe(201));
        expect(
            (await f.a.agent.get(cyclePath(f, id)).expect(200)).body.cycle
                .status,
        ).toBe('OPEN');
        await f.a
            .post(`${cyclePath(f, id)}/finalize`, finalizeBody(f, 2))
            .expect(409);
        const outsider = await financeBrowser(app, 'Terceiro');
        await outsider
            .post(`${cyclePath(f, id)}/finalize`, finalizeBody(f))
            .expect(404);
        const anonymous = request.agent(app.getHttpServer());
        const csrf = (await anonymous.get('/v2/auth/csrf').expect(200)).body
            .csrfToken;
        await anonymous
            .post(`${cyclePath(f, id)}/finalize`)
            .set('Origin', 'http://localhost:3000')
            .set('X-CSRF-Token', csrf)
            .set('Idempotency-Key', randomUUID())
            .send(finalizeBody(f))
            .expect(401);
        await f.a.agent
            .post(`${cyclePath(f, id)}/finalize`)
            .set('Origin', 'http://localhost:3000')
            .set('Idempotency-Key', randomUUID())
            .send(finalizeBody(f))
            .expect(403);
        const key = randomUUID();
        await finalize(f, id, key).expect(200);
        const before = await financeSnapshot(db);
        await f.a
            .post(`${cyclePath(f, id)}/finalize`, finalizeBody(f, 2), key)
            .expect(409);
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('protects finalized composition from all existing expense, income, card and settlement writers', async () => {
        const f = await sharedFinance(app);
        const expense = await recordSharedObligation(
            f,
            100,
            '2026-10-20',
            f.ma,
            200,
        );
        const id = expense.settlementCycle.id as string;
        const split = {
            mode: 'AMOUNTS',
            shares: [
                { memberId: f.ma, amountInCents: 0 },
                { memberId: f.mb, amountInCents: 200 },
            ],
        };
        const income = (
            await f.a
                .post(`${financeBase(f.space)}/incomes`, {
                    description: 'Receita parcial',
                    amountInCents: 200,
                    expectedReceiptDate: '2026-10-20',
                    expectedRecipientMemberId: f.ma,
                    expectedSpaceVersion: f.context.version,
                    participationSplit: split,
                    receipt: {
                        amountInCents: 100,
                        factDate: '2026-10-14',
                        recipientMemberId: f.ma,
                        settlement: { mode: 'CYCLE', cycleId: id },
                    },
                })
                .expect(201)
        ).body;
        const card = (
            await f.a
                .post(`${financeBase(f.space)}/credit-card-purchases`, {
                    description: 'Cartão parcial',
                    amountInCents: 200,
                    factDate: '2026-10-14',
                    expectedSpaceVersion: f.context.version,
                    responsibilitySplit: split,
                    externalLiability: {
                        amountInCents: 100,
                        holderMemberId: f.ma,
                    },
                    settlement: { mode: 'CYCLE', cycleId: id },
                })
                .expect(201)
        ).body;
        await transfer(f, [
            { id: expense.obligation.id, version: 1, amount: 100 },
            { id: card.obligation.id, version: 1, amount: 100 },
        ]).then((r) => expect(r.status).toBe(201));
        await transfer(
            f,
            [{ id: income.obligation.id, version: 1, amount: 100 }],
            f.ma,
            f.mb,
        ).then((r) => expect(r.status).toBe(201));
        await finalize(f, id).expect(200);
        const pendingIncome = (
            await f.a
                .post(`${financeBase(f.space)}/incomes`, {
                    description: 'Sem recebimento',
                    amountInCents: 200,
                    expectedReceiptDate: '2026-10-20',
                    expectedRecipientMemberId: f.ma,
                    expectedSpaceVersion: f.context.version,
                    participationSplit: split,
                    receipt: null,
                })
                .expect(201)
        ).body;
        const movable = await recordSharedObligation(f, 200);
        const before = await financeSnapshot(db);
        const expenseInput = sharedExpenseInput(f, 200, 200, {
            mode: 'CYCLE',
            cycleId: id,
        });
        expenseInput.responsibilitySplit = split;
        const rejected = [
            () =>
                f.a.post(
                    `${financeBase(f.space)}/shared-cash-expenses`,
                    expenseInput,
                ),
            () =>
                f.a.post(`${financeBase(f.space)}/credit-card-purchases`, {
                    description: 'Compra nova',
                    amountInCents: 200,
                    factDate: '2026-10-14',
                    expectedSpaceVersion: f.context.version,
                    responsibilitySplit: split,
                    externalLiability: {
                        amountInCents: 200,
                        holderMemberId: f.ma,
                    },
                    settlement: { mode: 'CYCLE', cycleId: id },
                }),
            () =>
                f.a.post(
                    `${commitmentPath(f.space, pendingIncome.commitment.id)}/receipts`,
                    {
                        expectedSpaceVersion: f.context.version,
                        expectedCommitmentVersion:
                            pendingIncome.commitment.version,
                        amountInCents: 100,
                        factDate: '2026-10-14',
                        recipientMemberId: f.ma,
                        settlement: { mode: 'CYCLE', cycleId: id },
                    },
                ),
            () =>
                f.a.post(
                    `${commitmentPath(f.space, expense.commitment.id)}/disbursements`,
                    {
                        expectedSpaceVersion: f.context.version,
                        expectedCommitmentVersion: expense.commitment.version,
                        amountInCents: 100,
                        factDate: '2026-10-14',
                        payerMemberId: f.ma,
                        method: 'PIX',
                        settlement: { mode: 'NONE' },
                    },
                ),
            () =>
                f.a.post(
                    `${commitmentPath(f.space, income.commitment.id)}/receipts`,
                    {
                        expectedSpaceVersion: f.context.version,
                        expectedCommitmentVersion: income.commitment.version,
                        amountInCents: 100,
                        factDate: '2026-10-14',
                        recipientMemberId: f.ma,
                        settlement: { mode: 'NONE' },
                    },
                ),
            () =>
                f.a.post(
                    `${commitmentPath(f.space, card.commitment.id)}/external-liabilities`,
                    {
                        expectedSpaceVersion: f.context.version,
                        expectedCommitmentVersion: card.commitment.version,
                        amountInCents: 100,
                        factDate: '2026-10-14',
                        holderMemberId: f.ma,
                        settlement: { mode: 'NONE' },
                    },
                ),
            () =>
                f.a.post(
                    `${financeBase(f.space)}/inter-member-obligations/${movable.obligation.id}/settlement-assignment`,
                    {
                        expectedSpaceVersion: f.context.version,
                        expectedObligationVersion: 1,
                        expectedCycleVersions: [{ cycleId: id, version: 2 }],
                        settlement: { mode: 'CYCLE', cycleId: id },
                    },
                ),
            () =>
                transfer(f, [
                    { id: expense.obligation.id, version: 2, amount: 1 },
                ]),
            () =>
                f.a.post(`${financeBase(f.space)}/settlement-offsets`, {
                    expectedSpaceVersion: f.context.version,
                    factDate: '2026-10-14',
                    scope: { cycleIds: [id], obligationIds: [] },
                    expectedCycleVersions: [{ cycleId: id, version: 2 }],
                    allocations: [
                        {
                            obligationId: expense.obligation.id,
                            expectedObligationVersion: 2,
                            amountInCents: 1,
                        },
                        {
                            obligationId: income.obligation.id,
                            expectedObligationVersion: 2,
                            amountInCents: 1,
                        },
                    ],
                }),
        ];
        for (const send of rejected) {
            const response = await send().expect(409);
            expect(response.body.code).toBe('SETTLEMENT_CYCLE_FINALIZED');
            expect(await financeSnapshot(db)).toEqual(before);
        }
    });

    it.each(['insertion', 'movement', 'reconciliation'] as const)(
        'serializes finalization against %s so a finalized cycle never acquires open debt',
        async (kind) => {
            const f = await sharedFinance(app);
            let id: string;
            let writer: () => RequestTest;
            if (kind === 'reconciliation') {
                const initial = await recordSharedObligation(
                    f,
                    100,
                    '2026-10-20',
                    f.ma,
                    200,
                );
                id = initial.settlementCycle.id;
                await transfer(f, [
                    { id: initial.obligation.id, version: 1, amount: 100 },
                ]).then((r) => expect(r.status).toBe(201));
                writer = () =>
                    f.b.post(
                        `${commitmentPath(f.space, initial.commitment.id)}/disbursements`,
                        {
                            expectedSpaceVersion: f.context.version,
                            expectedCommitmentVersion:
                                initial.commitment.version,
                            amountInCents: 100,
                            factDate: '2026-10-14',
                            payerMemberId: f.ma,
                            method: 'PIX',
                            settlement: { mode: 'NONE' },
                        },
                    );
            } else {
                id = await emptyCycle(f);
                if (kind === 'movement') {
                    const loose = await recordSharedObligation(f, 100);
                    writer = () =>
                        f.b.post(
                            `${financeBase(f.space)}/inter-member-obligations/${loose.obligation.id}/settlement-assignment`,
                            {
                                expectedSpaceVersion: f.context.version,
                                expectedObligationVersion: 1,
                                expectedCycleVersions: [
                                    { cycleId: id, version: 1 },
                                ],
                                settlement: { mode: 'CYCLE', cycleId: id },
                            },
                        );
                } else {
                    const body = sharedExpenseInput(f, 100, 100, {
                        mode: 'CYCLE',
                        cycleId: id,
                    });
                    writer = () =>
                        f.b.post(
                            `${financeBase(f.space)}/shared-cash-expenses`,
                            body,
                        );
                }
            }
            const results = await concurrent(f.space, () =>
                Promise.all([finalize(f, id), writer()]),
            );
            expect(results.filter((r) => r.status === 409)).toHaveLength(1);
            expect(
                results.filter((r) => r.status === 200 || r.status === 201),
            ).toHaveLength(1);
            const [state] = await db.query(
                'SELECT status FROM settlement_cycles WHERE id=$1',
                [id],
            );
            const [open] = await db.query(
                'SELECT COUNT(*)::int AS count FROM inter_member_obligations WHERE cycle_id=$1 AND remaining_amount_in_cents>0',
                [id],
            );
            expect(state.status === 'FINALIZED' && open.count > 0).toBe(false);
            expect(state.status === 'FINALIZED').toBe(
                results[0].status === 200,
            );
        },
    );

    it('rolls finalization, history, audit and receipt back together on an audit failure', async () => {
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        const f = await sharedFinance(app);
        const id = await emptyCycle(f);
        const key = randomUUID();
        const before = await financeSnapshot(db);
        await db.query(
            "CREATE FUNCTION reject_card021_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'CARD-021 forced audit failure'; END $$",
        );
        await db.query(
            'CREATE TRIGGER reject_card021_audit BEFORE INSERT ON financial_settlement_adjustment_audit FOR EACH ROW EXECUTE FUNCTION reject_card021_audit()',
        );
        try {
            await finalize(f, id, key).expect(500);
            expect(await financeSnapshot(db)).toEqual(before);
        } finally {
            await db.query(
                'DROP TRIGGER reject_card021_audit ON financial_settlement_adjustment_audit',
            );
            await db.query('DROP FUNCTION reject_card021_audit()');
        }
        await finalize(f, id, key).expect(200);
        expect(
            await db.query(
                'SELECT * FROM settlement_cycle_changes WHERE cycle_id=$1',
                [id],
            ),
        ).toHaveLength(1);
    });

    it('round-trips finalization metadata and refuses to erase a recorded finalization', async () => {
        const f = await sharedFinance(app);
        const id = await emptyCycle(f);
        await migrationSource.initialize();
        while (
            (
                await migrationSource.query(
                    'SELECT name FROM migrations ORDER BY id DESC LIMIT 1',
                )
            )[0].name !== 'FinalizeSettlementCycle1792162609967'
        )
            await migrationSource.undoLastMigration();
        await migrationSource.undoLastMigration();
        expect(
            (
                await db.query(
                    "SELECT to_regclass('settlement_cycle_changes') AS name",
                )
            )[0].name,
        ).toBeNull();
        await migrationSource.runMigrations();
        expect(
            await db.query('SELECT * FROM settlement_cycle_changes'),
        ).toEqual([]);
        await finalize(f, id).expect(200);
        while (
            (
                await migrationSource.query(
                    'SELECT name FROM migrations ORDER BY id DESC LIMIT 1',
                )
            )[0].name !== 'FinalizeSettlementCycle1792162609967'
        )
            await migrationSource.undoLastMigration();
        const before = await financeSnapshot(db);
        const migrations = await db.query(
            'SELECT * FROM migrations ORDER BY id',
        );
        await expect(migrationSource.undoLastMigration()).rejects.toThrow();
        expect(await financeSnapshot(db)).toEqual(before);
        expect(await db.query('SELECT * FROM migrations ORDER BY id')).toEqual(
            migrations,
        );
    });

    it('waits for a writer holding a shared cycle lock and rechecks its committed remainder', async () => {
        const f = await sharedFinance(app);
        const id = await emptyCycle(f);
        const loose = await recordSharedObligation(f, 100);
        const repo = app.get<SettlementAdjustmentRepository>(
            SETTLEMENT_ADJUSTMENT_REPOSITORY,
        );
        const provider = app.get(EntityManagerProvider);
        const save = repo.saveAssignment.bind(repo);
        let entered!: () => void,
            resume!: () => void,
            writerPid = 0;
        const reached = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const released = new Promise<void>((resolve) => {
            resume = resolve;
        });
        vi.spyOn(repo, 'saveAssignment').mockImplementationOnce(
            async (before, after, actorId, now) => {
                const [{ pid }] = await provider
                    .get()
                    .query('SELECT pg_backend_pid() AS pid');
                writerPid = pid;
                entered();
                await released;
                return save(before, after, actorId, now);
            },
        );
        const moving = f.b
            .post(
                `${financeBase(f.space)}/inter-member-obligations/${loose.obligation.id}/settlement-assignment`,
                {
                    expectedSpaceVersion: f.context.version,
                    expectedObligationVersion: 1,
                    expectedCycleVersions: [{ cycleId: id, version: 1 }],
                    settlement: { mode: 'CYCLE', cycleId: id },
                },
            )
            .then((response) => response);
        let finalizing: Promise<HttpResponse> | undefined;
        try {
            await Promise.race([
                reached,
                moving.then(() => {
                    throw new Error('Expected writer to hold cycle lock');
                }),
            ]);
            finalizing = finalize(f, id).then((response) => response);
            await vi.waitFor(
                async () => {
                    const waiting = await db.query(
                        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
                        [writerPid],
                    );
                    expect(waiting).toHaveLength(1);
                },
                { timeout: 10000, interval: 20 },
            );
        } finally {
            resume();
        }
        expect((await moving).status).toBe(200);
        expect((await finalizing!).status).toBe(409);
        expect(
            (await f.a.agent.get(cyclePath(f, id)).expect(200)).body.cycle,
        ).toMatchObject({
            status: 'OPEN',
            totals: { remainingAmountInCents: '100' },
        });
    });

    async function concurrent<T>(space: string, start: () => Promise<T>) {
        const gate = db.createQueryRunner();
        await gate.connect();
        await gate.startTransaction();
        let pending: Promise<T> | undefined;
        try {
            const [{ pid }] = await gate.query(
                'SELECT pg_backend_pid() AS pid',
            );
            await gate.query('SELECT id FROM spaces WHERE id=$1 FOR UPDATE', [
                space,
            ]);
            pending = start();
            await vi.waitFor(
                async () => {
                    const waiting = await db.query(
                        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
                        [pid],
                    );
                    expect(
                        new Set(waiting.map((r: { pid: number }) => r.pid))
                            .size,
                    ).toBe(2);
                },
                { timeout: 10000, interval: 20 },
            );
            await gate.commitTransaction();
            return await pending;
        } finally {
            if (gate.isTransactionActive) await gate.rollbackTransaction();
            await gate.release();
            if (pending) await Promise.allSettled([pending]);
        }
    }
});
