import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
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
import { EntityManagerProvider } from '../dist/shared/technical/database/typeorm/entity-manager.provider.js';
import {
    financeBase,
    financeBrowser,
    financeSnapshot,
    sharedFinance,
    sharedExpenseInput,
    type SharedFinance,
} from './settlement-fixture.js';

describe('overdue and selected cycles HTTP/PostgreSQL', () => {
    let app: INestApplication<Server>, db: DataSource, instant: Date;
    const civilToday = () =>
        new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Sao_Paulo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(instant);

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
        instant = new Date('2026-10-14T15:00:00Z');
        const module = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(FINANCES_CLOCK)
            .useValue({ now: () => instant, today: civilToday })
            .compile();
        app = module.createNestApplication();
        configureApp(app);
        await app.init();
        db = app.get(DataSource);
        await db.query('TRUNCATE persons CASCADE');
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await app?.close();
    });

    const listPath = (f: SharedFinance) =>
        `${financeBase(f.space)}/settlement-cycles`;
    const summaryPath = (f: SharedFinance) => `${listPath(f)}/summary`;
    const list = async (f: SharedFinance, view = 'OVERDUE', cursor?: string) =>
        (
            await f.a.agent
                .get(listPath(f))
                .query({ view, ...(cursor ? { cursor } : {}) })
                .expect(200)
        ).body;
    const summary = async (
        f: SharedFinance,
        ids: string[],
        extra: object = {},
    ) =>
        (
            await f.a.agent
                .get(summaryPath(f))
                .query({ cycleIds: ids.join(','), ...extra })
                .expect(200)
        ).body;
    async function emptyCycle(
        f: SharedFinance,
        date: string,
        finalized = false,
    ) {
        const id = randomUUID();
        await db.query(
            'INSERT INTO settlement_cycles(id,space_id,target_date,status,version,finalized_at) VALUES($1,$2,$3,$4,1,$5)',
            [
                id,
                f.space,
                date,
                finalized ? 'FINALIZED' : 'OPEN',
                finalized ? instant : null,
            ],
        );
        return id;
    }
    async function expense(
        f: SharedFinance,
        amount: number,
        targetDate: string | null,
        payer = f.ma,
    ) {
        const input = sharedExpenseInput(
            f,
            amount,
            amount,
            targetDate ? { mode: 'DATE', targetDate } : { mode: 'NONE' },
        );
        input.responsibilitySplit.shares = [
            { memberId: f.ma, amountInCents: payer === f.ma ? 0 : amount },
            { memberId: f.mb, amountInCents: payer === f.mb ? 0 : amount },
        ];
        input.disbursement.payerMemberId = payer;
        return (
            await f.a
                .post(`${financeBase(f.space)}/shared-cash-expenses`, input)
                .expect(201)
        ).body;
    }
    async function transfer(
        f: SharedFinance,
        entries: { id: string; version: number; amountInCents: number }[],
    ) {
        return (
            await f.a
                .post(`${financeBase(f.space)}/settlement-transfers`, {
                    expectedSpaceVersion: f.context.version,
                    payerMemberId: f.mb,
                    recipientMemberId: f.ma,
                    amountInCents: entries.reduce(
                        (sum, item) => sum + item.amountInCents,
                        0,
                    ),
                    factDate: '2026-10-14',
                    allocations: entries.map(
                        ({ id, version, amountInCents }) => ({
                            obligationId: id,
                            expectedObligationVersion: version,
                            amountInCents,
                        }),
                    ),
                })
                .expect(201)
        ).body;
    }

    it('becomes overdue exactly at São Paulo midnight without altering the cycle date or status', async () => {
        const f = await sharedFinance(app);
        const yesterday = await expense(f, 10000, '2026-10-15');
        const today = await expense(f, 7000, '2026-10-16');
        const tomorrow = await expense(f, 6000, '2026-10-17');
        const resolved = await expense(f, 3000, '2026-10-14');
        await transfer(f, [
            { id: resolved.obligation.id, version: 1, amountInCents: 3000 },
        ]);
        await emptyCycle(f, '2026-10-13');
        await emptyCycle(f, '2026-10-12', true);
        instant = new Date('2026-10-16T02:59:59Z');
        const before = await financeSnapshot(db);
        expect((await list(f)).items).toEqual([]);
        instant = new Date('2026-10-16T03:00:00Z');
        const overdue = await list(f);
        expect(overdue.referenceDate).toBe('2026-10-16');
        expect(overdue.items.map((item: { id: string }) => item.id)).toEqual([
            yesterday.settlementCycle.id,
        ]);
        expect(overdue.items[0]).toMatchObject({
            status: 'OPEN',
            targetDate: '2026-10-15',
            isOverdue: true,
            totals: { remainingAmountInCents: '10000' },
        });
        expect(
            (await list(f, 'UPCOMING')).items.map(
                (item: { id: string }) => item.id,
            ),
        ).toEqual([today.settlementCycle.id, tomorrow.settlementCycle.id]);
        expect((await list(f, 'OPEN')).items).toHaveLength(5);
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('summarizes only selected cycles, preserving gross directions and allocation amounts across a transfer', async () => {
        const f = await sharedFinance(app);
        const one = await expense(f, 10000, '2026-10-20');
        const two = await expense(f, 7000, '2026-10-21');
        const outside = await expense(f, 9000, '2026-10-22');
        const reverse = await expense(f, 3000, '2026-10-20', f.mb);
        await expense(f, 1234, null);
        const applied = await transfer(f, [
            { id: one.obligation.id, version: 1, amountInCents: 2000 },
            { id: two.obligation.id, version: 1, amountInCents: 1000 },
            { id: outside.obligation.id, version: 1, amountInCents: 4000 },
        ]);
        const ids = [one.settlementCycle.id, two.settlementCycle.id];
        const before = await financeSnapshot(db);
        const result = await summary(f, ids);
        expect(
            result.selectedCycles.map((item: { id: string }) => item.id).sort(),
        ).toEqual(ids.sort());
        expect(result.totals).toMatchObject({
            originalAmountInCents: '20000',
            recognizedAmountInCents: '20000',
            resolvedAmountInCents: '3000',
            remainingAmountInCents: '17000',
            transferredAmountInCents: '3000',
            transferTotalAmountInCents: '7000',
            transferCount: 1,
            grossPayableAmountInCents: '3000',
            grossReceivableAmountInCents: '17000',
        });
        expect(result.position).toEqual({
            payableAmountInCents: '3000',
            receivableAmountInCents: '14000',
            net: { direction: 'RECEIVABLE', amountInCents: '11000' },
        });
        expect(
            result.items.map((item: { id: string }) => item.id).sort(),
        ).toEqual(
            [
                one.obligation.id,
                two.obligation.id,
                reverse.obligation.id,
            ].sort(),
        );
        const opposite = (
            await f.b.agent
                .get(summaryPath(f))
                .query({ cycleIds: ids.join(',') })
                .expect(200)
        ).body;
        expect(opposite.position).toEqual({
            payableAmountInCents: '14000',
            receivableAmountInCents: '3000',
            net: { direction: 'PAYABLE', amountInCents: '11000' },
        });
        expect(applied.transfer.amountInCents).toBe(7000);
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('supports an empty selection result and finalized cycles as read-only history in a closed space', async () => {
        const f = await sharedFinance(app);
        const one = await emptyCycle(f, '2026-10-20');
        const two = await emptyCycle(f, '2026-10-21', true);
        await db.query("UPDATE spaces SET status='CLOSED' WHERE id=$1", [
            f.space,
        ]);
        const before = await financeSnapshot(db);
        const result = await summary(f, [one, two]);
        expect(result).toMatchObject({
            spaceStatus: 'CLOSED',
            items: [],
            totals: {
                originalAmountInCents: '0',
                remainingAmountInCents: '0',
                transferredAmountInCents: '0',
            },
            position: { net: { direction: 'BALANCED', amountInCents: '0' } },
        });
        expect(
            result.selectedCycles.find(
                (item: { id: string }) => item.id === two,
            ),
        ).toMatchObject({ status: 'FINALIZED', readOnly: true });
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('validates the whole explicit selection, membership, minimum two, duplicates and maximum fifty', async () => {
        const f = await sharedFinance(app);
        const ids: string[] = [];
        for (let day = 1; day <= 28; day++)
            ids.push(
                await emptyCycle(f, `2027-02-${String(day).padStart(2, '0')}`),
            );
        for (let day = 1; day <= 23; day++)
            ids.push(
                await emptyCycle(f, `2027-03-${String(day).padStart(2, '0')}`),
            );
        expect(
            (await summary(f, ids.slice(0, 50))).selectedCycles,
        ).toHaveLength(50);
        for (const cycleIds of [
            '',
            ids[0],
            [ids[0], ids[0]].join(','),
            ids.join(','),
            'not-a-uuid,' + ids[0],
        ]) {
            const response = await f.a.agent
                .get(summaryPath(f))
                .query({ cycleIds })
                .expect(400);
            expect(response.body.code).toBe('VALIDATION_ERROR');
            expect(JSON.stringify(response.body)).not.toMatch(
                /must be|Invalid|Expected/,
            );
        }
        const outsider = await financeBrowser(app, 'Terceiro');
        await request(app.getHttpServer())
            .get(summaryPath(f))
            .query({ cycleIds: ids.slice(0, 2).join(',') })
            .expect(401);
        await outsider.agent
            .get(summaryPath(f))
            .query({ cycleIds: ids.slice(0, 2).join(',') })
            .expect(404);
        await f.a.agent
            .get(summaryPath(f))
            .query({ cycleIds: [ids[0], randomUUID()].join(',') })
            .expect(404);
        const otherSpace = (
            await f.a.post('/v2/spaces', { name: 'Outro espaço' }).expect(201)
        ).body.space.id;
        const foreign = await emptyCycle(
            { ...f, space: otherSpace },
            '2026-10-20',
        );
        await f.a.agent
            .get(summaryPath(f))
            .query({ cycleIds: [ids[0], foreign].join(',') })
            .expect(404);
    });

    it('exposes expense, income and card origins with their individual economic distribution', async () => {
        const f = await sharedFinance(app);
        const cash = (
            await f.a
                .post(
                    `${financeBase(f.space)}/shared-cash-expenses`,
                    sharedExpenseInput(f, 10000, 10000, {
                        mode: 'DATE',
                        targetDate: '2026-10-20',
                    }),
                )
                .expect(201)
        ).body;
        const income = (
            await f.a
                .post(`${financeBase(f.space)}/incomes`, {
                    description: 'Receita dividida',
                    amountInCents: 20000,
                    expectedReceiptDate: '2026-10-20',
                    expectedRecipientMemberId: f.ma,
                    expectedSpaceVersion: f.context.version,
                    participationSplit: {
                        mode: 'AMOUNTS',
                        shares: [
                            { memberId: f.ma, amountInCents: 8000 },
                            { memberId: f.mb, amountInCents: 12000 },
                        ],
                    },
                    receipt: {
                        recipientMemberId: f.ma,
                        amountInCents: 20000,
                        factDate: '2026-10-14',
                        settlement: { mode: 'DATE', targetDate: '2026-10-21' },
                    },
                })
                .expect(201)
        ).body;
        const card = (
            await f.a
                .post(`${financeBase(f.space)}/credit-card-purchases`, {
                    description: 'Cartão dividido',
                    amountInCents: 15000,
                    factDate: '2026-10-14',
                    expectedSpaceVersion: f.context.version,
                    responsibilitySplit: {
                        mode: 'AMOUNTS',
                        shares: [
                            { memberId: f.ma, amountInCents: 6000 },
                            { memberId: f.mb, amountInCents: 9000 },
                        ],
                    },
                    externalLiability: {
                        holderMemberId: f.ma,
                        amountInCents: 15000,
                    },
                    settlement: { mode: 'DATE', targetDate: '2026-10-21' },
                })
                .expect(201)
        ).body;
        const result = await summary(f, [
            cash.settlementCycle.id,
            income.settlementCycle.id,
        ]);
        const expected = [
            {
                id: cash.obligation.id,
                kind: 'EXPENSE',
                commitmentId: cash.commitment.id,
                amount: 10000,
                distribution: 'RESPONSIBILITY',
                actorAmount: 6000,
                factKey: 'disbursementId',
                factId: cash.disbursement.id,
            },
            {
                id: income.obligation.id,
                kind: 'INCOME',
                commitmentId: income.commitment.id,
                amount: 20000,
                distribution: 'PARTICIPATION',
                actorAmount: 8000,
                factKey: 'receiptId',
                factId: income.receipt.id,
            },
            {
                id: card.obligation.id,
                kind: 'EXPENSE',
                commitmentId: card.commitment.id,
                amount: 15000,
                distribution: 'RESPONSIBILITY',
                actorAmount: 6000,
                factKey: 'externalLiabilityId',
                factId: card.externalLiability.id,
            },
        ];
        for (const item of expected) {
            const origin = result.items.find(
                (row: { id: string }) => row.id === item.id,
            ).origin;
            expect(origin).toMatchObject({
                kind: item.kind,
                commitmentId: item.commitmentId,
                amountInCents: item.amount,
                [item.factKey]: item.factId,
                distribution: {
                    kind: item.distribution,
                    actorAmountInCents: item.actorAmount,
                },
            });
            expect(origin.distribution.shares).toHaveLength(2);
            expect(
                origin.distribution.shares.reduce(
                    (total: number, share: { amountInCents: number }) =>
                        total + share.amountInCents,
                    0,
                ),
            ).toBe(item.amount);
        }
        expect(result.position).toMatchObject({
            payableAmountInCents: '12000',
            receivableAmountInCents: '13000',
            net: { direction: 'RECEIVABLE', amountInCents: '1000' },
        });
    });

    it('paginates selected obligations while keeping whole-scope totals and binding cursor filters', async () => {
        const f = await sharedFinance(app);
        const ids: string[] = [];
        for (let index = 0; index < 23; index++) {
            const item = await expense(
                f,
                100,
                index % 2 ? '2026-10-20' : '2026-10-21',
                index < 21 ? f.ma : f.mb,
            );
            ids.push(item.obligation.id);
        }
        const cycleRows: { id: string }[] = await db.query(
            'SELECT id FROM settlement_cycles WHERE space_id=$1 ORDER BY target_date',
            [f.space],
        );
        const cycles = cycleRows.map((row) => row.id);
        const first = await summary(f, cycles);
        expect(first.items).toHaveLength(20);
        expect(first.page).toMatchObject({
            direction: 'ALL',
            pageSize: 20,
            nextCursor: expect.any(String),
        });
        expect(first.totals.remainingAmountInCents).toBe('2300');
        const second = await summary(f, [...cycles].reverse(), {
            cursor: first.page.nextCursor,
        });
        expect(second.items).toHaveLength(3);
        expect(second.page.nextCursor).toBeNull();
        expect(second.totals).toEqual(first.totals);
        expect(
            [...first.items, ...second.items]
                .map((item: { id: string }) => item.id)
                .sort(),
        ).toEqual(ids.sort());
        const receivable = await summary(f, cycles, {
            direction: 'RECEIVABLE',
        });
        expect(receivable.items).toHaveLength(20);
        expect(
            receivable.items.every(
                (item: { creditorMemberId: string }) =>
                    item.creditorMemberId === f.ma,
            ),
        ).toBe(true);
        expect(receivable.totals).toEqual(first.totals);
        expect(
            (
                await summary(f, cycles, {
                    direction: 'RECEIVABLE',
                    cursor: receivable.page.nextCursor,
                })
            ).items,
        ).toHaveLength(1);
        const third = await emptyCycle(f, '2026-10-22');
        for (const query of [
            {
                cycleIds: [...cycles, third].join(','),
                cursor: first.page.nextCursor,
            },
            {
                cycleIds: cycles.join(','),
                direction: 'PAYABLE',
                cursor: first.page.nextCursor,
            },
            { cycleIds: cycles.join(','), cursor: 'invalid-cursor' },
        ])
            await f.a.agent.get(summaryPath(f)).query(query).expect(400);
        await f.b.agent
            .get(summaryPath(f))
            .query({
                cycleIds: cycles.join(','),
                cursor: first.page.nextCursor,
            })
            .expect(400);
    });

    it('expires overdue cursors across the civil day and keeps each page within the overdue roots', async () => {
        const f = await sharedFinance(app);
        for (let day = 1; day <= 21; day++)
            await expense(f, 100, `2026-11-${String(day).padStart(2, '0')}`);
        instant = new Date('2026-11-22T12:00:00Z');
        const before = await financeSnapshot(db);
        const first = await list(f);
        expect(first.items).toHaveLength(20);
        const second = await list(f, 'OVERDUE', first.page.nextCursor);
        expect(second.items).toHaveLength(1);
        expect(second.page.nextCursor).toBeNull();
        expect(
            new Set(
                [...first.items, ...second.items].map(
                    (item: { id: string }) => item.id,
                ),
            ).size,
        ).toBe(21);
        expect(
            [...first.items, ...second.items].every(
                (item: { isOverdue: boolean }) => item.isOverdue,
            ),
        ).toBe(true);
        await f.a.agent
            .get(listPath(f))
            .query({ view: 'UPCOMING', cursor: first.page.nextCursor })
            .expect(400);
        instant = new Date('2026-11-23T12:00:00Z');
        await f.a.agent
            .get(listPath(f))
            .query({ view: 'OVERDUE', cursor: first.page.nextCursor })
            .expect(400);
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('reads cycle composition, totals, distribution and transfer effects on one snapshot during settlement', async () => {
        const f = await sharedFinance(app);
        const one = await expense(f, 10000, '2026-10-20');
        const two = await emptyCycle(f, '2026-10-21');
        const provider = app.get(EntityManagerProvider);
        const readSnapshot = provider.readSnapshot.bind(provider);
        let committed = false;
        vi.spyOn(provider, 'readSnapshot').mockImplementationOnce(
            async <T>(work: () => Promise<T>): Promise<T> =>
                readSnapshot(async () => {
                    await provider
                        .get()
                        .query(
                            'SELECT version FROM inter_member_obligations WHERE id=$1',
                            [one.obligation.id],
                        );
                    await transfer(f, [
                        {
                            id: one.obligation.id,
                            version: 1,
                            amountInCents: 1000,
                        },
                    ]);
                    committed = true;
                    return work();
                }),
        );
        const before = await summary(f, [one.settlementCycle.id, two]);
        expect(committed).toBe(true);
        expect(before.totals).toMatchObject({
            remainingAmountInCents: '10000',
            transferredAmountInCents: '0',
        });
        expect(before.items[0]).toMatchObject({
            version: 1,
            remainingAmountInCents: 10000,
        });
        const after = await summary(f, [one.settlementCycle.id, two]);
        expect(after.totals).toMatchObject({
            remainingAmountInCents: '9000',
            transferredAmountInCents: '1000',
        });
        expect(after.items[0]).toMatchObject({
            version: 2,
            remainingAmountInCents: 9000,
        });
    });
});
