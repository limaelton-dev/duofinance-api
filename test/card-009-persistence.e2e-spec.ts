import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
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
import { AppModule } from '../dist/app.module.js';
import migrationSource from '../dist/shared/technical/database/typeorm/data-source.js';
import { TEST_DATABASE_URL } from './setup-env.js';
import { RecordSharedCashExpenseHandler } from '../dist/modules/finances/application/handlers/record-shared-cash-expense.handler.js';
import { RecordManualSettlementTransferHandler } from '../dist/modules/finances/application/handlers/record-manual-settlement-transfer.handler.js';
import {
    GetSettlementTransferOptionsQuery,
    GetSettlementTransferQuery,
    ListSettlementTransfersQuery,
} from '../dist/modules/finances/application/queries/settlement-transfer.queries.js';
import { GetSettlementCycleQuery } from '../dist/modules/finances/application/queries/settlement-cycle.queries.js';
import { GetInterMemberPositionQuery } from '../dist/modules/finances/application/queries/inter-member-position.query.js';
import { GetFinancialCommitmentQuery } from '../dist/modules/finances/application/queries/shared-cash-expense.queries.js';
import { PersonId } from '../dist/modules/spaces/domain/person/person-id.js';
import { SpaceId } from '../dist/modules/spaces/domain/space/space-id.js';
import { FINANCES_CLOCK } from '../dist/modules/finances/application/ports/private/shared-expense.repositories.js';
import type { RecordSettlementTransferCommand } from '../dist/modules/finances/application/models/settlement-transfer.js';

