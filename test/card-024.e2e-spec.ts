import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { type INestApplication } from '@nestjs/common';
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
import { configureApp } from '../dist/configure-app.js';
import migrationSource from '../dist/shared/technical/database/typeorm/data-source.js';
import { FINANCES_CLOCK } from '../dist/modules/finances/application/ports/private/shared-expense.repositories.js';
import { TODAY_CLOCK } from '../dist/composition/today/today.clock.js';
import {
    commitmentPath,
    financeBase,
    financeBrowser,
    sharedFinance,
} from './settlement-fixture.js';

describe('CARD-024 planned expenses and fixed recurrence HTTP/PostgreSQL', () => {
    let app: INestApplication<Server>;
    let db: DataSource;
    const instant = new Date('2026-10-14T15:00:00Z');
    const today = () => '2026-10-14';

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
            .useValue({ now: () => instant, today })
            .overrideProvider(TODAY_CLOCK)
            .useValue({ now: () => instant })
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

    it('keeps an avulsa pending expense in forecast until its first real fact', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = financeBase(space);
        const input = {
            scope: 'PERSONAL',
            description: 'Aluguel',
            amountInCents: 100000,
            expectedPaymentDate: '2026-10-10',
        };
        const key = randomUUID();
        const created = (
            await browser
                .post(`${base}/planned-expenses`, input, key)
                .expect(201)
        ).body;
        expect(created).toMatchObject({
            commitment: { factDate: null, expectedPaymentDate: '2026-10-10' },
            fulfillmentStatus: 'PENDING',
            overdue: true,
            paidAmountInCents: 0,
            remainingAmountInCents: 100000,
        });
        const replay = (
            await browser
                .post(`${base}/planned-expenses`, input, key)
                .expect(200)
        ).body;
        expect(replay.commitment.id).toBe(created.commitment.id);
        const planned = (
            await browser.agent
                .get(`${base}/planned-expenses?month=2026-10`)
                .expect(200)
        ).body;
        expect(planned.items).toMatchObject([
            { id: created.commitment.id, status: 'PENDING', overdue: true },
        ]);
        const forecast = (
            await browser.agent
                .get(`${base}/financial-forecast?month=2026-10`)
                .expect(200)
        ).body;
        expect(JSON.stringify(forecast)).toContain(created.commitment.id);
        const rows = await db.query(
            'SELECT fact_date,expected_payment_date FROM financial_commitment_versions WHERE commitment_id=$1',
            [created.commitment.id],
        );
        expect(rows[0].fact_date).toBeNull();
        await browser
            .post(
                `${commitmentPath(space, created.commitment.id)}/disbursements`,
                {
                    expectedCommitmentVersion: 1,
                    amountInCents: 40000,
                    factDate: '2026-10-14',
                    method: 'PIX',
                },
            )
            .expect(201);
        const detail = (
            await browser.agent
                .get(commitmentPath(space, created.commitment.id))
                .expect(200)
        ).body;
        expect(detail).toMatchObject({
            paidAmountInCents: 40000,
            remainingAmountInCents: 60000,
            fulfillmentStatus: 'PARTIALLY_FULFILLED',
        });
        expect(
            (
                await db.query(
                    'SELECT count(*)::int AS n FROM financial_commitments WHERE id=$1',
                    [created.commitment.id],
                )
            )[0].n,
        ).toBe(1);
    });

    it('projects monthly and annual dates without writing occurrences, then materializes one monthly occurrence', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/recurring-commitments`;
        const monthly = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    kind: 'EXPENSE',
                    description: 'Assinatura',
                    amountInCents: 9900,
                    recurrence: { frequency: 'MONTHLY', dayOfMonth: 31 },
                    startsOn: '2026-10-01',
                    endsOn: '2027-03-31',
                })
                .expect(201)
        ).body.commitment;
        const annual = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    kind: 'INCOME',
                    description: 'Bônus',
                    amountInCents: 200000,
                    recurrence: {
                        frequency: 'ANNUAL',
                        monthOfYear: 2,
                        dayOfMonth: 29,
                    },
                    startsOn: '2026-10-01',
                })
                .expect(201)
        ).body.commitment;
        const october = (
            await browser.agent
                .get(`${base}/${monthly.id}/occurrences?month=2026-10`)
                .expect(200)
        ).body;
        expect(october.items).toMatchObject([
            { id: null, referenceDate: '2026-10-31', status: 'PENDING' },
        ]);
        expect(
            (
                await browser.agent
                    .get(`${base}/${monthly.id}/occurrences?month=2027-02`)
                    .expect(200)
            ).body.items,
        ).toMatchObject([{ referenceDate: '2027-02-28' }]);
        expect(
            (
                await browser.agent
                    .get(`${base}/${annual.id}/occurrences?month=2027-02`)
                    .expect(200)
            ).body.items,
        ).toMatchObject([{ referenceDate: '2027-02-28' }]);
        expect(
            (
                await db.query(
                    'SELECT count(*)::int AS n FROM financial_occurrences',
                )
            )[0].n,
        ).toBe(0);
        const path = `${base}/${monthly.id}/occurrences/2026-10-31/disbursements`;
        const input = {
            expectedCommitmentVersion: 1,
            expectedOccurrenceVersion: 1,
            amountInCents: 4000,
            factDate: '2026-10-14',
            method: 'PIX',
        };
        const key = randomUUID();
        const paid = (await browser.post(path, input, key).expect(201)).body;
        expect(paid.occurrence).toMatchObject({
            status: 'PARTIALLY_FULFILLED',
            fulfilledAmountInCents: 4000,
            remainingAmountInCents: 5900,
            stateVersion: 2,
        });
        expect(
            (await browser.post(path, input, key).expect(200)).body.occurrence
                .id,
        ).toBe(paid.occurrence.id);
        expect(
            (
                await db.query(
                    'SELECT count(*)::int AS n FROM financial_occurrences',
                )
            )[0].n,
        ).toBe(1);
        expect(
            (
                await db.query(
                    'SELECT count(*)::int AS n FROM financial_commitment_versions WHERE commitment_id=$1',
                    [monthly.id],
                )
            )[0].n,
        ).toBe(0);
        await browser
            .post(
                path,
                { ...input, expectedOccurrenceVersion: 2, amountInCents: 5900 },
                randomUUID(),
            )
            .expect(201);
        expect(
            (
                await browser.agent
                    .get(`${base}/${monthly.id}/occurrences?month=2026-10`)
                    .expect(200)
            ).body.items,
        ).toMatchObject([{ status: 'FULFILLED', remainingAmountInCents: 0 }]);
    });

    it('tracks shared recurring disbursement by occurrence without merging origins', async () => {
        const f = await sharedFinance(app);
        const base = `${financeBase(f.space)}/recurring-commitments`;
        await f.a
            .put(`${financeBase(f.space)}/default-settlement-rule`, {
                expectedVersion: 0,
                rule: { kind: 'MONTHLY_DAY', dayOfMonth: 10 },
            })
            .expect(200);
        const created = (
            await f.a
                .post(base, {
                    scope: 'SHARED',
                    kind: 'EXPENSE',
                    description: 'Internet',
                    amountInCents: 10000,
                    recurrence: { frequency: 'MONTHLY', dayOfMonth: 14 },
                    startsOn: '2026-10-01',
                    expectedSpaceVersion: f.context.version,
                    distribution: {
                        mode: 'AMOUNTS',
                        shares: [
                            { memberId: f.ma, amountInCents: 5000 },
                            { memberId: f.mb, amountInCents: 5000 },
                        ],
                    },
                    expectedMemberId: f.ma,
                })
                .expect(201)
        ).body.commitment;
        await f.a
            .put(`${financeBase(f.space)}/default-settlement-rule`, {
                expectedVersion: 1,
                rule: { kind: 'MONTHLY_DAY', dayOfMonth: 20 },
            })
            .expect(200);
        const detail = (
            await f.a.agent.get(`${base}/${created.id}`).expect(200)
        ).body;
        expect(detail.commitment.settlementRuleSnapshot).toEqual({
            kind: 'MONTHLY_DAY',
            dayOfMonth: 10,
        });
        const first = `${base}/${created.id}/occurrences/2026-10-14/disbursements`;
        const second = `${base}/${created.id}/occurrences/2026-11-14/disbursements`;
        const payload = {
            expectedCommitmentVersion: 1,
            expectedOccurrenceVersion: 1,
            amountInCents: 10000,
            factDate: '2026-10-14',
            method: 'PIX',
            payerMemberId: f.ma,
            expectedSpaceVersion: f.context.version,
            settlement: { mode: 'NONE' },
        };
        await f.a.post(first, payload).expect(201);
        await f.a.post(second, payload).expect(201);
        const obligations = await db.query(
            'SELECT occurrence_id,COUNT(*)::int AS n FROM inter_member_obligations WHERE commitment_id=$1 GROUP BY occurrence_id',
            [created.id],
        );
        expect(obligations).toHaveLength(2);
        expect(
            obligations.every(
                (row: { n: number; occurrence_id: string | null }) =>
                    row.n === 1 && row.occurrence_id,
            ),
        ).toBe(true);
    });

    it('shows a shared recurring receipt in the authorized member timeline', async () => {
        const f = await sharedFinance(app);
        const base = `${financeBase(f.space)}/recurring-commitments`;
        const root = (
            await f.a
                .post(base, {
                    scope: 'SHARED',
                    kind: 'INCOME',
                    description: 'Aluguel recebido',
                    amountInCents: 10000,
                    recurrence: { frequency: 'MONTHLY', dayOfMonth: 14 },
                    startsOn: '2026-10-01',
                    expectedSpaceVersion: f.context.version,
                    distribution: {
                        mode: 'AMOUNTS',
                        shares: [
                            { memberId: f.ma, amountInCents: 5000 },
                            { memberId: f.mb, amountInCents: 5000 },
                        ],
                    },
                    expectedMemberId: f.ma,
                })
                .expect(201)
        ).body.commitment;
        const receipt = (
            await f.a
                .post(`${base}/${root.id}/occurrences/2026-10-14/receipts`, {
                    expectedCommitmentVersion: 1,
                    expectedOccurrenceVersion: 1,
                    amountInCents: 6000,
                    factDate: '2026-10-14',
                    recipientMemberId: f.ma,
                    expectedSpaceVersion: f.context.version,
                    settlement: { mode: 'NONE' },
                })
                .expect(201)
        ).body.occurrence.facts[0];
        const timeline = (
            await f.b.agent
                .get(
                    `${financeBase(f.space)}/financial-timeline?month=2026-10&view=HISTORY&memberId=${f.mb}`,
                )
                .expect(200)
        ).body;
        expect(timeline.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: receipt.id,
                    type: 'RECEIPT',
                    commitmentId: root.id,
                }),
            ]),
        );
    });

    it('keeps a shared planned expense out of the overview until partial fulfillment creates its obligation', async () => {
        const f = await sharedFinance(app);
        const base = financeBase(f.space);
        const created = (
            await f.a
                .post(`${base}/planned-expenses`, {
                    scope: 'SHARED',
                    description: 'Condomínio',
                    amountInCents: 10000,
                    expectedPaymentDate: '2026-10-10',
                    expectedSpaceVersion: f.context.version,
                    expectedPayerMemberId: f.ma,
                    responsibilitySplit: {
                        mode: 'AMOUNTS',
                        shares: [
                            { memberId: f.ma, amountInCents: 5000 },
                            { memberId: f.mb, amountInCents: 5000 },
                        ],
                    },
                })
                .expect(201)
        ).body;
        expect(created).toMatchObject({
            status: 'PENDING',
            overdue: true,
            obligation: null,
        });
        const before = (
            await f.a.agent
                .get(`${base}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        expect(before.totals.expenseAmountInCents).toBe('0');
        const forecast = (
            await f.a.agent
                .get(`${base}/financial-forecast?month=2026-10`)
                .expect(200)
        ).body;
        expect(forecast.totals.expectedExpenseAmountInCents).toBe('10000');
        await f.a
            .post(
                `${commitmentPath(f.space, created.commitment.id)}/disbursements`,
                {
                    expectedSpaceVersion: f.context.version,
                    expectedCommitmentVersion: 1,
                    amountInCents: 6000,
                    factDate: '2026-10-14',
                    method: 'PIX',
                    payerMemberId: f.ma,
                    settlement: { mode: 'NONE' },
                },
            )
            .expect(201);
        const after = (
            await f.a.agent
                .get(`${base}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        expect(after.totals.expenseAmountInCents).toBe('10000');
        expect(after.totals.paidAmountInCents).toBe('6000');
        const obligations = await db.query(
            'SELECT count(*)::int AS n FROM inter_member_obligations WHERE commitment_id=$1',
            [created.commitment.id],
        );
        expect(obligations[0].n).toBe(1);
    });

    it('realizes recurring income once and rejects an altered idempotent command', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/recurring-commitments`;
        const root = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    kind: 'INCOME',
                    description: 'Salário',
                    amountInCents: 100000,
                    recurrence: { frequency: 'MONTHLY', dayOfMonth: 14 },
                    startsOn: '2026-10-01',
                })
                .expect(201)
        ).body.commitment;
        const path = `${base}/${root.id}/occurrences/2026-10-14/receipts`;
        const input = {
            expectedCommitmentVersion: 1,
            expectedOccurrenceVersion: 1,
            amountInCents: 60000,
            factDate: '2026-10-14',
        };
        const key = randomUUID();
        const realized = (await browser.post(path, input, key).expect(201))
            .body;
        expect(realized.occurrence).toMatchObject({
            status: 'PARTIALLY_FULFILLED',
            fulfilledAmountInCents: 60000,
            remainingAmountInCents: 40000,
        });
        await browser
            .post(path, { ...input, amountInCents: 50000 }, key)
            .expect(409);
        const replay = (await browser.post(path, input, key).expect(200)).body;
        expect(replay.occurrence.id).toBe(realized.occurrence.id);
        expect(
            (
                await db.query(
                    'SELECT count(*)::int AS n FROM financial_receipts WHERE occurrence_id=$1',
                    [realized.occurrence.id],
                )
            )[0].n,
        ).toBe(1);
        const overview = (
            await browser.agent
                .get(`${financeBase(space)}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        expect(overview.totals.realizedIncomeAmountInCents).toBe('60000');
        expect(overview.totals.receivedAmountInCents).toBe('60000');
    });

    it('serializes competing first materialization and rolls back an invalid fact', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/recurring-commitments`;
        const root = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    kind: 'EXPENSE',
                    description: 'Seguro',
                    amountInCents: 10000,
                    recurrence: { frequency: 'MONTHLY', dayOfMonth: 14 },
                    startsOn: '2026-10-01',
                })
                .expect(201)
        ).body.commitment;
        const path = `${base}/${root.id}/occurrences/2026-10-14/disbursements`;
        const input = {
            expectedCommitmentVersion: 1,
            expectedOccurrenceVersion: 1,
            amountInCents: 5000,
            factDate: '2026-10-14',
            method: 'PIX',
        };
        await browser
            .post(path, { ...input, amountInCents: 10001 })
            .expect(400);
        expect(
            (
                await db.query(
                    'SELECT count(*)::int AS n FROM financial_occurrences WHERE commitment_id=$1',
                    [root.id],
                )
            )[0].n,
        ).toBe(0);
        expect(
            (
                await db.query(
                    "SELECT count(*)::int AS n FROM financial_command_audit WHERE commitment_id=$1 AND action='RECORD_RECURRING_DISBURSEMENT'",
                    [root.id],
                )
            )[0].n,
        ).toBe(0);
        const results = await Promise.all([
            browser.post(path, input, randomUUID()),
            browser.post(path, input, randomUUID()),
        ]);
        expect(results.map((result) => result.status).sort()).toEqual([
            201, 409,
        ]);
        expect(
            (
                await db.query(
                    'SELECT count(*)::int AS n FROM financial_occurrences WHERE commitment_id=$1',
                    [root.id],
                )
            )[0].n,
        ).toBe(1);
        expect(
            (
                await db.query(
                    'SELECT count(*)::int AS n FROM financial_disbursements WHERE commitment_id=$1',
                    [root.id],
                )
            )[0].n,
        ).toBe(1);
        expect(
            (
                await db.query(
                    "SELECT count(*)::int AS n FROM financial_command_audit WHERE commitment_id=$1 AND action='RECORD_RECURRING_DISBURSEMENT'",
                    [root.id],
                )
            )[0].n,
        ).toBe(1);
    });
});
