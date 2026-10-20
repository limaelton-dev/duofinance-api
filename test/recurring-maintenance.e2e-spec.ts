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
} from './settlement-fixture.js';

describe('future versions, termination and occurrence cancellation', () => {
    let app: INestApplication<Server>;
    let db: DataSource;
    const instant = new Date('2026-10-14T15:00:00Z');
    let currentDate = '2026-10-14';
    const today = () => currentDate;

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
        currentDate = '2026-10-14';
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

    it('keeps a materialized old snapshot, chooses one boundary occurrence, cancels only one and terminates with an open fact', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/recurring-commitments`;
        const root = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    kind: 'EXPENSE',
                    description: 'Aluguel antigo',
                    amountInCents: 10000,
                    recurrence: { frequency: 'MONTHLY', dayOfMonth: 14 },
                    startsOn: '2026-10-01',
                })
                .expect(201)
        ).body.commitment;
        const oldPath = `${base}/${root.id}/occurrences/2026-11-14`;
        const open = (
            await browser
                .post(`${oldPath}/disbursements`, {
                    expectedCommitmentVersion: 1,
                    expectedOccurrenceVersion: 1,
                    amountInCents: 2000,
                    factDate: today(),
                    method: 'PIX',
                })
                .expect(201)
        ).body.occurrence;
        const futureOpen = (
            await browser
                .post(
                    `${base}/${root.id}/occurrences/2027-02-14/disbursements`,
                    {
                        expectedCommitmentVersion: 1,
                        expectedOccurrenceVersion: 1,
                        amountInCents: 1000,
                        factDate: today(),
                        method: 'PIX',
                    },
                )
                .expect(201)
        ).body.occurrence;
        const change = {
            scope: 'PERSONAL',
            kind: 'EXPENSE',
            valueMode: 'FIXED',
            description: 'Aluguel novo',
            amountInCents: 12000,
            recurrence: { frequency: 'MONTHLY', dayOfMonth: 20 },
            effectiveFrom: '2026-11-15',
            expectedCommitmentVersion: 1,
        };
        const preview = (
            await browser
                .post(`${base}/${root.id}/change-preview`, change)
                .expect(200)
        ).body;
        expect(preview).toMatchObject({
            requiresAcceptance: false,
            materializedOccurrencesPreserved: [{ referenceDate: '2027-02-14' }],
        });
        expect(
            (
                await db.query(
                    'SELECT COUNT(*)::int AS n FROM financial_recurrence_versions WHERE commitment_id=$1',
                    [root.id],
                )
            )[0].n,
        ).toBe(1);
        const changed = (
            await browser
                .post(`${base}/${root.id}/versions`, change)
                .expect(201)
        ).body;
        expect(changed.commitment).toMatchObject({
            version: 2,
            economicVersion: 2,
            currentEconomicVersion: 1,
        });
        currentDate = '2026-10-15';
        expect(
            (await browser.agent.get(`${base}/${root.id}`).expect(200)).body
                .commitment,
        ).toMatchObject({
            description: 'Aluguel antigo',
            amountInCents: 10000,
            currentEconomicVersion: 1,
        });
        currentDate = '2026-10-14';
        const november = (
            await browser.agent
                .get(`${base}/${root.id}/occurrences?month=2026-11`)
                .expect(200)
        ).body;
        expect(november.items).toHaveLength(1);
        expect(november.items[0]).toMatchObject({
            id: open.id,
            referenceDate: '2026-11-14',
            economicVersion: 1,
            amountInCents: 10000,
            fulfilledAmountInCents: 2000,
        });
        await browser
            .post(`${base}/${root.id}/occurrences/2026-11-20/cancellation`, {
                expectedCommitmentVersion: 2,
                expectedOccurrenceVersion: 1,
            })
            .expect(404);
        const december = (
            await browser.agent
                .get(`${base}/${root.id}/occurrences?month=2026-12`)
                .expect(200)
        ).body;
        expect(december.items).toMatchObject([
            {
                referenceDate: '2026-12-20',
                economicVersion: 2,
                amountInCents: 12000,
            },
        ]);
        const decemberForecast = (
            await browser.agent
                .get(`${financeBase(space)}/financial-forecast?month=2026-12`)
                .expect(200)
        ).body;
        expect(decemberForecast.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    commitmentId: root.id,
                    description: 'Aluguel novo',
                    amountInCents: 12000,
                }),
            ]),
        );
        expect(
            (await browser.agent.get(`${base}?month=2026-12`).expect(200)).body,
        ).toMatchObject({
            totalCount: 1,
            totalAmountInCents: '12000',
            items: [{ id: root.id, referenceDate: '2026-12-20' }],
        });
        await browser
            .post(`${oldPath}/cancellation`, {
                expectedCommitmentVersion: 2,
                expectedOccurrenceVersion: 2,
            })
            .expect(409);
        const cancelPath = `${base}/${root.id}/occurrences/2026-12-20/cancellation`;
        const cancelInput = {
            expectedCommitmentVersion: 2,
            expectedOccurrenceVersion: 1,
        };
        const key = randomUUID();
        const canceled = (
            await browser.post(cancelPath, cancelInput, key).expect(201)
        ).body;
        expect(canceled.occurrence).toMatchObject({
            status: 'CANCELLED',
            stateVersion: 2,
            economicVersion: 2,
        });
        expect(
            (await browser.post(cancelPath, cancelInput, key).expect(200)).body
                .replayed,
        ).toBe(true);
        await browser
            .post(
                cancelPath,
                { ...cancelInput, expectedOccurrenceVersion: 2 },
                key,
            )
            .expect(409);
        const january = (
            await browser.agent
                .get(`${base}/${root.id}/occurrences?month=2027-01`)
                .expect(200)
        ).body;
        expect(january.items).toMatchObject([
            { referenceDate: '2027-01-20', status: 'PENDING' },
        ]);
        const terminationPreview = (
            await browser
                .post(`${base}/${root.id}/termination-preview`, {
                    expectedCommitmentVersion: 2,
                    endsOn: '2026-12-31',
                })
                .expect(200)
        ).body;
        expect(terminationPreview.materializedOccurrencesPreserved).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    referenceDate: '2027-02-14',
                    status: 'PARTIALLY_FULFILLED',
                    economicVersion: 1,
                }),
            ]),
        );
        expect(
            (
                await db.query(
                    'SELECT COUNT(*)::int AS n FROM financial_recurrence_terminations WHERE commitment_id=$1',
                    [root.id],
                )
            )[0].n,
        ).toBe(0);
        const termination = (
            await browser
                .post(`${base}/${root.id}/termination`, {
                    expectedCommitmentVersion: 2,
                    endsOn: '2026-12-31',
                })
                .expect(201)
        ).body;
        expect(termination.commitment).toMatchObject({
            version: 3,
            terminatedOn: '2026-12-31',
        });
        expect(termination.materializedOccurrencesPreserved).toEqual(
            terminationPreview.materializedOccurrencesPreserved,
        );
        expect(
            (
                await browser.agent
                    .get(`${base}/${root.id}/occurrences?month=2027-01`)
                    .expect(200)
            ).body.items,
        ).toEqual([]);
        expect(
            (await browser.agent.get(`${base}?month=2027-01`).expect(200)).body
                .totalCount,
        ).toBe(0);
        const februaryForecast = (
            await browser.agent
                .get(`${financeBase(space)}/financial-forecast?month=2027-02`)
                .expect(200)
        ).body;
        expect(februaryForecast.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: futureOpen.id,
                    commitmentId: root.id,
                    description: 'Aluguel antigo',
                    amountInCents: 10000,
                }),
            ]),
        );
        expect(
            (
                await browser.agent
                    .get(`${base}/${root.id}/occurrences?month=2026-11`)
                    .expect(200)
            ).body.items[0].id,
        ).toBe(open.id);
        expect(
            (
                await browser.agent
                    .get(`${base}/${root.id}/occurrences?month=2027-02`)
                    .expect(200)
            ).body.items[0].id,
        ).toBe(futureOpen.id);
        const completed = (
            await browser
                .post(`${oldPath}/disbursements`, {
                    expectedCommitmentVersion: 3,
                    expectedOccurrenceVersion: 2,
                    amountInCents: 8000,
                    factDate: today(),
                    method: 'PIX',
                })
                .expect(201)
        ).body;
        expect(completed.occurrence).toMatchObject({
            id: open.id,
            economicVersion: 1,
            status: 'FULFILLED',
        });
        const versions = await db.query(
            'SELECT version,effective_from::text AS effective_from,description FROM financial_recurrence_versions WHERE commitment_id=$1 ORDER BY version',
            [root.id],
        );
        expect(versions).toMatchObject([
            {
                version: 1,
                effective_from: '2026-10-01',
                description: 'Aluguel antigo',
            },
            {
                version: 2,
                effective_from: '2026-11-15',
                description: 'Aluguel novo',
            },
        ]);
        expect(
            (
                await db.query(
                    'SELECT COUNT(*)::int AS n FROM financial_occurrence_cancellations WHERE occurrence_id=$1',
                    [canceled.occurrence.id],
                )
            )[0].n,
        ).toBe(1);
    });

    it('previews member responsibility and blocks an onerous version without any write', async () => {
        const f = await sharedFinance(app);
        const base = `${financeBase(f.space)}/recurring-commitments`;
        const root = (
            await f.a
                .post(base, {
                    scope: 'SHARED',
                    kind: 'EXPENSE',
                    description: 'Condomínio',
                    amountInCents: 10000,
                    recurrence: { frequency: 'MONTHLY', dayOfMonth: 14 },
                    startsOn: '2026-10-01',
                    expectedSpaceVersion: f.context.version,
                    distribution: {
                        mode: 'AMOUNTS',
                        shares: [
                            { memberId: f.ma, amountInCents: 6000 },
                            { memberId: f.mb, amountInCents: 4000 },
                        ],
                    },
                    expectedMemberId: f.ma,
                })
                .expect(201)
        ).body.commitment;
        const baseChange = {
            scope: 'SHARED' as const,
            kind: 'EXPENSE' as const,
            valueMode: 'FIXED' as const,
            description: 'Condomínio',
            amountInCents: 10000,
            recurrence: { frequency: 'MONTHLY' as const, dayOfMonth: 14 },
            effectiveFrom: '2026-11-01',
            expectedCommitmentVersion: 1,
            expectedSpaceVersion: f.context.version,
            expectedMemberId: f.ma,
        };
        const increase = {
            ...baseChange,
            distribution: {
                mode: 'AMOUNTS',
                shares: [
                    { memberId: f.ma, amountInCents: 5000 },
                    { memberId: f.mb, amountInCents: 5000 },
                ],
            },
        };
        const preview = (
            await f.a
                .post(`${base}/${root.id}/change-preview`, increase)
                .expect(200)
        ).body;
        expect(preview.requiresAcceptance).toBe(true);
        expect(preview.impactByMember).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    memberId: f.mb,
                    fixedDeltaInCents: '25000',
                    requiresAcceptance: true,
                }),
            ]),
        );
        await f.a.post(`${base}/${root.id}/versions`, increase).expect(409);
        expect(
            (
                await db.query(
                    'SELECT COUNT(*)::int AS n FROM financial_recurrence_versions WHERE commitment_id=$1',
                    [root.id],
                )
            )[0].n,
        ).toBe(1);
        const decrease = {
            ...baseChange,
            distribution: {
                mode: 'AMOUNTS',
                shares: [
                    { memberId: f.ma, amountInCents: 7000 },
                    { memberId: f.mb, amountInCents: 3000 },
                ],
            },
        };
        const accepted = (
            await f.a.post(`${base}/${root.id}/versions`, decrease).expect(201)
        ).body;
        expect(accepted.impact.requiresAcceptance).toBe(false);
        const projected = (
            await f.a.agent
                .get(`${base}/${root.id}/occurrences?month=2026-11`)
                .expect(200)
        ).body;
        expect(projected.items[0].economicVersion).toBe(2);
        expect(projected.items[0].economicShares).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    memberId: f.ma,
                    amountInCents: 7000,
                }),
                expect.objectContaining({
                    memberId: f.mb,
                    amountInCents: 3000,
                }),
            ]),
        );
        expect(
            (
                await db.query(
                    "SELECT COUNT(*)::int AS n FROM financial_command_audit WHERE commitment_id=$1 AND action='CHANGE_RECURRING_COMMITMENT'",
                    [root.id],
                )
            )[0].n,
        ).toBe(1);
        const annual = (
            await f.a
                .post(base, {
                    scope: 'SHARED',
                    kind: 'EXPENSE',
                    description: 'Seguro anual',
                    amountInCents: 10000,
                    recurrence: {
                        frequency: 'ANNUAL',
                        monthOfYear: 10,
                        dayOfMonth: 1,
                    },
                    startsOn: '2026-10-01',
                    expectedSpaceVersion: f.context.version,
                    distribution: {
                        mode: 'AMOUNTS',
                        shares: [
                            { memberId: f.ma, amountInCents: 6000 },
                            { memberId: f.mb, amountInCents: 4000 },
                        ],
                    },
                    expectedMemberId: f.ma,
                })
                .expect(201)
        ).body.commitment;
        const laterAnnual = {
            scope: 'SHARED' as const,
            kind: 'EXPENSE' as const,
            valueMode: 'FIXED' as const,
            description: 'Seguro anual maior',
            amountInCents: 12000,
            recurrence: {
                frequency: 'ANNUAL' as const,
                monthOfYear: 10,
                dayOfMonth: 1,
            },
            effectiveFrom: '2026-10-17',
            expectedCommitmentVersion: 1,
            expectedSpaceVersion: f.context.version,
            expectedMemberId: f.ma,
            distribution: {
                mode: 'AMOUNTS',
                shares: [
                    { memberId: f.ma, amountInCents: 6000 },
                    { memberId: f.mb, amountInCents: 6000 },
                ],
            },
        };
        const annualPreview = (
            await f.a
                .post(`${base}/${annual.id}/change-preview`, laterAnnual)
                .expect(200)
        ).body;
        expect(annualPreview.proposedOccurrences).toContain('2027-10-01');
        expect(annualPreview.requiresAcceptance).toBe(true);
        await f.a
            .post(`${base}/${annual.id}/versions`, laterAnnual)
            .expect(409);
    });

    it('treats a variable estimate as non-onerous but blocks extra monthly shared income frequency loss', async () => {
        const f = await sharedFinance(app);
        const base = `${financeBase(f.space)}/recurring-commitments`;
        const root = (
            await f.a
                .post(base, {
                    scope: 'SHARED',
                    kind: 'INCOME',
                    valueMode: 'VARIABLE',
                    description: 'Royalties',
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
        const change = {
            scope: 'SHARED' as const,
            kind: 'INCOME' as const,
            valueMode: 'VARIABLE' as const,
            description: 'Royalties',
            expectedAmountInCents: 20000,
            recurrence: { frequency: 'MONTHLY' as const, dayOfMonth: 14 },
            effectiveFrom: '2026-11-01',
            expectedCommitmentVersion: 1,
            expectedSpaceVersion: f.context.version,
            expectedMemberId: f.ma,
            distribution: {
                mode: 'PERCENTAGES',
                shares: [
                    { memberId: f.ma, basisPoints: 6000 },
                    { memberId: f.mb, basisPoints: 4000 },
                ],
            },
        };
        expect(
            (
                await f.a
                    .post(`${base}/${root.id}/change-preview`, change)
                    .expect(200)
            ).body.requiresAcceptance,
        ).toBe(false);
        await f.a.post(`${base}/${root.id}/versions`, change).expect(201);
        const reduced = {
            ...change,
            expectedCommitmentVersion: 2,
            effectiveFrom: '2026-12-01',
            recurrence: {
                frequency: 'ANNUAL' as const,
                monthOfYear: 12,
                dayOfMonth: 14,
            },
        };
        const preview = (
            await f.a
                .post(`${base}/${root.id}/change-preview`, reduced)
                .expect(200)
        ).body;
        expect(preview.requiresAcceptance).toBe(true);
        await f.a.post(`${base}/${root.id}/versions`, reduced).expect(409);
        expect(
            (
                await db.query(
                    'SELECT COUNT(*)::int AS n FROM financial_recurrence_versions WHERE commitment_id=$1',
                    [root.id],
                )
            )[0].n,
        ).toBe(2);
    });
});
