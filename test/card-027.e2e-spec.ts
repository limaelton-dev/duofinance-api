import 'reflect-metadata';
import { rewindFinanceMigrationsTo } from './settlement-fixture.js';
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
    financeSnapshot,
    sharedFinance,
} from './settlement-fixture.js';

describe('CARD-027 finite installment commitments', () => {
    let app: INestApplication<Server>;
    let db: DataSource;
    const instant = new Date('2026-10-14T15:00:00Z');
    const today = '2026-10-14';

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
            .useValue({ now: () => instant, today: () => today })
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

    it('previews the exact residual, confirms one finite plan, and realizes only the open remainder of one personal installment', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/installment-commitments`;
        const input = {
            scope: 'PERSONAL',
            description: 'Notebook',
            count: 3,
            firstDueDate: '2026-10-31',
            cadence: 'MONTHLY',
            totalAmountInCents: 100000,
            plannedPaymentMethod: 'CARD',
        };
        const before = await financeSnapshot(db);
        const preview = (
            await browser.post(`${base}/preview`, input).expect(200)
        ).body;
        expect(preview.installments).toMatchObject([
            { position: 1, dueDate: '2026-10-31', amountInCents: 33333 },
            { position: 2, dueDate: '2026-11-30', amountInCents: 33333 },
            { position: 3, dueDate: '2026-12-31', amountInCents: 33334 },
        ]);
        expect(preview.totalAmountInCents).toBe(100000);
        expect(await financeSnapshot(db)).toEqual(before);
        const key = randomUUID();
        const created = (await browser.post(base, input, key).expect(201)).body;
        const root = created.commitment;
        expect(root).toMatchObject({
            modality: 'INSTALLMENT',
            scope: 'PERSONAL',
            version: 1,
            plan: {
                totalAmountInCents: 100000,
                remainingAmountInCents: 100000,
                count: 3,
                plannedPaymentMethod: 'CARD',
                status: 'OPEN',
            },
        });
        expect(
            root.plan.installments.map(
                (item: {
                    position: number;
                    dueDate: string;
                    amountInCents: number;
                }) => ({
                    position: item.position,
                    dueDate: item.dueDate,
                    amountInCents: item.amountInCents,
                }),
            ),
        ).toEqual(
            preview.installments.map(
                (item: {
                    position: number;
                    dueDate: string;
                    amountInCents: number;
                }) => ({
                    position: item.position,
                    dueDate: item.dueDate,
                    amountInCents: item.amountInCents,
                }),
            ),
        );
        expect(
            new Set(
                root.plan.installments.map((item: { id: string }) => item.id),
            ).size,
        ).toBe(3);
        expect(
            (await browser.post(base, input, key).expect(200)).body.replayed,
        ).toBe(true);
        await browser
            .post(base, { ...input, description: 'Outro' }, key)
            .expect(409);
        expect(
            (
                await db.query(
                    'SELECT COUNT(*)::int AS n FROM financial_external_liabilities WHERE commitment_id=$1',
                    [root.id],
                )
            )[0].n,
        ).toBe(0);
        const first = root.plan.installments[0];
        const path = `${base}/${root.id}/installments/${first.id}`;
        const payment = {
            expectedCommitmentVersion: 1,
            expectedInstallmentVersion: 1,
            amountInCents: 10000,
            factDate: today,
            method: 'PIX',
        };
        const paid = (
            await browser.post(`${path}/disbursements`, payment).expect(201)
        ).body;
        expect(paid.installment).toMatchObject({
            status: 'PARTIALLY_FULFILLED',
            stateVersion: 2,
            fulfilledAmountInCents: 10000,
            remainingAmountInCents: 23333,
        });
        expect(paid.commitment).toMatchObject({
            version: 2,
            plan: { remainingAmountInCents: 90000 },
        });
        await browser.post(`${path}/disbursements`, payment).expect(409);
        const forecast = (
            await browser.agent
                .get(`${financeBase(space)}/financial-forecast?month=2026-10`)
                .expect(200)
        ).body;
        expect(forecast.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: first.id,
                    commitmentId: root.id,
                    amountInCents: 33333,
                    fulfilledAmountInCents: 10000,
                    remainingAmountInCents: 23333,
                }),
            ]),
        );
        expect(forecast.totals.expectedExpenseAmountInCents).toBe('33333');
        const november = (
            await browser.agent
                .get(`${financeBase(space)}/financial-forecast?month=2026-11`)
                .expect(200)
        ).body;
        expect(november.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: root.plan.installments[1].id,
                    amountInCents: 33333,
                    remainingAmountInCents: 33333,
                }),
            ]),
        );
        const overview = (
            await browser.agent
                .get(`${financeBase(space)}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        expect(overview.totals.expenseAmountInCents).toBe('33333');
        const listed = (await browser.agent.get(base).expect(200)).body;
        expect(listed).toMatchObject({
            totalCount: 1,
            totalAmountInCents: '100000',
        });
        const details = (
            await browser.agent
                .get(`${base}/${root.id}/installments`)
                .expect(200)
        ).body;
        expect(details.items).toHaveLength(3);
        expect(details.items[0]).toMatchObject({
            id: first.id,
            stateVersion: 2,
            remainingAmountInCents: 23333,
        });
        await browser.agent
            .get(`${base}/${root.id}/installments/${randomUUID()}/options`)
            .expect(404);
    });

    it('allocates shared manual parcels exactly and tracks partial external liability, settlement, origin and replay', async () => {
        const f = await sharedFinance(app);
        const base = `${financeBase(f.space)}/installment-commitments`;
        const input = {
            scope: 'SHARED',
            description: 'Compra conjunta',
            count: 2,
            explicitDueDates: ['2026-10-20', '2026-11-20'],
            amountsInCents: [6001, 3999],
            distribution: {
                mode: 'AMOUNTS',
                shares: [
                    { memberId: f.ma, amountInCents: 4000 },
                    { memberId: f.mb, amountInCents: 6000 },
                ],
            },
            expectedMemberId: f.ma,
            plannedPaymentMethod: 'CARD',
        };
        const preview = (await f.a.post(`${base}/preview`, input).expect(200))
            .body;
        expect(preview).toMatchObject({
            totalAmountInCents: 10000,
            expectedSpaceVersion: f.context.version,
            expectedRuleVersion: 0,
        });
        expect(
            preview.installments.map(
                (item: {
                    economicShares: {
                        memberId: string;
                        amountInCents: number;
                    }[];
                }) =>
                    item.economicShares.reduce(
                        (sum, share) => sum + share.amountInCents,
                        0,
                    ),
            ),
        ).toEqual([6001, 3999]);
        for (const member of [f.ma, f.mb])
            expect(
                preview.installments.reduce(
                    (
                        sum: number,
                        item: {
                            economicShares: {
                                memberId: string;
                                amountInCents: number;
                            }[];
                        },
                    ) =>
                        sum +
                        item.economicShares.find(
                            (share) => share.memberId === member,
                        )!.amountInCents,
                    0,
                ),
            ).toBe(member === f.ma ? 4000 : 6000);
        const root = (
            await f.a
                .post(base, {
                    ...input,
                    expectedSpaceVersion: f.context.version,
                    expectedRuleVersion: 0,
                })
                .expect(201)
        ).body.commitment;
        expect(
            root.plan.installments.map(
                (item: { economicShares: unknown }) => item.economicShares,
            ),
        ).toEqual(
            preview.installments.map(
                (item: { economicShares: unknown }) => item.economicShares,
            ),
        );
        const first = root.plan.installments[0];
        const path = `${base}/${root.id}/installments/${first.id}`;
        for (let day = 1; day <= 21; day++)
            await db.query(
                `INSERT INTO settlement_cycles(id,space_id,target_date,status,version) VALUES($1,$2,$3,'OPEN',1)`,
                [
                    randomUUID(),
                    f.space,
                    `2026-11-${String(day).padStart(2, '0')}`,
                ],
            );
        const options = (await f.a.agent.get(`${path}/options`).expect(200))
            .body;
        expect(options).toMatchObject({
            expectedSpaceVersion: f.context.version,
            installment: { id: first.id, stateVersion: 1 },
        });
        expect(options.openCycles).toHaveLength(20);
        expect(options.nextCursor).toEqual(expect.any(String));
        const next = (
            await f.a.agent
                .get(`${path}/options`)
                .query({ cursor: options.nextCursor })
                .expect(200)
        ).body;
        expect(next.openCycles).toHaveLength(1);
        expect(next.openCycles[0].targetDate).toBe('2026-11-21');
        expect(next.nextCursor).toBeNull();
        const liability = {
            expectedCommitmentVersion: 1,
            expectedInstallmentVersion: 1,
            expectedSpaceVersion: f.context.version,
            holderMemberId: f.ma,
            amountInCents: 3000,
            factDate: today,
            settlement: { mode: 'NONE' },
        };
        const key = randomUUID();
        const assumed = (
            await f.a
                .post(`${path}/external-liabilities`, liability, key)
                .expect(201)
        ).body;
        expect(assumed.installment).toMatchObject({
            status: 'PARTIALLY_FULFILLED',
            fulfilledAmountInCents: 3000,
            remainingAmountInCents: 3001,
        });
        expect(
            (
                await f.a
                    .post(`${path}/external-liabilities`, liability, key)
                    .expect(200)
            ).body.replayed,
        ).toBe(true);
        const liabilityId = assumed.installment.facts[0].id as string;
        const origin = (
            await f.a.agent
                .get(`${financeBase(f.space)}/inter-member-position`)
                .expect(200)
        ).body;
        expect(JSON.stringify(origin)).toContain(first.id);
        const settlementInput = {
            expectedCommitmentVersion: 2,
            expectedInstallmentVersion: 2,
            expectedSpaceVersion: f.context.version,
            amountInCents: 1200,
            factDate: today,
        };
        const settled = (
            await f.a
                .post(
                    `${path}/external-liabilities/${liabilityId}/settlements`,
                    settlementInput,
                )
                .expect(201)
        ).body;
        expect(settled.settlement.remainingAmountInCents).toBe(1800);
        expect(settled.installment).toMatchObject({
            stateVersion: 3,
            remainingAmountInCents: 3001,
        });
        expect(settled.commitment.version).toBe(3);
        const forecast = (
            await f.a.agent
                .get(`${financeBase(f.space)}/financial-forecast?month=2026-10`)
                .expect(200)
        ).body;
        expect(forecast.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: first.id,
                    fulfilledAmountInCents: 3000,
                    remainingAmountInCents: 3001,
                }),
            ]),
        );
        const audit = await db.query(
            `SELECT action FROM financial_command_audit WHERE commitment_id=$1 ORDER BY registered_at,action`,
            [root.id],
        );
        expect(
            audit.map((row: { action: string }) => row.action).sort(),
        ).toEqual([
            'CREATE_INSTALLMENT_COMMITMENT',
            'RECORD_INSTALLMENT_EXTERNAL_LIABILITY',
            'SETTLE_INSTALLMENT_EXTERNAL_LIABILITY',
        ]);
    });

    it('rejects invalid schedules and stale shared confirmation without persisting a partial plan', async () => {
        const f = await sharedFinance(app);
        const base = `${financeBase(f.space)}/installment-commitments`;
        const input = {
            scope: 'SHARED',
            description: 'Projeto',
            count: 1,
            firstDueDate: '2026-11-15',
            cadence: 'MONTHLY',
            totalAmountInCents: 5000,
            distribution: {
                mode: 'PERCENTAGES',
                shares: [
                    { memberId: f.ma, basisPoints: 5000 },
                    { memberId: f.mb, basisPoints: 5000 },
                ],
            },
            expectedSpaceVersion: f.context.version,
            expectedRuleVersion: 0,
        };
        await f.a.post(base, { ...input, count: 0 }).expect(400);
        await f.a
            .post(base, { ...input, firstDueDate: '2026-02-30' })
            .expect(400);
        await f.a
            .post(base, { ...input, totalAmountInCents: 2, count: 3 })
            .expect(400);
        await f.a
            .post(base, {
                ...input,
                expectedSpaceVersion: f.context.version + 1,
            })
            .expect(409);
        expect(
            (
                await db.query(
                    "SELECT COUNT(*)::int AS n FROM financial_commitments WHERE modality='INSTALLMENT'",
                )
            )[0].n,
        ).toBe(0);
        expect(
            (
                await db.query(
                    'SELECT COUNT(*)::int AS n FROM financial_installment_plans',
                )
            )[0].n,
        ).toBe(0);
        const created = (await f.a.post(base, input).expect(201)).body
            .commitment;
        expect(created.plan.installments).toHaveLength(1);
        expect(created.plan.installments[0]).toMatchObject({
            position: 1,
            amountInCents: 5000,
        });
        const outsider = await financeBrowser(app, 'Pessoa fora');
        await outsider.agent.get(`${base}/${created.id}`).expect(404);
        expect(
            (
                await db.query(
                    'SELECT COUNT(*)::int AS n FROM financial_installment_plans',
                )
            )[0].n,
        ).toBe(1);
    });

    it('reverts a persisted pending plan before restoring occurrence constraints', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        await browser
            .post(`${financeBase(space)}/installment-commitments`, {
                scope: 'PERSONAL',
                description: 'Plano reversível',
                count: 2,
                firstDueDate: '2026-11-10',
                cadence: 'MONTHLY',
                totalAmountInCents: 1000,
            })
            .expect(201);
        await app.close();
        await migrationSource.initialize();
        try {
            await rewindFinanceMigrationsTo(
                migrationSource,
                'FiniteInstallmentCommitments1792165400000',
            );
            await migrationSource.undoLastMigration();
            expect(
                (
                    await migrationSource.query(
                        "SELECT COUNT(*)::int AS n FROM financial_commitments WHERE modality='INSTALLMENT'",
                    )
                )[0].n,
            ).toBe(0);
            expect(
                (
                    await migrationSource.query(
                        "SELECT to_regclass('financial_installments') AS relation",
                    )
                )[0].relation,
            ).toBeNull();
        } finally {
            await migrationSource.runMigrations();
            await migrationSource.destroy();
        }
    });
});