describe('CARD-009 PostgreSQL settlement transfer', () => {
    let app: INestApplication,
        db: DataSource,
        expense: RecordSharedCashExpenseHandler,
        record: RecordManualSettlementTransferHandler,
        options: GetSettlementTransferOptionsQuery,
        detail: GetSettlementTransferQuery,
        history: ListSettlementTransfersQuery,
        cycle: GetSettlementCycleQuery,
        position: GetInterMemberPositionQuery,
        origin: GetFinancialCommitmentQuery;
    let a: string, b: string, ma: string, mb: string, space: string;
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
                now: () => new Date('2026-10-10T15:00:00Z'),
                today: () => '2026-10-10',
            })
            .compile();
        app = module.createNestApplication();
        await app.init();
        db = app.get(DataSource);
        expense = app.get(RecordSharedCashExpenseHandler);
        record = app.get(RecordManualSettlementTransferHandler);
        options = app.get(GetSettlementTransferOptionsQuery);
        detail = app.get(GetSettlementTransferQuery);
        history = app.get(ListSettlementTransfersQuery);
        cycle = app.get(GetSettlementCycleQuery);
        position = app.get(GetInterMemberPositionQuery);
        origin = app.get(GetFinancialCommitmentQuery);
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
            `INSERT INTO spaces(id,type,status,name,created_by_person_id,version,created_at,updated_at) VALUES($1,'SHARED','ACTIVE','Casa',$2,2,now(),now())`,
            [space, a],
        );
        await db.query(
            `INSERT INTO space_members(id,space_id,person_id,status,slot,joined_at) VALUES($1,$3,$4,'ACTIVE',1,now()),($2,$3,$5,'ACTIVE',2,now())`,
            [ma, mb, space, a, b],
        );
    });
    afterEach(async () => {
        await app?.close();
    });
    async function obligation(
        amount: number,
        targetDate: string | null = '2026-10-31',
        payer = mb,
    ) {
        return expense.execute({
            actorId: PersonId.from(a),
            spaceId: SpaceId.from(space),
            idempotencyKey: randomUUID(),
            expectedSpaceVersion: 2,
            description: 'Origem',
            amountInCents: amount,
            factDate: '2026-10-01',
            responsibilitySplit: {
                mode: 'AMOUNTS',
                shares: [
                    { memberId: ma, amountInCents: payer === mb ? amount : 0 },
                    { memberId: mb, amountInCents: payer === ma ? amount : 0 },
                ],
            },
            expectedPayerMemberId: null,
            disbursement: { payerMemberId: payer, method: 'PIX' },
            settlement: targetDate
                ? { mode: 'DATE', targetDate }
                : { mode: 'NONE' },
        });
    }
    function command(
        id: string,
        version: number,
        amount: number,
        key = randomUUID(),
    ): RecordSettlementTransferCommand {
        return {
            actorId: PersonId.from(b),
            spaceId: SpaceId.from(space),
            idempotencyKey: key,
            expectedSpaceVersion: 2,
            payerMemberId: ma,
            recipientMemberId: mb,
            amountInCents: amount,
            factDate: '2026-10-05',
            allocations: [
                {
                    obligationId: id,
                    expectedObligationVersion: version,
                    amountInCents: amount,
                },
            ],
        };
    }
    it('records partial and total transfers with exact history, replay and current readers', async () => {
        const source = await obligation(20000),
            id = source.obligation!.id,
            cycleId = source.settlementCycle!.id;
        const first = await record.execute(command(id, 1, 7000));
        expect(first).toMatchObject({
            replayed: false,
            transfer: {
                amountInCents: 7000,
                createdByPersonId: b,
                mode: 'MANUAL',
            },
            allocations: [{ obligationId: id, amountInCents: 7000 }],
        });
        const secondCommand = command(id, 2, 13000);
        const second = await record.execute(secondCommand);
        expect(await record.execute(secondCommand)).toMatchObject({
            replayed: true,
            transfer: { id: second.transfer.id },
        });
        expect(
            (await position.execute(PersonId.from(a), SpaceId.from(space)))
                .items,
        ).toHaveLength(0);
        expect(
            (
                await cycle.execute(
                    PersonId.from(a),
                    SpaceId.from(space),
                    cycleId,
                )
            ).cycle,
        ).toMatchObject({
            status: 'OPEN',
            totals: {
                originalAmountInCents: '20000',
                resolvedAmountInCents: '20000',
                remainingAmountInCents: '0',
                transferredAmountInCents: '20000',
            },
        });
        const sourceDetail = await origin.execute(
            PersonId.from(a),
            SpaceId.from(space),
            source.commitment.id,
        );
        expect(
            'obligation' in sourceDetail && sourceDetail.obligation,
        ).toMatchObject({ status: 'SETTLED', remainingAmountInCents: 0 });
        const changes = await db.query(
            `SELECT version,type,allocation_id FROM inter_member_obligation_changes WHERE obligation_id=$1 ORDER BY version`,
            [id],
        );
        expect(changes.map((r: { type: string }) => r.type)).toEqual([
            'CREATED',
            'SETTLEMENT_APPLIED',
            'SETTLEMENT_APPLIED',
        ]);
        expect(
            (
                await history.execute(
                    PersonId.from(a),
                    SpaceId.from(space),
                    cycleId,
                    id,
                )
            ).items,
        ).toHaveLength(2);
        expect(
            (
                await detail.execute(
                    PersonId.from(a),
                    SpaceId.from(space),
                    first.transfer.id,
                )
            ).allocations[0].origin.commitmentId,
        ).toBe(source.commitment.id);
        expect(
            (
                await db.query(
                    'SELECT count(*)::int AS count FROM financial_settlement_audit',
                )
            )[0].count,
        ).toBe(2);
    });
    it('allocates one transfer across cycles and an uncategorized obligation', async () => {
        const sources = [
            await obligation(12000, '2026-10-20'),
            await obligation(1500, '2026-10-31'),
            await obligation(1500, null),
        ];
        const c = command(sources[0].obligation!.id, 1, 15000);
        c.allocations = sources.map((s, i) => ({
            obligationId: s.obligation!.id,
            expectedObligationVersion: 1,
            amountInCents: i === 0 ? 12000 : 1500,
        }));
        const saved = await record.execute(c);
        expect(saved.affectedCycleIds).toEqual(
            [
                sources[0].settlementCycle!.id,
                sources[1].settlementCycle!.id,
            ].sort(),
        );
        expect(
            saved.allocations.find(
                (a) => a.obligationId === sources[2].obligation!.id,
            )?.cycleId,
        ).toBeNull();
        for (const s of sources.slice(0, 2))
            expect(
                (
                    await cycle.execute(
                        PersonId.from(a),
                        SpaceId.from(space),
                        s.settlementCycle!.id,
                    )
                ).cycle.totals.transferredAmountInCents,
            ).toBe(String(s.obligation!.originalAmountInCents));
        expect(
            (await options.execute(PersonId.from(a), SpaceId.from(space)))
                .items,
        ).toHaveLength(0);
    });
    it('rejects stale version and reused key with different payload atomically', async () => {
        const source = await obligation(20000),
            id = source.obligation!.id,
            key = randomUUID();
        await record.execute(command(id, 1, 7000, key));
        await expect(
            record.execute(command(id, 1, 7000)),
        ).rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
        await expect(
            record.execute(command(id, 1, 8000, key)),
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
        expect(
            (
                await db.query(
                    'SELECT count(*)::int AS count FROM settlement_transfers',
                )
            )[0].count,
        ).toBe(1);
        expect(
            (
                await db.query(
                    'SELECT remaining_amount_in_cents::text AS amount FROM inter_member_obligations WHERE id=$1',
                    [id],
                )
            )[0].amount,
        ).toBe('13000');
    });
    it('allows resolution in CLOSING and blocks a new command in CLOSED while keeping history', async () => {
        const source = await obligation(20000);
        await db.query(
            `UPDATE spaces SET status='CLOSING',version=3 WHERE id=$1`,
            [space],
        );
        const c = command(source.obligation!.id, 1, 7000);
        c.expectedSpaceVersion = 3;
        const saved = await record.execute(c);
        await db.query(
            `UPDATE spaces SET status='CLOSED',version=4 WHERE id=$1`,
            [space],
        );
        await expect(
            record.execute({
                ...command(source.obligation!.id, 2, 13000),
                expectedSpaceVersion: 4,
            }),
        ).rejects.toMatchObject({ code: 'SPACE_NOT_ACTIVE' });
        expect(
            (
                await detail.execute(
                    PersonId.from(a),
                    SpaceId.from(space),
                    saved.transfer.id,
                )
            ).transfer.id,
        ).toBe(saved.transfer.id);
    });
    it('rejects a newly finalized cycle while preserving the authorized receipt and history', async () => {
        const source = await obligation(10000);
        const input = command(source.obligation!.id, 1, 1000);
        const saved = await record.execute(input);
        await db.query(
            `UPDATE settlement_cycles SET status='FINALIZED',finalized_at=now(),version=version+1 WHERE id=$1`,
            [source.settlementCycle!.id],
        );
        expect((await record.execute(input)).replayed).toBe(true);
        await expect(
            record.execute(command(source.obligation!.id, 2, 1000)),
        ).rejects.toMatchObject({ code: 'SETTLEMENT_CYCLE_FINALIZED' });
        expect(
            (
                await history.execute(
                    PersonId.from(a),
                    SpaceId.from(space),
                    source.settlementCycle!.id,
                    source.obligation!.id,
                )
            ).items[0].transfer.id,
        ).toBe(saved.transfer.id);
        expect(
            (
                await db.query(
                    'SELECT remaining_amount_in_cents::text AS remaining FROM inter_member_obligations WHERE id=$1',
                    [source.obligation!.id],
                )
            )[0].remaining,
        ).toBe('9000');
    });
    it('serializes overlapping obligations in UUID order and recovers concurrent replay', async () => {
        const sources = [await obligation(10000), await obligation(10000)];
        const ids = sources.map((source) => source.obligation!.id).sort();
        const blocked = async (holder: number) => {
            await vi.waitFor(
                async () => {
                    const rows = await db.query(
                        `SELECT pid,wait_event,pg_blocking_pids(pid) AS blockers,left(query,100) AS query FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%inter_member_obligations%'`,
                    );
                    expect(rows.length, JSON.stringify(rows)).toBe(2);
                    expect(
                        rows.some((row: { blockers: number[] }) =>
                            row.blockers.includes(holder),
                        ),
                    ).toBe(true);
                },
                { timeout: 10000, interval: 20 },
            );
        };
        const gate = async <T>(start: () => Promise<T>): Promise<T> => {
            const runner = db.createQueryRunner();
            await runner.connect();
            await runner.startTransaction();
            let pending: Promise<T> | undefined;
            try {
                const [{ pid }] = await runner.query(
                    'SELECT pg_backend_pid() AS pid',
                );
                await runner.query(
                    'SELECT id FROM inter_member_obligations WHERE id=$1 FOR UPDATE',
                    [ids[0]],
                );
                pending = start();
                await blocked(pid);
                await runner.commitTransaction();
                return await pending;
            } finally {
                if (runner.isTransactionActive)
                    await runner.rollbackTransaction();
                await runner.release();
                if (pending) await Promise.allSettled([pending]);
            }
        };
        const first = command(ids[0], 1, 2000, randomUUID());
        first.allocations = ids.map((id) => ({
            obligationId: id,
            expectedObligationVersion: 1,
            amountInCents: 1000,
        }));
        const equivalent = {
            ...first,
            allocations: [...first.allocations].reverse(),
        };
        const sameKey = await gate(() =>
            Promise.all([record.execute(first), record.execute(equivalent)]),
        );
        expect(sameKey.map((result) => result.replayed).sort()).toEqual([
            false,
            true,
        ]);
        expect(new Set(sameKey.map((result) => result.transfer.id)).size).toBe(
            1,
        );
        const newer = command(ids[0], 2, 3000);
        newer.allocations = ids.map((id) => ({
            obligationId: id,
            expectedObligationVersion: 2,
            amountInCents: 1500,
        }));
        const rival = {
            ...newer,
            idempotencyKey: randomUUID(),
            allocations: [...newer.allocations].reverse(),
        };
        const contested = await gate(() =>
            Promise.allSettled([record.execute(newer), record.execute(rival)]),
        );
        expect(
            contested.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        expect(
            contested.filter((result) => result.status === 'rejected'),
        ).toMatchObject([{ reason: { code: 'CONCURRENT_MODIFICATION' } }]);
        const rows = await db.query(
            'SELECT remaining_amount_in_cents::text AS remaining,version FROM inter_member_obligations WHERE id=ANY($1::uuid[]) ORDER BY id',
            [ids],
        );
        expect(rows).toMatchObject([
            { remaining: '7500', version: 3 },
            { remaining: '7500', version: 3 },
        ]);
        for (const table of [
            'settlement_transfers',
            'financial_settlement_command_receipts',
            'financial_settlement_audit',
        ]) {
            const [{ count }] = await db.query(
                `SELECT count(*)::int AS count FROM ${table}`,
            );
            expect(count).toBe(2);
        }
        const [{ count: allocations }] = await db.query(
            'SELECT count(*)::int AS count FROM settlement_allocations',
        );
        expect(allocations).toBe(4);
    }, 30000);
    it('rolls back all facts when the second allocation fails', async () => {
        const sources = [await obligation(10000), await obligation(10000)];
        const ids = sources.map((source) => source.obligation!.id);
        const input = command(ids[0], 1, 3000);
        input.allocations = ids.map((id) => ({
            obligationId: id,
            expectedObligationVersion: 1,
            amountInCents: 1500,
        }));
        await db.query(
            `ALTER TABLE settlement_allocations ADD CONSTRAINT "CHK_test_second_allocation" CHECK (obligation_id <> '${ids[1]}'::uuid)`,
        );
        try {
            await expect(record.execute(input)).rejects.toThrow();
        } finally {
            await db.query(
                'ALTER TABLE settlement_allocations DROP CONSTRAINT "CHK_test_second_allocation"',
            );
        }
        for (const table of [
            'settlement_transfers',
            'settlement_allocations',
            'financial_settlement_command_receipts',
            'financial_settlement_audit',
        ]) {
            const [{ count }] = await db.query(
                `SELECT count(*)::int AS count FROM ${table}`,
            );
            expect(count).toBe(0);
        }
        const obligations = await db.query(
            'SELECT remaining_amount_in_cents::text AS remaining,version FROM inter_member_obligations WHERE id=ANY($1::uuid[]) ORDER BY id',
            [ids],
        );
        expect(obligations).toMatchObject([
            { remaining: '10000', version: 1 },
            { remaining: '10000', version: 1 },
        ]);
        const [{ count: changes }] = await db.query(
            `SELECT count(*)::int AS count FROM inter_member_obligation_changes WHERE type='SETTLEMENT_APPLIED'`,
        );
        expect(changes).toBe(0);
    });
    it('enforces allocation uniqueness and same-space foreign keys in PostgreSQL', async () => {
        const source = await obligation(10000);
        const saved = await record.execute(
            command(source.obligation!.id, 1, 1000),
        );
        const allocation = saved.allocations[0];
        const secondSpace = randomUUID();
        const secondDebtor = randomUUID();
        const secondCreditor = randomUUID();
        await db.query(
            `INSERT INTO spaces(id,type,status,name,created_by_person_id,version,created_at,updated_at) VALUES($1,'SHARED','ACTIVE','Outra casa',$2,2,now(),now())`,
            [secondSpace, a],
        );
        await db.query(
            `INSERT INTO space_members(id,space_id,person_id,status,slot,joined_at) VALUES($1,$3,$4,'ACTIVE',1,now()),($2,$3,$5,'ACTIVE',2,now())`,
            [secondDebtor, secondCreditor, secondSpace, a, b],
        );
        const foreign = await expense.execute({
            actorId: PersonId.from(a),
            spaceId: SpaceId.from(secondSpace),
            idempotencyKey: randomUUID(),
            expectedSpaceVersion: 2,
            description: 'Outra origem',
            amountInCents: 1000,
            factDate: '2026-10-01',
            responsibilitySplit: {
                mode: 'AMOUNTS',
                shares: [
                    { memberId: secondDebtor, amountInCents: 1000 },
                    { memberId: secondCreditor, amountInCents: 0 },
                ],
            },
            expectedPayerMemberId: null,
            disbursement: { payerMemberId: secondCreditor, method: 'PIX' },
            settlement: { mode: 'NONE' },
        });
        await expect(
            db.query(
                `INSERT INTO settlement_allocations(id,space_id,transfer_id,obligation_id,cycle_id,amount_in_cents) VALUES($1,$2,$3,$4,$5,1)`,
                [
                    randomUUID(),
                    space,
                    saved.transfer.id,
                    source.obligation!.id,
                    allocation.cycleId,
                ],
            ),
        ).rejects.toMatchObject({ driverError: { code: '23505' } });
        await expect(
            db.query(
                `INSERT INTO settlement_allocations(id,space_id,transfer_id,obligation_id,cycle_id,amount_in_cents) VALUES($1,$2,$3,$4,$5,1)`,
                [
                    randomUUID(),
                    space,
                    saved.transfer.id,
                    foreign.obligation!.id,
                    null,
                ],
            ),
        ).rejects.toMatchObject({ driverError: { code: '23503' } });
        await expect(
            db.query(
                `INSERT INTO inter_member_obligation_changes(obligation_id,version,space_id,actor_id,type,allocation_id,snapshot,registered_at) VALUES($1,4,$2,$3,'SETTLEMENT_APPLIED',$4,'{}'::jsonb,now())`,
                [source.obligation!.id, space, a, allocation.id],
            ),
        ).rejects.toMatchObject({ driverError: { code: '23505' } });
    });
    it('upgrades prior obligations and receipts without inventing transfers and refuses unsafe downgrade', async () => {
        const source = await obligation(10000);
        const id = source.obligation!.id;
        const before = await db.query(
            'SELECT * FROM financial_expense_command_receipts',
        );
        await migrationSource.initialize();
        try {
            await migrationSource.undoLastMigration();
            await migrationSource.undoLastMigration();
            await db.query(
                'UPDATE inter_member_obligations SET remaining_amount_in_cents=4000 WHERE id=$1',
                [id],
            );
            await migrationSource.runMigrations();
            expect(
                await db.query(
                    'SELECT * FROM financial_expense_command_receipts',
                ),
            ).toEqual(before);
            expect(
                (
                    await db.query(
                        'SELECT status,remaining_amount_in_cents::text AS remaining FROM inter_member_obligations WHERE id=$1',
                        [id],
                    )
                )[0],
            ).toMatchObject({
                status: 'PARTIALLY_SETTLED',
                remaining: '4000',
            });
            expect(
                (
                    await db.query(
                        'SELECT count(*)::int AS count FROM settlement_transfers',
                    )
                )[0].count,
            ).toBe(0);
            const input = command(id, 1, 4000);
            await record.execute(input);
            await migrationSource.undoLastMigration();
            await expect(migrationSource.undoLastMigration()).rejects.toThrow(
                'Cannot downgrade settlement transfers with recorded facts',
            );
            expect((await record.execute(input)).replayed).toBe(true);
        } finally {
            await migrationSource.runMigrations();
            await migrationSource.destroy();
        }
    });
});
