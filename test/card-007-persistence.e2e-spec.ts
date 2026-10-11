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
import {
    GetInterMemberPositionQuery,
    encodePositionCursor,
} from '../dist/modules/finances/application/queries/inter-member-position.query.js';
import { TypeOrmInterMemberPositionReader } from '../dist/modules/finances/infrastructure/typeorm/queries/typeorm-inter-member-position-reader.js';
import {
    INTER_MEMBER_POSITION_READER,
    type InterMemberPositionReader,
} from '../dist/modules/finances/application/ports/private/inter-member-position-reader.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../dist/modules/spaces/application/ports/public/space-financial-context.port.js';
import { EntityManagerProvider } from '../dist/shared/technical/database/typeorm/entity-manager.provider.js';
import { PersonId } from '../dist/modules/spaces/domain/person/person-id.js';
import { SpaceId } from '../dist/modules/spaces/domain/space/space-id.js';
import { FINANCES_CLOCK } from '../dist/modules/finances/application/ports/private/shared-expense.repositories.js';
import { SpacesDomainError } from '../dist/modules/spaces/domain/errors/spaces-domain.error.js';
import type { RecordSharedCashExpenseCommand } from '../dist/modules/finances/application/models/shared-cash-expense.js';
describe('CARD-007 PostgreSQL read model', () => {
    let app: INestApplication,
        db: DataSource,
        handler: RecordSharedCashExpenseHandler,
        query: GetInterMemberPositionQuery;
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
        handler = app.get(RecordSharedCashExpenseHandler);
        query = app.get(GetInterMemberPositionQuery);
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
    function input(amount = 35000, payer = mb): RecordSharedCashExpenseCommand {
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
            settlement: { mode: 'NONE' },
        };
    }
    const position = (
        person = a,
        direction: 'ALL' | 'PAYABLE' | 'RECEIVABLE' = 'ALL',
        cursor?: string,
    ) =>
        query.execute(
            PersonId.from(person),
            SpaceId.from(space),
            direction,
            cursor,
        );
    async function financialState() {
        const tables = [
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
        ];
        const state: Record<string, unknown> = {};
        for (const table of tables)
            state[table] = await db.query(
                `SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`,
            );
        return state;
    }
    it('keeps equal descriptions as two origins and reverses member perspective', async () => {
        const payable = await handler.execute(input()),
            receivable = await handler.execute(input(8000, ma));
        const result = await position();
        expect(result.summary).toEqual({
            payableAmountInCents: '35000',
            receivableAmountInCents: '8000',
            net: { direction: 'PAYABLE', amountInCents: '27000' },
        });
        expect(result.items.map((i) => i.origin.commitmentId).sort()).toEqual(
            [payable.commitment.id, receivable.commitment.id].sort(),
        );
        const reverse = await position(b);
        expect(reverse.summary).toEqual({
            payableAmountInCents: '8000',
            receivableAmountInCents: '35000',
            net: { direction: 'RECEIVABLE', amountInCents: '27000' },
        });
        expect(reverse.items).toEqual(result.items);
        const filtered = await position(a, 'RECEIVABLE');
        expect(filtered.items).toHaveLength(1);
        expect(filtered.summary).toEqual(result.summary);
        expect(filtered.items[0].origin.disbursementId).toBe(
            receivable.disbursement.id,
        );
    });
    it('balanced positive gross amounts keep both open obligations untouched', async () => {
        await handler.execute(input(8000));
        await handler.execute(input(8000, ma));
        const result = await position();
        expect(result.items).toHaveLength(2);
        expect(result.summary).toEqual({
            payableAmountInCents: '8000',
            receivableAmountInCents: '8000',
            net: { direction: 'BALANCED', amountInCents: '0' },
        });
    });
    it('reads reduced and zero remaining fixtures without implementing a reduction command', async () => {
        const reduced = await handler.execute(input()),
            zero = await handler.execute(input(1000));
        await db.query(
            'UPDATE inter_member_obligations SET remaining_amount_in_cents=$2 WHERE id=$1',
            [reduced.obligation!.id, 15000],
        );
        await db.query(
            'UPDATE inter_member_obligations SET remaining_amount_in_cents=0 WHERE id=$1',
            [zero.obligation!.id],
        );
        const result = await position();
        expect(result.items).toHaveLength(1);
        expect(result.items[0]).toMatchObject({
            originalAmountInCents: 35000,
            remainingAmountInCents: 15000,
        });
        expect(result.summary.payableAmountInCents).toBe('15000');
        await expect(
            db.query(
                'UPDATE inter_member_obligations SET remaining_amount_in_cents=-1 WHERE id=$1',
                [reduced.obligation!.id],
            ),
        ).rejects.toMatchObject({ code: '23514' });
    });
    it('sums above safe integer exactly and keeps individual cents safe', async () => {
        await handler.execute(input(Number.MAX_SAFE_INTEGER));
        await handler.execute(input(Number.MAX_SAFE_INTEGER));
        await handler.execute(input(1, ma));
        const result = await position();
        expect(result.summary).toEqual({
            payableAmountInCents: '18014398509481982',
            receivableAmountInCents: '1',
            net: { direction: 'PAYABLE', amountInCents: '18014398509481981' },
        });
        expect(
            result.items.every((i) =>
                Number.isSafeInteger(i.originalAmountInCents),
            ),
        ).toBe(true);
    });
    it('includes absent, overdue and future cycles without inferring a date relation', async () => {
        await handler.execute(input());
        const overdueFixture = await handler.execute({
            ...input(),
            settlement: { mode: 'DATE', targetDate: '2026-10-15' },
        });
        await db.query(
            'UPDATE settlement_cycles SET target_date=$2 WHERE id=$1',
            [overdueFixture.settlementCycle!.id, '2026-02-15'],
        );
        await handler.execute({
            ...input(),
            settlement: { mode: 'DATE', targetDate: '2027-02-15' },
        });
        const result = await position();
        expect(result.items).toHaveLength(3);
        expect(result.summary.payableAmountInCents).toBe('105000');
        expect(
            result.items
                .map((i) => i.settlementCycle?.targetDate ?? null)
                .sort(),
        ).toEqual([null, '2026-02-15', '2027-02-15'].sort());
        expect(
            result.items.every(
                (i) =>
                    i.factDate === '2026-01-05' &&
                    i.registeredAt === '2026-10-10T15:00:00.000000Z',
            ),
        ).toBe(true);
    });
    it('paginates ties and microseconds without losing or repeating identities', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 43; i++) {
            const result = await handler.execute(input(1));
            ids.push(result.obligation!.id);
        }
        await db.query(
            `UPDATE inter_member_obligations SET registered_at='2026-10-10T15:00:00.123455Z' WHERE id=ANY($1::uuid[])`,
            [ids.slice(0, 21)],
        );
        await db.query(
            `UPDATE inter_member_obligations SET registered_at='2026-10-10T15:00:00.123456Z' WHERE id=ANY($1::uuid[])`,
            [ids.slice(21)],
        );
        const first = await position(),
            second = await position(a, 'ALL', first.page.nextCursor!),
            third = await position(a, 'ALL', second.page.nextCursor!);
        expect([
            first.items.length,
            second.items.length,
            third.items.length,
        ]).toEqual([20, 20, 3]);
        expect(third.page.nextCursor).toBeNull();
        const combined = [...first.items, ...second.items, ...third.items];
        expect(new Set(combined.map((i) => i.id)).size).toBe(43);
        const expected = [
            ...ids.slice(21).sort().reverse(),
            ...ids.slice(0, 21).sort().reverse(),
        ];
        expect(combined.map((i) => i.id)).toEqual(expected);
        expect(
            [first, second, third].every(
                (p) => p.summary.payableAmountInCents === '43',
            ),
        ).toBe(true);
        const cursor = encodePositionCursor(
            space,
            a,
            'ALL',
            third.items.at(-1)!,
        );
        const empty = await position(a, 'ALL', cursor);
        expect(empty.items).toEqual([]);
        expect(empty.summary.payableAmountInCents).toBe('43');
    });
    it('updates next response totals without promising a snapshot between pages', async () => {
        for (let i = 0; i < 21; i++) await handler.execute(input(1));
        const first = await position();
        await handler.execute(input(9));
        const next = await position(a, 'ALL', first.page.nextCursor!);
        expect(next.summary.payableAmountInCents).toBe('30');
        expect(
            next.items.every(
                (i) => !first.items.some((previous) => previous.id === i.id),
            ),
        ).toBe(true);
    });
    it('returns global totals even for an empty direction filter', async () => {
        await handler.execute(input());
        const result = await position(a, 'RECEIVABLE');
        expect(result.items).toEqual([]);
        expect(result.summary.payableAmountInCents).toBe('35000');
    });
    it.each(['CLOSING', 'CLOSED'])(
        'reads %s lifecycle fixture',
        async (status) => {
            await handler.execute(input());
            await db.query('UPDATE spaces SET status=$2 WHERE id=$1', [
                space,
                status,
            ]);
            expect(await position()).toMatchObject({
                spaceStatus: status,
                summary: { payableAmountInCents: '35000' },
            });
        },
    );
    it('reauthorizes through public Spaces port after SQL and suppresses lost access', async () => {
        await handler.execute(input());
        const access = app.get<SpaceFinancialContextPort>(
                SPACE_FINANCIAL_CONTEXT_PORT,
            ),
            original = access.read.bind(access);
        vi.spyOn(access, 'read')
            .mockImplementationOnce(original)
            .mockRejectedValueOnce(new SpacesDomainError('SPACE_NOT_FOUND'));
        await expect(position()).rejects.toMatchObject({
            code: 'SPACE_NOT_FOUND',
        });
    });
    it('executes one read-only financial snapshot statement with existing space index', async () => {
        await handler.execute(input());
        const managers = app.get(EntityManagerProvider),
            manager = managers.get();
        const spy = vi.spyOn(manager, 'query');
        const reader = new TypeOrmInterMemberPositionReader(managers);
        const result = await reader.read(space, ma, 'ALL', null);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(result.payableAmountInCents).toBe('35000');
        const [sql, parameters] = spy.mock.calls[0];
        vi.restoreAllMocks();
        const runner = db.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
            await runner.query('SET TRANSACTION READ ONLY');
            expect((await runner.query(sql, parameters))[0].payable).toBe(
                '35000',
            );
            await runner.commitTransaction();
        } finally {
            await runner.release();
        }
        const plan = await db.query('EXPLAIN (FORMAT JSON) ' + sql, parameters);
        expect(JSON.stringify(plan)).toContain('IDX_obligations_space_origin');
    });
    it('repeated GET read model preserves all financial contents and versions', async () => {
        await handler.execute({
            ...input(),
            settlement: { mode: 'DATE', targetDate: '2026-10-31' },
        });
        await handler.execute(input(8000, ma));
        const before = await financialState();
        const first = await position();
        for (let i = 0; i < 3; i++) expect(await position()).toEqual(first);
        expect(await financialState()).toEqual(before);
    });
    it('returns valid empty shared state and self-funded expense never creates obligation', async () => {
        expect((await position()).items).toEqual([]);
        const command = input();
        command.responsibilitySplit = {
            mode: 'AMOUNTS',
            shares: [
                { memberId: ma, amountInCents: 0 },
                { memberId: mb, amountInCents: 35000 },
            ],
        };
        await handler.execute(command);
        expect(await position()).toMatchObject({
            items: [],
            summary: {
                payableAmountInCents: '0',
                receivableAmountInCents: '0',
            },
        });
    });
    it('never reads private financial rows for outside person', async () => {
        const reader = app.get<InterMemberPositionReader>(
            INTER_MEMBER_POSITION_READER,
        );
        const spy = vi.spyOn(reader, 'read');
        await expect(position(randomUUID())).rejects.toMatchObject({
            code: 'SPACE_NOT_FOUND',
        });
        expect(spy).not.toHaveBeenCalled();
    });
});
