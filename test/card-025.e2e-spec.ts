import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from './setup-env.js';
import { AppModule } from '../dist/app.module.js';
import { configureApp } from '../dist/configure-app.js';
import migrationSource from '../dist/shared/technical/database/typeorm/data-source.js';
import { FINANCES_CLOCK } from '../dist/modules/finances/application/ports/private/shared-expense.repositories.js';
import { TODAY_CLOCK } from '../dist/composition/today/today.clock.js';
import {
    financeBase,
    financeBrowser,
    sharedFinance,
    sharedExpenseInput,
} from './settlement-fixture.js';

describe('CARD-025 variable recurring occurrences', () => {
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
        await app?.close();
    });

    it('distinguishes unknown estimate from zero, records value history, then locks the realized expense', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/recurring-commitments`;
        const root = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    valueMode: 'VARIABLE',
                    kind: 'EXPENSE',
                    description: 'Conta de energia',
                    recurrence: { frequency: 'MONTHLY', dayOfMonth: 14 },
                    startsOn: '2026-10-01',
                })
                .expect(201)
        ).body.commitment;
        expect(root).toMatchObject({
            valueMode: 'VARIABLE',
            amountInCents: null,
            expectedAmountInCents: null,
        });
        const occurrencePath = `${base}/${root.id}/occurrences/2026-10-14`;
        const projected = (
            await browser.agent
                .get(`${base}/${root.id}/occurrences?month=2026-10`)
                .expect(200)
        ).body;
        expect(projected).toMatchObject({
            unknownAmountCount: 1,
            items: [{ id: null, amountInCents: null, valuePending: true }],
        });
        const forecast = (
            await browser.agent
                .get(`${financeBase(space)}/financial-forecast?month=2026-10`)
                .expect(200)
        ).body;
        expect(forecast.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    commitmentId: root.id,
                    amountInCents: null,
                }),
            ]),
        );
        await browser
            .post(`${occurrencePath}/disbursements`, {
                expectedCommitmentVersion: 1,
                expectedOccurrenceVersion: 1,
                amountInCents: 1000,
                factDate: today(),
                method: 'PIX',
            })
            .expect(409);
        const firstInput = {
            expectedCommitmentVersion: 1,
            expectedOccurrenceVersion: 1,
            amountInCents: 12000,
        };
        await browser
            .put(`${occurrencePath}/value`, { ...firstInput, amountInCents: 0 })
            .expect(400);
        expect(
            (
                await db.query(
                    'SELECT COUNT(*)::int AS n FROM financial_occurrences WHERE commitment_id=$1',
                    [root.id],
                )
            )[0].n,
        ).toBe(0);
        const key = randomUUID();
        const first = (
            await browser
                .put(`${occurrencePath}/value`, firstInput, key)
                .expect(200)
        ).body;
        expect(first.occurrence).toMatchObject({
            amountInCents: 12000,
            valuePending: false,
            stateVersion: 2,
            valueHistory: [
                { previousAmountInCents: null, amountInCents: 12000 },
            ],
        });
        expect(
            (
                await browser
                    .put(`${occurrencePath}/value`, firstInput, key)
                    .expect(200)
            ).body.replayed,
        ).toBe(true);
        await browser
            .put(
                `${occurrencePath}/value`,
                { ...firstInput, amountInCents: 12001 },
                key,
            )
            .expect(409);
        expect(
            (
                await browser
                    .put(`${occurrencePath}/value`, firstInput, key)
                    .expect(200)
            ).body.occurrence.amountInCents,
        ).toBe(12000);
        const second = (
            await browser
                .put(`${occurrencePath}/value`, {
                    ...firstInput,
                    expectedOccurrenceVersion: 2,
                    amountInCents: 13500,
                })
                .expect(200)
        ).body;
        expect(second.occurrence).toMatchObject({
            amountInCents: 13500,
            stateVersion: 3,
            valueHistory: [
                { amountInCents: 12000 },
                { previousAmountInCents: 12000, amountInCents: 13500 },
            ],
        });
        await browser
            .post(`${occurrencePath}/disbursements`, {
                expectedCommitmentVersion: 1,
                expectedOccurrenceVersion: 3,
                amountInCents: 5000,
                factDate: today(),
                method: 'PIX',
            })
            .expect(201);
        await browser
            .put(`${occurrencePath}/value`, {
                ...firstInput,
                expectedOccurrenceVersion: 4,
                amountInCents: 14000,
            })
            .expect(409);
        expect(
            (
                await browser
                    .put(`${occurrencePath}/value`, firstInput, key)
                    .expect(200)
            ).body.occurrence.amountInCents,
        ).toBe(12000);
        const overview = (
            await browser.agent
                .get(`${financeBase(space)}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        expect(overview.totals).toMatchObject({
            expenseAmountInCents: '13500',
            paidAmountInCents: '5000',
        });
        const changes = await db.query(
            'SELECT previous_amount_in_cents,amount_in_cents FROM financial_occurrence_value_changes WHERE occurrence_id=$1 ORDER BY version',
            [first.occurrence.id],
        );
        expect(changes).toHaveLength(2);
        expect(
            (
                await db.query(
                    "SELECT COUNT(*)::int AS n FROM financial_command_audit WHERE commitment_id=$1 AND action='SET_RECURRING_OCCURRENCE_VALUE'",
                    [root.id],
                )
            )[0].n,
        ).toBe(2);
    });

    it('allocates a shared actual amount above estimate and keeps each occurrence distinct', async () => {
        const f = await sharedFinance(app);
        const base = `${financeBase(f.space)}/recurring-commitments`;
        const root = (
            await f.a
                .post(base, {
                    scope: 'SHARED',
                    valueMode: 'VARIABLE',
                    kind: 'EXPENSE',
                    description: 'Água',
                    expectedAmountInCents: 10000,
                    recurrence: { frequency: 'MONTHLY', dayOfMonth: 14 },
                    startsOn: '2026-10-01',
                    expectedSpaceVersion: f.context.version,
                    distribution: {
                        mode: 'PERCENTAGES',
                        shares: [
                            { memberId: f.ma, basisPoints: 6000 },
                            { memberId: f.mb, basisPoints: 4000 },
                        ],
                    },
                    expectedMemberId: f.ma,
                })
                .expect(201)
        ).body.commitment;
        const path = `${base}/${root.id}/occurrences/2026-10-14`;
        const projection = (
            await f.a.agent
                .get(`${base}/${root.id}/occurrences?month=2026-10`)
                .expect(200)
        ).body.items[0];
        expect(projection).toMatchObject({
            amountInCents: null,
            expectedAmountInCents: 10000,
            valuePending: true,
        });
        const beforeForecast = (
            await f.a.agent
                .get(`${financeBase(f.space)}/financial-forecast?month=2026-10`)
                .expect(200)
        ).body;
        expect(beforeForecast.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    commitmentId: root.id,
                    amountInCents: null,
                    expectedAmountInCents: 10000,
                }),
            ]),
        );
        expect(beforeForecast.totals.unknownAmountCount).toBe(1);
        const beforeList = (
            await f.a.agent.get(`${base}?month=2026-10`).expect(200)
        ).body;
        expect(beforeList).toMatchObject({
            totalAmountInCents: '0',
            unknownAmountCount: 1,
        });
        const value = (
            await f.a
                .put(`${path}/value`, {
                    expectedCommitmentVersion: 1,
                    expectedOccurrenceVersion: 1,
                    expectedSpaceVersion: f.context.version,
                    amountInCents: 23742,
                })
                .expect(200)
        ).body.occurrence;
        expect(value.economicShares).toEqual(
            [
                { memberId: f.ma, amountInCents: 14245 },
                { memberId: f.mb, amountInCents: 9497 },
            ].sort((a, b) => a.memberId.localeCompare(b.memberId)),
        );
        expect(value.amountInCents).toBe(23742);
        const afterList = (
            await f.a.agent.get(`${base}?month=2026-10`).expect(200)
        ).body;
        expect(afterList).toMatchObject({
            totalAmountInCents: '23742',
            unknownAmountCount: 0,
        });
        await f.a
            .post(`${path}/disbursements`, {
                expectedCommitmentVersion: 1,
                expectedOccurrenceVersion: 2,
                expectedSpaceVersion: f.context.version,
                amountInCents: 20000,
                factDate: today(),
                method: 'PIX',
                payerMemberId: f.ma,
                settlement: { mode: 'DATE', targetDate: '2026-11-10' },
            })
            .expect(201);
        const overview = (
            await f.a.agent
                .get(`${financeBase(f.space)}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        expect(overview.totals.expenseAmountInCents).toBe('23742');
        expect(
            overview.byMember.find(
                (m: { memberId: string }) => m.memberId === f.mb,
            ).expenseAmountInCents,
        ).toBe('9497');
        expect(
            (
                await db.query(
                    'SELECT COUNT(*)::int AS n FROM inter_member_obligations WHERE occurrence_id=$1',
                    [value.id],
                )
            )[0].n,
        ).toBeGreaterThan(0);
        const obligation = (
            await db.query(
                'SELECT cycle_id,id FROM inter_member_obligations WHERE occurrence_id=$1 LIMIT 1',
                [value.id],
            )
        )[0];
        const cycle = (
            await f.a.agent
                .get(
                    `${financeBase(f.space)}/settlement-cycles/${obligation.cycle_id}`,
                )
                .expect(200)
        ).body;
        const origin = cycle.items.find(
            (item: { id: string }) => item.id === obligation.id,
        ).origin;
        expect(origin.occurrenceId).toBe(value.id);
        const other = (
            await f.a
                .post(
                    `${financeBase(f.space)}/shared-cash-expenses`,
                    sharedExpenseInput(f, 1000, 1000, {
                        mode: 'DATE',
                        targetDate: '2026-11-11',
                    }),
                )
                .expect(201)
        ).body;
        const summary = (
            await f.a.agent
                .get(`${financeBase(f.space)}/settlement-cycles/summary`)
                .query({
                    cycleIds: `${obligation.cycle_id},${other.settlementCycle.id}`,
                })
                .expect(200)
        ).body;
        const fullOrigin = summary.items.find(
            (item: { id: string }) => item.id === obligation.id,
        ).origin;
        expect(fullOrigin).toMatchObject({
            amountInCents: 23742,
            occurrenceId: value.id,
            distribution: { shares: value.economicShares },
        });
        const next = (
            await f.a.agent
                .get(`${base}/${root.id}/occurrences?month=2026-11`)
                .expect(200)
        ).body.items[0];
        expect(next).toMatchObject({
            id: null,
            amountInCents: null,
            expectedAmountInCents: 10000,
        });
    });

    it('realizes shared variable income with actual participation and rejects ineligible dates', async () => {
        const f = await sharedFinance(app);
        const base = `${financeBase(f.space)}/recurring-commitments`;
        const root = (
            await f.a
                .post(base, {
                    scope: 'SHARED',
                    valueMode: 'VARIABLE',
                    kind: 'INCOME',
                    description: 'Comissão',
                    recurrence: {
                        frequency: 'ANNUAL',
                        monthOfYear: 10,
                        dayOfMonth: 14,
                    },
                    startsOn: '2026-10-01',
                    expectedSpaceVersion: f.context.version,
                    distribution: {
                        mode: 'PERCENTAGES',
                        shares: [
                            { memberId: f.ma, basisPoints: 6000 },
                            { memberId: f.mb, basisPoints: 4000 },
                        ],
                    },
                })
                .expect(201)
        ).body.commitment;
        await f.a
            .put(`${base}/${root.id}/occurrences/2026-11-14/value`, {
                expectedCommitmentVersion: 1,
                expectedOccurrenceVersion: 1,
                expectedSpaceVersion: f.context.version,
                amountInCents: 23742,
            })
            .expect(404);
        const path = `${base}/${root.id}/occurrences/2026-10-14`;
        await f.a
            .put(`${path}/value`, {
                expectedCommitmentVersion: 1,
                expectedOccurrenceVersion: 1,
                expectedSpaceVersion: f.context.version,
                amountInCents: 23742,
            })
            .expect(200);
        const receipt = (
            await f.a
                .post(`${path}/receipts`, {
                    expectedCommitmentVersion: 1,
                    expectedOccurrenceVersion: 2,
                    expectedSpaceVersion: f.context.version,
                    amountInCents: 12000,
                    factDate: today(),
                    recipientMemberId: f.ma,
                    settlement: { mode: 'NONE' },
                })
                .expect(201)
        ).body;
        expect(receipt.occurrence).toMatchObject({
            status: 'PARTIALLY_FULFILLED',
            remainingAmountInCents: 11742,
        });
        const overview = (
            await f.a.agent
                .get(`${financeBase(f.space)}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        expect(overview.totals.realizedIncomeAmountInCents).toBe('12000');
        expect(
            overview.byMember.find(
                (m: { memberId: string }) => m.memberId === f.mb,
            ).realizedIncomeAmountInCents,
        ).toBe('4800');
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
                    id: receipt.occurrence.facts[0].id,
                    type: 'RECEIPT',
                }),
            ]),
        );
    });

    it('serializes a competing value change and payment without partial audit', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/recurring-commitments`;
        const root = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    valueMode: 'VARIABLE',
                    kind: 'EXPENSE',
                    description: 'Seguro variável',
                    recurrence: { frequency: 'MONTHLY', dayOfMonth: 14 },
                    startsOn: '2026-10-01',
                })
                .expect(201)
        ).body.commitment;
        const path = `${base}/${root.id}/occurrences/2026-10-14`;
        await browser
            .put(`${path}/value`, {
                expectedCommitmentVersion: 1,
                expectedOccurrenceVersion: 1,
                amountInCents: 10000,
            })
            .expect(200);
        const results = await Promise.all([
            browser.put(`${path}/value`, {
                expectedCommitmentVersion: 1,
                expectedOccurrenceVersion: 2,
                amountInCents: 11000,
            }),
            browser.post(`${path}/disbursements`, {
                expectedCommitmentVersion: 1,
                expectedOccurrenceVersion: 2,
                amountInCents: 5000,
                factDate: today(),
                method: 'PIX',
            }),
        ]);
        expect(results.filter((result) => result.status === 409)).toHaveLength(
            1,
        );
        expect(
            results.filter(
                (result) => result.status === 200 || result.status === 201,
            ),
        ).toHaveLength(1);
        const detail = (
            await browser.agent
                .get(`${base}/${root.id}/occurrences?month=2026-10`)
                .expect(200)
        ).body.items[0];
        expect(detail.stateVersion).toBe(3);
        expect(detail.facts.length + detail.valueHistory.length).toBe(2);
        expect(
            (
                await db.query(
                    'SELECT COUNT(*)::int AS n FROM financial_occurrence_value_changes WHERE occurrence_id=$1',
                    [detail.id],
                )
            )[0].n,
        ).toBe(detail.valueHistory.length);
    });

    it('receives a personal variable income after defining only that annual occurrence', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/recurring-commitments`;
        const root = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    valueMode: 'VARIABLE',
                    kind: 'INCOME',
                    description: 'Bônus anual',
                    recurrence: {
                        frequency: 'ANNUAL',
                        monthOfYear: 10,
                        dayOfMonth: 14,
                    },
                    startsOn: '2026-10-01',
                })
                .expect(201)
        ).body.commitment;
        const path = `${base}/${root.id}/occurrences/2026-10-14`;
        await browser
            .put(`${path}/value`, {
                expectedCommitmentVersion: 1,
                expectedOccurrenceVersion: 1,
                amountInCents: 9000,
            })
            .expect(200);
        await browser
            .post(`${path}/receipts`, {
                expectedCommitmentVersion: 1,
                expectedOccurrenceVersion: 2,
                amountInCents: 9000,
                factDate: today(),
            })
            .expect(201);
        const overview = (
            await browser.agent
                .get(`${financeBase(space)}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        expect(overview.totals.realizedIncomeAmountInCents).toBe('9000');
        expect(
            (
                await browser.agent
                    .get(`${base}/${root.id}/occurrences?month=2027-10`)
                    .expect(200)
            ).body.items[0],
        ).toMatchObject({ id: null, amountInCents: null, valuePending: true });
    });
});
