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
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../dist/app.module.js';
import migrationSource from '../dist/shared/technical/database/typeorm/data-source.js';
import { TEST_DATABASE_URL } from './setup-env.js';
import { RecordSharedCashExpenseHandler } from '../dist/modules/finances/application/handlers/record-shared-cash-expense.handler.js';
import { ConfigureDefaultSettlementRuleHandler } from '../dist/modules/finances/application/handlers/configure-default-settlement-rule.handler.js';
import {
    GetSettlementCyclesQuery,
    GetSettlementCycleQuery,
    encodeSettlementListCursor,
    encodeSettlementDetailCursor,
} from '../dist/modules/finances/application/queries/settlement-cycle.queries.js';
import { GetInterMemberPositionQuery } from '../dist/modules/finances/application/queries/inter-member-position.query.js';
import { TypeOrmSettlementCycleReader } from '../dist/modules/finances/infrastructure/typeorm/queries/typeorm-settlement-cycle-reader.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../dist/modules/spaces/application/ports/public/space-financial-context.port.js';
import {
    SETTLEMENT_CYCLE_QUERY_PORT,
    type SettlementCycleQueryPort,
} from '../dist/modules/finances/application/ports/public/settlement-cycle-query.port.js';
import { EntityManagerProvider } from '../dist/shared/technical/database/typeorm/entity-manager.provider.js';
import { PersonId } from '../dist/modules/spaces/domain/person/person-id.js';
import { SpaceId } from '../dist/modules/spaces/domain/space/space-id.js';
import { FINANCES_CLOCK } from '../dist/modules/finances/application/ports/private/shared-expense.repositories.js';
import { SpacesDomainError } from '../dist/modules/spaces/domain/errors/spaces-domain.error.js';
import type { RecordSharedCashExpenseCommand } from '../dist/modules/finances/application/models/shared-cash-expense.js';

describe('CARD-008 PostgreSQL settlement cycle snapshots', () => {
    let app: INestApplication,
        db: DataSource,
        handler: RecordSharedCashExpenseHandler,
        listQuery: GetSettlementCyclesQuery,
        detailQuery: GetSettlementCycleQuery;
    let a: string,
        b: string,
        ma: string,
        mb: string,
        space: string,
        today: string;
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
        today = '2026-10-10';
        const module = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(FINANCES_CLOCK)
            .useValue({
                now: () => new Date(today + 'T15:00:00Z'),
                today: () => today,
            })
            .compile();
        app = module.createNestApplication();
        await app.init();
        db = app.get(DataSource);
        handler = app.get(RecordSharedCashExpenseHandler);
        listQuery = app.get(GetSettlementCyclesQuery);
        detailQuery = app.get(GetSettlementCycleQuery);
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
    function input(
        amount = 35000,
        payer = mb,
        targetDate: string | null = '2026-10-31',
    ): RecordSharedCashExpenseCommand {
        return {
            actorId: PersonId.from(a),
            spaceId: SpaceId.from(space),
            idempotencyKey: randomUUID(),
            expectedSpaceVersion: 2,
            description: 'Mesma descrição',
            amountInCents: amount,
            factDate: '2026-01-05',
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
        };
    }
    const list = (
        view: 'OPEN' | 'UPCOMING' = 'OPEN',
        cursor?: string,
        person = a,
    ) =>
        listQuery.execute(
            PersonId.from(person),
            SpaceId.from(space),
            view,
            cursor,
        );
    const detail = (
        cycle: string,
        direction: 'ALL' | 'PAYABLE' | 'RECEIVABLE' = 'ALL',
        cursor?: string,
        person = a,
    ) =>
        detailQuery.execute(
            PersonId.from(person),
            SpaceId.from(space),
            cycle,
            direction,
            cursor,
        );
    async function emptyCycle(targetDate: string) {
        const id = randomUUID();
        await db.query(
            `INSERT INTO settlement_cycles(id,space_id,target_date,status,version,finalized_at) VALUES($1,$2,$3,'OPEN',1,NULL)`,
            [id, space, targetDate],
        );
        return id;
    }
    async function financialState() {
        const state: Record<string, unknown> = {};
        for (const table of [
            'financial_commitments',
            'financial_commitment_versions',
            'financial_commitment_shares',
            'financial_disbursements',
            'inter_member_obligations',
            'inter_member_obligation_changes',
            'settlement_cycles',
            'financial_expense_command_receipts',
            'default_settlement_rules',
            'default_settlement_rule_changes',
            'finances_command_receipts',
        ])
            state[table] = await db.query(
                `SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`,
            );
        return state;
    }
    it('A01 A02 aggregates each actual expense once and reverses the member position', async () => {
        const payable = await handler.execute(input()),
            receivable = await handler.execute(input(8000, ma)),
            id = payable.settlementCycle!.id;
        expect(receivable.settlementCycle!.id).toBe(id);
        const result = await detail(id);
        expect(result.cycle).toMatchObject({
            obligationCount: 2,
            openObligationCount: 2,
            totals: {
                originalAmountInCents: '43000',
                recognizedAmountInCents: '43000',
                resolvedAmountInCents: '0',
                remainingAmountInCents: '43000',
            },
            position: {
                payableAmountInCents: '35000',
                receivableAmountInCents: '8000',
                net: { direction: 'PAYABLE', amountInCents: '27000' },
            },
        });
        expect(result.items.map((i) => i.origin.commitmentId).sort()).toEqual(
            [payable.commitment.id, receivable.commitment.id].sort(),
        );
        expect((await list()).items).toEqual([
            expect.objectContaining({
                id,
                totals: result.cycle.totals,
                position: result.cycle.position,
            }),
        ]);
        const reverse = await detail(id, 'ALL', undefined, b);
        expect(reverse.cycle.position).toEqual({
            payableAmountInCents: '8000',
            receivableAmountInCents: '35000',
            net: { direction: 'RECEIVABLE', amountInCents: '27000' },
        });
        expect(reverse.items).toEqual(result.items);
        expect((await detail(id, 'RECEIVABLE')).items).toEqual([
            expect.objectContaining({ id: receivable.obligation!.id }),
        ]);
        expect((await detail(id, 'RECEIVABLE')).cycle).toEqual(result.cycle);
    });
    it('A03 balanced positive gross amounts remain overdue and unresolved', async () => {
        const recorded = await handler.execute(input(8000));
        await handler.execute(input(8000, ma));
        await db.query(
            'UPDATE settlement_cycles SET target_date=$2 WHERE id=$1',
            [recorded.settlementCycle!.id, '2026-10-09'],
        );
        const before = await financialState(),
            result = await detail(recorded.settlementCycle!.id);
        expect(result.cycle).toMatchObject({
            status: 'OPEN',
            isOverdue: true,
            openObligationCount: 2,
            totals: {
                originalAmountInCents: '16000',
                recognizedAmountInCents: '16000',
                resolvedAmountInCents: '0',
                remainingAmountInCents: '16000',
            },
            position: { net: { direction: 'BALANCED', amountInCents: '0' } },
        });
        expect(result.items).toHaveLength(2);
        expect(await financialState()).toEqual(before);
    });
    it('A04 keeps partially reduced and zero reading fixtures in composition and totals', async () => {
        const partial = await handler.execute(input(50000)),
            zero = await handler.execute(input(10000));
        await db.query(
            "UPDATE inter_member_obligations SET remaining_amount_in_cents=25000,status='PARTIALLY_SETTLED' WHERE id=$1",
            [partial.obligation!.id],
        );
        await db.query(
            "UPDATE inter_member_obligations SET remaining_amount_in_cents=0,status='SETTLED' WHERE id=$1",
            [zero.obligation!.id],
        );
        const result = await detail(partial.settlementCycle!.id);
        expect(result.cycle).toMatchObject({
            obligationCount: 2,
            openObligationCount: 1,
            totals: {
                originalAmountInCents: '60000',
                recognizedAmountInCents: '60000',
                resolvedAmountInCents: '35000',
                remainingAmountInCents: '25000',
            },
        });
        expect(result.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: partial.obligation!.id,
                    originalAmountInCents: 50000,
                    resolvedAmountInCents: 25000,
                    remainingAmountInCents: 25000,
                }),
                expect.objectContaining({
                    id: zero.obligation!.id,
                    status: 'SETTLED',
                    originalAmountInCents: 10000,
                    resolvedAmountInCents: 10000,
                    remainingAmountInCents: 0,
                }),
            ]),
        );
    });
    it('A05 empty and fully reduced OPEN fixtures stay visible without finalization or overdue', async () => {
        const empty = await emptyCycle('2026-10-08'),
            zero = await handler.execute(input(10000));
        await db.query(
            "UPDATE inter_member_obligations SET remaining_amount_in_cents=0,status='SETTLED' WHERE id=$1",
            [zero.obligation!.id],
        );
        await db.query(
            'UPDATE settlement_cycles SET target_date=$2 WHERE id=$1',
            [zero.settlementCycle!.id, '2026-10-09'],
        );
        const result = await list();
        expect(result.items).toHaveLength(2);
        expect(
            result.items.every((i) => i.status === 'OPEN' && !i.isOverdue),
        ).toBe(true);
        expect(await detail(empty)).toMatchObject({
            cycle: {
                obligationCount: 0,
                openObligationCount: 0,
                totals: {
                    originalAmountInCents: '0',
                    recognizedAmountInCents: '0',
                    resolvedAmountInCents: '0',
                    remainingAmountInCents: '0',
                },
                finalizedAt: null,
            },
            items: [],
        });
        expect((await detail(zero.settlementCycle!.id)).cycle.totals).toEqual({
            originalAmountInCents: '10000',
            recognizedAmountInCents: '10000',
            resolvedAmountInCents: '10000',
            remainingAmountInCents: '0',
            transferredAmountInCents: '0',
            compensatedAmountInCents: '0',
            waivedAmountInCents: '0',
            reversedTransferredAmountInCents: '0',
            effectiveTransferredAmountInCents: '0',
            reversedCompensatedAmountInCents: '0',
            effectiveCompensatedAmountInCents: '0',
        });
        expect((await list('UPCOMING')).items).toEqual([]);
    });
    it('A06 A12 reads yesterday today tomorrow and another year using one civil reference', async () => {
        const ids: string[] = [];
        for (const date of [
            '2026-10-11',
            '2026-10-12',
            '2026-10-13',
            '2027-10-11',
        ])
            ids.push(
                (await handler.execute(input(1, mb, date))).settlementCycle!.id,
            );
        await db.query(
            `UPDATE settlement_cycles SET target_date=target_date-2 WHERE id=ANY($1::uuid[])`,
            [ids.slice(0, 3)],
        );
        const open = await list(),
            upcoming = await list('UPCOMING');
        expect(open.referenceDate).toBe('2026-10-10');
        expect(open.items.map((i) => [i.targetDate, i.isOverdue])).toEqual([
            ['2026-10-09', true],
            ['2026-10-10', false],
            ['2026-10-11', false],
            ['2027-10-11', false],
        ]);
        expect(upcoming.items.map((i) => i.id)).toEqual(ids.slice(1));
        const cursor = encodeSettlementListCursor(
            space,
            a,
            'UPCOMING',
            upcoming.referenceDate,
            upcoming.items[0],
        );
        today = '2026-10-11';
        await expect(list('UPCOMING', cursor)).rejects.toMatchObject({
            code: 'VALIDATION_ERROR',
            fields: ['cursor'],
        });
        expect((await list('UPCOMING')).items.map((i) => i.id)).toEqual(
            ids.slice(2),
        );
        expect((await detail(ids[1])).cycle.isOverdue).toBe(true);
        expect((await detail(ids[1])).cycle.targetDate).toBe('2026-10-10');
    });
    it('A07 keeps retrospective facts and unassigned or other-cycle obligations out after actual default-rule changes', async () => {
        const selected = await handler.execute(input()),
            unassigned = await handler.execute(input(9000, mb, null)),
            other = await handler.execute(input(7000, mb, '2027-01-31'));
        await app.get(ConfigureDefaultSettlementRuleHandler).execute({
            actorId: PersonId.from(a),
            spaceId: SpaceId.from(space),
            key: randomUUID(),
            expectedVersion: 0,
            rule: { kind: 'MONTHLY_DAY', dayOfMonth: 15 },
        });
        const result = await detail(selected.settlementCycle!.id);
        expect(result.items).toEqual([
            expect.objectContaining({
                id: selected.obligation!.id,
                factDate: '2026-01-05',
                registeredAt: '2026-10-10T15:00:00.000000Z',
            }),
        ]);
        expect(result.cycle.targetDate).toBe('2026-10-31');
        expect(result.cycle.totals.originalAmountInCents).toBe('35000');
        const position = await app
            .get(GetInterMemberPositionQuery)
            .execute(PersonId.from(a), SpaceId.from(space));
        expect(position.items.map((i) => i.id).sort()).toEqual(
            [
                selected.obligation!.id,
                unassigned.obligation!.id,
                other.obligation!.id,
            ].sort(),
        );
        expect((await list()).items).toHaveLength(2);
    });
    it('A08 paginates more than twenty existing cycles without duplication in both views', async () => {
        await db.query(
            `INSERT INTO settlement_cycles(id,space_id,target_date,status,version) SELECT md5('card-008-cycle-'||n)::uuid,$1,DATE '2026-10-10'+n,'OPEN',1 FROM generate_series(0,42) n`,
            [space],
        );
        for (const view of ['OPEN', 'UPCOMING'] as const) {
            const first = await list(view),
                second = await list(view, first.page.nextCursor!),
                third = await list(view, second.page.nextCursor!);
            expect([
                first.items.length,
                second.items.length,
                third.items.length,
            ]).toEqual([20, 20, 3]);
            expect(third.page.nextCursor).toBeNull();
            const combined = [...first.items, ...second.items, ...third.items];
            expect(new Set(combined.map((i) => i.id)).size).toBe(43);
            expect(combined.map((i) => i.targetDate)).toEqual(
                combined.map((i) => i.targetDate).sort(),
            );
            expect(
                combined.every(
                    (i) =>
                        i.status === 'OPEN' &&
                        i.totals.remainingAmountInCents === '0',
                ),
            ).toBe(true);
            const exhausted = await list(
                view,
                encodeSettlementListCursor(
                    space,
                    a,
                    view,
                    today,
                    combined.at(-1)!,
                ),
            );
            expect(exhausted.items).toEqual([]);
        }
    });
    it('A09 paginates timestamp microseconds and UUID ties with full cycle totals on every page', async () => {
        const ids: string[] = [];
        let cycle = '';
        for (let i = 0; i < 43; i++) {
            const result = await handler.execute(input(1));
            ids.push(result.obligation!.id);
            cycle = result.settlementCycle!.id;
        }
        await db.query(
            `UPDATE inter_member_obligations SET registered_at='2026-10-10T15:00:00.123455Z' WHERE id=ANY($1::uuid[])`,
            [ids.slice(0, 21)],
        );
        await db.query(
            `UPDATE inter_member_obligations SET registered_at='2026-10-10T15:00:00.123456Z' WHERE id=ANY($1::uuid[])`,
            [ids.slice(21)],
        );
        const first = await detail(cycle),
            second = await detail(cycle, 'ALL', first.page.nextCursor!),
            third = await detail(cycle, 'ALL', second.page.nextCursor!);
        expect([
            first.items.length,
            second.items.length,
            third.items.length,
        ]).toEqual([20, 20, 3]);
        expect(third.page.nextCursor).toBeNull();
        expect(
            [...first.items, ...second.items, ...third.items].map((i) => i.id),
        ).toEqual([
            ...ids.slice(21).sort().reverse(),
            ...ids.slice(0, 21).sort().reverse(),
        ]);
        for (const page of [
            first,
            second,
            third,
            await detail(cycle, 'RECEIVABLE'),
        ])
            expect(page.cycle).toEqual(first.cycle);
        expect(first.cycle).toMatchObject({
            obligationCount: 43,
            openObligationCount: 43,
            totals: {
                originalAmountInCents: '43',
                recognizedAmountInCents: '43',
                resolvedAmountInCents: '0',
                remainingAmountInCents: '43',
            },
        });
        const exhausted = await detail(
            cycle,
            'ALL',
            encodeSettlementDetailCursor(
                space,
                a,
                cycle,
                'ALL',
                third.items.at(-1)!,
            ),
        );
        expect(exhausted.items).toEqual([]);
        expect(exhausted.cycle).toEqual(first.cycle);
    });
    it('A10 aggregates beyond safe integer exactly while individual cents stay safe', async () => {
        const recorded = await handler.execute(input(Number.MAX_SAFE_INTEGER));
        await handler.execute(input(Number.MAX_SAFE_INTEGER));
        await handler.execute(input(1, ma));
        const result = await detail(recorded.settlementCycle!.id);
        expect(result.cycle.totals).toEqual({
            originalAmountInCents: '18014398509481983',
            recognizedAmountInCents: '18014398509481983',
            resolvedAmountInCents: '0',
            remainingAmountInCents: '18014398509481983',
            transferredAmountInCents: '0',
            compensatedAmountInCents: '0',
            waivedAmountInCents: '0',
            reversedTransferredAmountInCents: '0',
            effectiveTransferredAmountInCents: '0',
            reversedCompensatedAmountInCents: '0',
            effectiveCompensatedAmountInCents: '0',
        });
        expect(result.cycle.position).toEqual({
            payableAmountInCents: '18014398509481982',
            receivableAmountInCents: '1',
            net: { direction: 'PAYABLE', amountInCents: '18014398509481981' },
        });
        expect((await list()).items[0].totals).toEqual(result.cycle.totals);
        expect(
            result.items.every((i) =>
                [
                    i.originalAmountInCents,
                    i.resolvedAmountInCents,
                    i.remainingAmountInCents,
                ].every(Number.isSafeInteger),
            ),
        ).toBe(true);
        await db.query(
            "UPDATE inter_member_obligations SET remaining_amount_in_cents=0,status='SETTLED' WHERE debtor_member_id=$1",
            [ma],
        );
        expect(
            (await detail(recorded.settlementCycle!.id)).cycle.totals,
        ).toEqual({
            originalAmountInCents: '18014398509481983',
            recognizedAmountInCents: '18014398509481983',
            resolvedAmountInCents: '18014398509481982',
            remainingAmountInCents: '1',
            transferredAmountInCents: '0',
            compensatedAmountInCents: '0',
            waivedAmountInCents: '0',
            reversedTransferredAmountInCents: '0',
            effectiveTransferredAmountInCents: '0',
            reversedCompensatedAmountInCents: '0',
            effectiveCompensatedAmountInCents: '0',
        });
    });
    it.each(['CLOSING', 'CLOSED'])(
        'A14 reads accessible %s and FINALIZED fixtures without lifecycle commands',
        async (status) => {
            const recorded = await handler.execute(input()),
                id = recorded.settlementCycle!.id;
            await db.query('UPDATE spaces SET status=$2 WHERE id=$1', [
                space,
                status,
            ]);
            await db.query(
                `UPDATE settlement_cycles SET status='FINALIZED',finalized_at='2026-10-10T15:01:00.123456Z',version=2 WHERE id=$1`,
                [id],
            );
            const before = await financialState(),
                result = await detail(id);
            expect(result).toMatchObject({
                spaceStatus: status,
                cycle: {
                    id,
                    status: 'FINALIZED',
                    version: 2,
                    isOverdue: false,
                    finalizedAt: '2026-10-10T15:01:00.123456Z',
                    obligationCount: 1,
                },
            });
            expect((await list()).items).toEqual([]);
            expect(await financialState()).toEqual(before);
        },
    );
    it('A13 suppresses results after reauthorization loses access for list and detail', async () => {
        const recorded = await handler.execute(input()),
            access = app.get<SpaceFinancialContextPort>(
                SPACE_FINANCIAL_CONTEXT_PORT,
            ),
            original = access.read.bind(access);
        for (const read of [
            () => list(),
            () => detail(recorded.settlementCycle!.id),
        ]) {
            vi.spyOn(access, 'read')
                .mockImplementationOnce(original)
                .mockRejectedValueOnce(
                    new SpacesDomainError('SPACE_NOT_FOUND'),
                );
            await expect(read()).rejects.toMatchObject({
                code: 'SPACE_NOT_FOUND',
            });
            vi.restoreAllMocks();
        }
    });
    it('A15 public upcoming port returns the same authorized response as the query', async () => {
        await handler.execute(input());
        await emptyCycle('2026-10-10');
        const port = app.get<SettlementCycleQueryPort>(
            SETTLEMENT_CYCLE_QUERY_PORT,
        );
        expect(
            await port.upcoming(PersonId.from(a), SpaceId.from(space)),
        ).toEqual(await list('UPCOMING'));
        await expect(
            port.upcoming(PersonId.from(randomUUID()), SpaceId.from(space)),
        ).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
    });
    it('A16 repeated reads and invalid queries preserve every financial table and version', async () => {
        const recorded = await handler.execute(input()),
            id = recorded.settlementCycle!.id;
        await handler.execute(input(8000, ma));
        const before = await financialState(),
            first = await detail(id),
            initial = await list();
        for (let i = 0; i < 3; i++) {
            expect(await detail(id)).toEqual(first);
            expect(await list()).toEqual(initial);
            await list('UPCOMING');
        }
        await expect(list('OPEN', 'invalid')).rejects.toMatchObject({
            code: 'VALIDATION_ERROR',
        });
        await expect(detail(randomUUID())).rejects.toMatchObject({
            code: 'SETTLEMENT_CYCLE_NOT_FOUND',
        });
        expect(await financialState()).toEqual(before);
    });
    it('A16 list and detail each use one statement executable in a READ ONLY transaction', async () => {
        const recorded = await handler.execute(input()),
            managers = app.get(EntityManagerProvider),
            manager = managers.get(),
            reader = new TypeOrmSettlementCycleReader(managers);
        for (const read of [
            () => reader.list(space, ma, 'OPEN', today, null),
            () =>
                reader.detail(
                    space,
                    ma,
                    recorded.settlementCycle!.id,
                    'ALL',
                    null,
                ),
        ]) {
            const spy = vi.spyOn(manager, 'query');
            await read();
            expect(spy).toHaveBeenCalledTimes(1);
            const [sql, parameters] = spy.mock.calls[0];
            vi.restoreAllMocks();
            const runner = db.createQueryRunner();
            await runner.connect();
            await runner.startTransaction();
            try {
                await runner.query('SET TRANSACTION READ ONLY');
                expect(await runner.query(sql, parameters)).toHaveLength(1);
                await runner.commitTransaction();
            } finally {
                if (runner.isTransactionActive)
                    await runner.rollbackTransaction();
                await runner.release();
            }
        }
    });
    it.each(['list', 'detail'] as const)(
        'A17 %s snapshot remains coherent when a concurrent reduction commits during a blocked read',
        async (kind) => {
            const recorded = await handler.execute(input(50000)),
                id = recorded.settlementCycle!.id,
                managers = app.get(EntityManagerProvider),
                manager = managers.get(),
                reader = new TypeOrmSettlementCycleReader(managers);
            const spy = vi.spyOn(manager, 'query');
            if (kind === 'list')
                await reader.list(space, ma, 'OPEN', today, null);
            else await reader.detail(space, ma, id, 'ALL', null);
            expect(spy).toHaveBeenCalledTimes(1);
            const [sql, parameters] = spy.mock.calls[0];
            vi.restoreAllMocks();
            const before = await db.query(sql, parameters),
                writer = db.createQueryRunner(),
                observer = db.createQueryRunner();
            await writer.connect();
            await observer.connect();
            await writer.startTransaction();
            let pending: Promise<unknown[]> | undefined;
            try {
                const lock = 800008,
                    [{ pid }] = await observer.query(
                        'SELECT pg_backend_pid() AS pid',
                    );
                await writer.query('SELECT pg_advisory_xact_lock($1)', [lock]);
                pending = observer.query(
                    `WITH gate AS MATERIALIZED (SELECT pg_advisory_xact_lock(${lock})) SELECT snapshot.* FROM gate CROSS JOIN LATERAL (${sql}) snapshot`,
                    parameters,
                );
                let waiting = false;
                for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
                    const [state] = await db.query(
                        'SELECT wait_event FROM pg_stat_activity WHERE pid=$1',
                        [pid],
                    );
                    waiting = state?.wait_event === 'advisory';
                }
                expect(waiting).toBe(true);
                await writer.query(
                    "UPDATE inter_member_obligations SET remaining_amount_in_cents=25000,status='PARTIALLY_SETTLED',version=2 WHERE id=$1",
                    [recorded.obligation!.id],
                );
                await writer.query(
                    'UPDATE settlement_cycles SET version=2 WHERE id=$1',
                    [id],
                );
                await writer.commitTransaction();
                expect(await pending).toEqual(before);
                const after = await detail(id);
                expect(after.cycle.totals).toEqual({
                    originalAmountInCents: '50000',
                    recognizedAmountInCents: '50000',
                    resolvedAmountInCents: '25000',
                    remainingAmountInCents: '25000',
                    transferredAmountInCents: '0',
                    compensatedAmountInCents: '0',
                    waivedAmountInCents: '0',
                    reversedTransferredAmountInCents: '0',
                    effectiveTransferredAmountInCents: '0',
                    reversedCompensatedAmountInCents: '0',
                    effectiveCompensatedAmountInCents: '0',
                });
                expect(after.cycle.version).toBe(2);
                expect(after.items[0]).toMatchObject({
                    version: 2,
                    remainingAmountInCents: 25000,
                });
            } finally {
                if (writer.isTransactionActive)
                    await writer.rollbackTransaction();
                if (pending) await pending;
                await observer.release();
                await writer.release();
            }
        },
    );
    it('A18 measures existing cycle and obligation indexes with representative volume and pagination', async () => {
        const recorded = await handler.execute(input(1)),
            selected = recorded.settlementCycle!.id;
        await db.query(
            `INSERT INTO settlement_cycles(id,space_id,target_date,status,version) SELECT md5('card-008-plan-cycle-'||n)::uuid,$1,DATE '2030-01-01'+n,'OPEN',1 FROM generate_series(0,2999) n`,
            [space],
        );
        await db.query(
            `INSERT INTO financial_commitments(id,space_id,kind,modality,description,created_by,version,registered_at) SELECT md5('card-008-plan-origin-'||n)::uuid,$1,'EXPENSE','ONE_TIME','Volume fixture',$2,1,'2026-10-10T15:00:00Z' FROM generate_series(0,2999) n`,
            [space, a],
        );
        await db.query(
            `INSERT INTO financial_commitment_versions(commitment_id,version,space_id,amount_in_cents,fact_date,split_mode,split_input,rule_source_version) SELECT md5('card-008-plan-origin-'||n)::uuid,1,$1,1,'2026-01-05','AMOUNTS','{}'::jsonb,0 FROM generate_series(0,2999) n`,
            [space],
        );
        await db.query(
            `INSERT INTO financial_disbursements(id,space_id,commitment_id,version,payer_member_id,amount_in_cents,method,fact_date,registered_at,recorded_by_person_id,sequence) SELECT md5('card-008-plan-disbursement-'||n)::uuid,$1,md5('card-008-plan-origin-'||n)::uuid,1,$2,1,'PIX','2026-01-05','2026-10-10T15:00:00Z',$3,1 FROM generate_series(0,2999) n`,
            [space, mb, a],
        );
        await db.query(
            `INSERT INTO inter_member_obligations(id,space_id,commitment_id,disbursement_id,debtor_member_id,creditor_member_id,original_amount_in_cents,recognized_amount_in_cents,remaining_amount_in_cents,status,cycle_id,version,fact_date,registered_at) SELECT md5('card-008-plan-obligation-'||n)::uuid,$1,md5('card-008-plan-origin-'||n)::uuid,md5('card-008-plan-disbursement-'||n)::uuid,$2,$3,1,1,1,'OPEN',CASE WHEN n<100 THEN $4::uuid ELSE md5('card-008-plan-cycle-'||n)::uuid END,1,'2026-01-05','2026-10-10T15:00:00Z' FROM generate_series(0,2999) n`,
            [space, ma, mb, selected],
        );
        await db.query('ANALYZE settlement_cycles');
        await db.query('ANALYZE inter_member_obligations');
        await db.query('ANALYZE financial_commitments');
        const managers = app.get(EntityManagerProvider),
            manager = managers.get(),
            reader = new TypeOrmSettlementCycleReader(managers);
        const statements: {
            sql: string;
            parameters: Parameters<DataSource['query']>[1];
        }[] = [];
        for (const read of [
            () =>
                reader.list(space, ma, 'OPEN', today, {
                    targetDate: '2030-01-01',
                    id: '00000000-0000-0000-0000-000000000000',
                }),
            () => reader.detail(space, ma, selected, 'ALL', null),
        ]) {
            const spy = vi.spyOn(manager, 'query');
            await read();
            expect(spy).toHaveBeenCalledTimes(1);
            const [sql, parameters] = spy.mock.calls[0];
            statements.push({ sql, parameters });
            vi.restoreAllMocks();
        }
        const plans = [];
        for (const statement of statements)
            plans.push(
                await db.query(
                    'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + statement.sql,
                    statement.parameters,
                ),
            );
        expect(JSON.stringify(plans[0])).toContain(
            'IDX_settlement_cycles_open',
        );
        expect(JSON.stringify(plans[1])).toContain(
            'IDX_obligations_space_cycle',
        );
        for (const plan of plans) {
            const root = plan[0]['QUERY PLAN'][0];
            expect(root.Plan['Actual Rows']).toBeGreaterThan(0);
            expect(root.Plan['Actual Rows']).toBeLessThanOrEqual(21);
            expect(root['Execution Time']).toBeLessThan(2000);
        }
        expect((await detail(selected)).cycle.obligationCount).toBe(101);
    });
    it('A05 a creator alone and a self-funded actual expense never materialize an empty cycle', async () => {
        await db.query('DELETE FROM space_members WHERE id=$1', [mb]);
        expect((await list()).items).toEqual([]);
        expect((await list('UPCOMING')).members).toHaveLength(1);
        const command = input(10000, ma, null);
        command.responsibilitySplit = {
            mode: 'AMOUNTS',
            shares: [{ memberId: ma, amountInCents: 10000 }],
        };
        const recorded = await handler.execute(command);
        expect(recorded.obligation).toBeNull();
        expect(recorded.settlementCycle).toBeNull();
        expect((await list()).items).toEqual([]);
    });
});
