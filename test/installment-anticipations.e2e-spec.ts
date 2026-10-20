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
    financeSnapshot,
    sharedFinance,
} from './settlement-fixture.js';

describe('installment anticipations', () => {
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

    it('previews and anticipates the two farthest personal installments with individual discount and surcharge', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/installment-commitments`;
        const root = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    description: 'Compra parcelada',
                    count: 3,
                    firstDueDate: '2026-11-20',
                    cadence: 'MONTHLY',
                    totalAmountInCents: 30000,
                })
                .expect(201)
        ).body.commitment;
        const options = (
            await browser.agent
                .get(`${base}/${root.id}/anticipation-options`)
                .expect(200)
        ).body;
        expect(
            options.items.map((item: { position: number }) => item.position),
        ).toEqual([3, 2, 1]);
        expect(options.totalEligibleCount).toBe(3);
        const selection = { mode: 'FROM_END', quantity: 2 };
        const previewBase = `${base}/${root.id}/anticipation-preview`;
        const before = await financeSnapshot(db);
        const selected = (
            await browser
                .post(previewBase, { selection, factDate: today })
                .expect(200)
        ).body;
        expect(
            selected.items.map((item: { position: number }) => item.position),
        ).toEqual([3, 2]);
        expect(selected.totalExpectedRemainingAmountInCents).toBe('20000');
        const values = selected.items.map(
            (
                item: {
                    installmentId: string;
                    expectedInstallmentVersion: number;
                },
                index: number,
            ) => ({
                installmentId: item.installmentId,
                expectedInstallmentVersion: item.expectedInstallmentVersion,
                paidAmountInCents: index === 0 ? 9000 : 11000,
            }),
        );
        const preview = (
            await browser
                .post(previewBase, {
                    selection,
                    factDate: today,
                    values,
                    method: 'PIX',
                })
                .expect(200)
        ).body;
        expect(
            preview.items.map(
                (item: { adjustmentInCents: number }) => item.adjustmentInCents,
            ),
        ).toEqual([-1000, 1000]);
        expect(preview.totalPaidAmountInCents).toBe('20000');
        expect(await financeSnapshot(db)).toEqual(before);
        const command = {
            selection,
            factDate: today,
            values,
            method: 'PIX',
            expectedCommitmentVersion: preview.expectedCommitmentVersion,
        };
        const key = randomUUID();
        const created = (
            await browser
                .post(`${base}/${root.id}/anticipations`, command, key)
                .expect(201)
        ).body;
        expect(
            created.items.map(
                (item: { installmentId: string }) => item.installmentId,
            ),
        ).toEqual(
            values.map((item: { installmentId: string }) => item.installmentId),
        );
        expect(created.commitment).toMatchObject({
            version: 3,
            plan: {
                totalAmountInCents: 30000,
                fulfilledAmountInCents: 20000,
                remainingAmountInCents: 10000,
            },
        });
        expect(
            created.commitment.plan.installments.map(
                (item: { amountInCents: number }) => item.amountInCents,
            ),
        ).toEqual([10000, 10000, 10000]);
        expect(
            created.commitment.plan.installments.map(
                (item: { dueDate: string }) => item.dueDate,
            ),
        ).toEqual(['2026-11-20', '2026-12-20', '2027-01-20']);
        expect(
            (
                await browser
                    .post(`${base}/${root.id}/anticipations`, command, key)
                    .expect(200)
            ).body,
        ).toMatchObject({ replayed: true, items: created.items });
        await browser
            .post(
                `${base}/${root.id}/anticipations`,
                { ...command, method: 'CASH' },
                key,
            )
            .expect(409);
        const december = (
            await browser.agent
                .get(`${financeBase(space)}/financial-forecast?month=2026-12`)
                .expect(200)
        ).body;
        expect(december.totals.expectedAmountInCents).toBe('0');
        const overview = (
            await browser.agent
                .get(`${financeBase(space)}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        expect(overview.totals).toMatchObject({
            expenseAmountInCents: '20000',
            paidAmountInCents: '20000',
        });
        const timeline = (
            await browser.agent
                .get(
                    `${financeBase(space)}/financial-timeline?month=2026-10&view=HISTORY`,
                )
                .expect(200)
        ).body;
        expect(
            timeline.items.map((item: { type: string }) => item.type),
        ).toEqual(
            expect.arrayContaining(['EXPENSE_DISCOUNT', 'EXPENSE_SURCHARGE']),
        );
        const audit = await db.query(
            'SELECT action FROM financial_command_audit WHERE commitment_id=$1 AND action=$2',
            [root.id, 'ANTICIPATE_INSTALLMENTS'],
        );
        expect(audit).toHaveLength(1);
    });

    it('closes only the remaining part of a previously paid installment and preserves both facts', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/installment-commitments`;
        const root = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    description: 'Parcial',
                    count: 1,
                    firstDueDate: '2026-11-20',
                    cadence: 'MONTHLY',
                    totalAmountInCents: 10000,
                })
                .expect(201)
        ).body.commitment;
        const installment = root.plan.installments[0];
        await browser
            .post(
                `${base}/${root.id}/installments/${installment.id}/disbursements`,
                {
                    expectedCommitmentVersion: 1,
                    expectedInstallmentVersion: 1,
                    amountInCents: 2000,
                    factDate: today,
                    method: 'PIX',
                },
            )
            .expect(201);
        const values = [
            {
                installmentId: installment.id,
                expectedInstallmentVersion: 2,
                paidAmountInCents: 7000,
            },
        ];
        const command = {
            selection: { mode: 'IDS', installmentIds: [installment.id] },
            values,
            factDate: today,
            method: 'DEBIT',
            expectedCommitmentVersion: 2,
        };
        const preview = (
            await browser
                .post(`${base}/${root.id}/anticipation-preview`, command)
                .expect(200)
        ).body;
        expect(preview.items[0]).toMatchObject({
            previouslyFulfilledAmountInCents: 2000,
            expectedRemainingAmountInCents: 8000,
            paidAmountInCents: 7000,
            effectiveAmountInCents: 9000,
            adjustmentInCents: -1000,
        });
        const result = (
            await browser
                .post(`${base}/${root.id}/anticipations`, command)
                .expect(201)
        ).body;
        expect(result.commitment.plan).toMatchObject({
            status: 'COMPLETED',
            totalAmountInCents: 10000,
            fulfilledAmountInCents: 9000,
            remainingAmountInCents: 0,
        });
        const details = (
            await browser.agent
                .get(`${base}/${root.id}/installments`)
                .expect(200)
        ).body;
        expect(details.items[0]).toMatchObject({
            amountInCents: 10000,
            effectiveAmountInCents: 9000,
            fulfilledAmountInCents: 9000,
            remainingAmountInCents: 0,
            status: 'FULFILLED',
            facts: [expect.any(Object), expect.any(Object)],
        });
        await browser
            .post(
                `${base}/${root.id}/installments/${installment.id}/disbursements`,
                {
                    expectedCommitmentVersion: 3,
                    expectedInstallmentVersion: 3,
                    amountInCents: 100,
                    factDate: today,
                    method: 'PIX',
                },
            )
            .expect(409);
        const forecast = (
            await browser.agent
                .get(`${financeBase(space)}/financial-forecast?month=2026-11`)
                .expect(200)
        ).body;
        expect(forecast.totals.expectedAmountInCents).toBe('0');
        const overview = (
            await browser.agent
                .get(`${financeBase(space)}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        expect(overview.totals).toMatchObject({
            expenseAmountInCents: '9000',
            paidAmountInCents: '9000',
        });
    });

    it('allocates a shared surcharge to the actor and a discount proportionally without charging the other member more', async () => {
        const f = await sharedFinance(app);
        const base = `${financeBase(f.space)}/installment-commitments`;
        const root = (
            await f.a
                .post(base, {
                    scope: 'SHARED',
                    description: 'Compra conjunta',
                    count: 2,
                    firstDueDate: '2026-11-20',
                    cadence: 'MONTHLY',
                    amountsInCents: [10000, 10000],
                    distribution: {
                        mode: 'AMOUNTS',
                        shares: [
                            { memberId: f.ma, amountInCents: 10000 },
                            { memberId: f.mb, amountInCents: 10000 },
                        ],
                    },
                    expectedMemberId: f.ma,
                    expectedSpaceVersion: f.context.version,
                    expectedRuleVersion: 0,
                })
                .expect(201)
        ).body.commitment;
        const ids = root.plan.installments.map(
            (item: { id: string }) => item.id,
        );
        const values = [
            {
                installmentId: ids[0],
                expectedInstallmentVersion: 1,
                paidAmountInCents: 12000,
            },
            {
                installmentId: ids[1],
                expectedInstallmentVersion: 1,
                paidAmountInCents: 8000,
            },
        ];
        const command = {
            selection: { mode: 'IDS', installmentIds: ids },
            values,
            factDate: today,
            method: 'PIX',
            payerMemberId: f.ma,
            expectedCommitmentVersion: 1,
            expectedSpaceVersion: f.context.version,
            settlement: { mode: 'NONE' },
        };
        await f.a
            .post(`${base}/${root.id}/anticipation-preview`, {
                ...command,
                settlement: { mode: 'CYCLE', cycleId: randomUUID() },
            })
            .expect(404);
        const preview = (
            await f.a
                .post(`${base}/${root.id}/anticipation-preview`, command)
                .expect(200)
        ).body;
        expect(preview.adjustmentPolicy).toBe(
            'DISCOUNT_PROPORTIONAL_SURCHARGE_ACTOR',
        );
        expect(preview.settlement).toEqual({ mode: 'NONE' });
        const shares = preview.items.map(
            (item: {
                effectiveEconomicShares: {
                    memberId: string;
                    amountInCents: number;
                }[];
            }) => item.effectiveEconomicShares,
        );
        expect(
            shares[0].find(
                (item: { memberId: string }) => item.memberId === f.ma,
            ).amountInCents,
        ).toBe(7000);
        expect(
            shares[0].find(
                (item: { memberId: string }) => item.memberId === f.mb,
            ).amountInCents,
        ).toBe(5000);
        expect(
            shares[1]
                .map((item: { amountInCents: number }) => item.amountInCents)
                .sort(),
        ).toEqual([4000, 4000]);
        const result = (
            await f.a
                .post(`${base}/${root.id}/anticipations`, command)
                .expect(201)
        ).body;
        expect(result.commitment.plan.status).toBe('COMPLETED');
        const overview = (
            await f.a.agent
                .get(`${financeBase(f.space)}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        expect(overview.totals).toMatchObject({
            expenseAmountInCents: '20000',
            paidAmountInCents: '20000',
        });
        expect(
            overview.byMember.find(
                (item: { memberId: string }) => item.memberId === f.ma,
            ).expenseAmountInCents,
        ).toBe('11000');
        expect(
            overview.byMember.find(
                (item: { memberId: string }) => item.memberId === f.mb,
            ).expenseAmountInCents,
        ).toBe('9000');
        const position = (
            await f.a.agent
                .get(`${financeBase(f.space)}/inter-member-position`)
                .expect(200)
        ).body;
        expect(position.summary.receivableAmountInCents).toBe('9000');
        expect(JSON.stringify(position)).toContain(ids[0]);
        expect(JSON.stringify(position)).toContain(ids[1]);
        const forecast = (
            await f.a.agent
                .get(`${financeBase(f.space)}/financial-forecast?month=2026-11`)
                .expect(200)
        ).body;
        expect(forecast.totals.expectedAmountInCents).toBe('0');
    });

    it('rejects duplicate, foreign, resolved, outdated and non-early selections without partial writes', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/installment-commitments`;
        const root = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    description: 'Lote',
                    count: 2,
                    firstDueDate: '2026-11-20',
                    cadence: 'MONTHLY',
                    totalAmountInCents: 20000,
                })
                .expect(201)
        ).body.commitment;
        const ids = root.plan.installments.map(
            (item: { id: string }) => item.id,
        );
        const values = ids.map((id: string) => ({
            installmentId: id,
            expectedInstallmentVersion: 1,
            paidAmountInCents: 10000,
        }));
        const command = {
            selection: { mode: 'IDS', installmentIds: ids },
            values,
            factDate: today,
            method: 'PIX',
            expectedCommitmentVersion: 1,
        };
        await browser
            .post(`${base}/${root.id}/anticipations`, {
                ...command,
                selection: { mode: 'IDS', installmentIds: [ids[0], ids[0]] },
            })
            .expect(409);
        await browser
            .post(`${base}/${root.id}/anticipations`, {
                ...command,
                values: [
                    { ...values[0], installmentId: randomUUID() },
                    values[1],
                ],
            })
            .expect(409);
        await browser
            .post(`${base}/${root.id}/anticipations`, {
                ...command,
                factDate: '2026-11-20',
            })
            .expect(400);
        expect(
            (
                await db.query(
                    'SELECT COUNT(*)::int AS n FROM financial_installment_anticipations',
                )
            )[0].n,
        ).toBe(0);
        await browser
            .post(`${base}/${root.id}/installments/${ids[1]}/disbursements`, {
                expectedCommitmentVersion: 1,
                expectedInstallmentVersion: 1,
                amountInCents: 10000,
                factDate: today,
                method: 'PIX',
            })
            .expect(201);
        await browser
            .post(`${base}/${root.id}/anticipations`, command)
            .expect(409);
        const options = (
            await browser.agent
                .get(`${base}/${root.id}/anticipation-options`)
                .expect(200)
        ).body;
        expect(options.items[0]).toMatchObject({
            id: ids[1],
            selectionEligible: false,
            blockingReason: 'INSTALLMENT_ALREADY_FULFILLED',
        });
        expect(
            (
                await db.query(
                    'SELECT COUNT(*)::int AS n FROM financial_installment_anticipations',
                )
            )[0].n,
        ).toBe(0);
    });

    it('paginates future options and rolls back all installments when audit persistence fails', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/installment-commitments`;
        const root = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    description: 'Muitas parcelas',
                    count: 21,
                    firstDueDate: '2026-11-20',
                    cadence: 'MONTHLY',
                    baseAmountInCents: 1000,
                })
                .expect(201)
        ).body.commitment;
        const path = `${base}/${root.id}`;
        const first = (
            await browser.agent.get(`${path}/anticipation-options`).expect(200)
        ).body;
        expect(first.items).toHaveLength(20);
        expect(first.nextCursor).toEqual(expect.any(String));
        const second = (
            await browser.agent
                .get(`${path}/anticipation-options`)
                .query({ cursor: first.nextCursor })
                .expect(200)
        ).body;
        expect(second.items).toHaveLength(1);
        expect(second.nextCursor).toBeNull();
        const selected = (
            await browser
                .post(`${path}/anticipation-preview`, {
                    selection: { mode: 'FROM_END', quantity: 2 },
                    factDate: today,
                })
                .expect(200)
        ).body;
        const command = {
            selection: { mode: 'FROM_END', quantity: 2 },
            factDate: today,
            values: selected.items.map(
                (item: {
                    installmentId: string;
                    expectedInstallmentVersion: number;
                    expectedRemainingAmountInCents: number;
                }) => ({
                    installmentId: item.installmentId,
                    expectedInstallmentVersion: item.expectedInstallmentVersion,
                    paidAmountInCents: item.expectedRemainingAmountInCents,
                }),
            ),
            method: 'PIX',
            expectedCommitmentVersion: 1,
        };
        await db.query(
            "ALTER TABLE financial_command_audit ADD CONSTRAINT test_installment_anticipations_audit_failure CHECK (action <> 'ANTICIPATE_INSTALLMENTS') NOT VALID",
        );
        try {
            await browser.post(`${path}/anticipations`, command).expect(500);
            expect(
                (
                    await db.query(
                        'SELECT COUNT(*)::int AS n FROM financial_installment_anticipations',
                    )
                )[0].n,
            ).toBe(0);
            expect(
                (
                    await db.query(
                        'SELECT COUNT(*)::int AS n FROM financial_disbursements WHERE commitment_id=$1',
                        [root.id],
                    )
                )[0].n,
            ).toBe(0);
            expect(
                (await browser.agent.get(path).expect(200)).body.commitment
                    .version,
            ).toBe(1);
        } finally {
            await db.query(
                'ALTER TABLE financial_command_audit DROP CONSTRAINT test_installment_anticipations_audit_failure',
            );
        }
        const committed = (
            await browser.post(`${path}/anticipations`, command).expect(201)
        ).body;
        expect(committed.items).toHaveLength(2);
    });

    it('serializes a competing batch anticipation and installment payment without a half-applied batch', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/installment-commitments`;
        const root = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    description: 'Corrida',
                    count: 2,
                    firstDueDate: '2026-11-20',
                    cadence: 'MONTHLY',
                    baseAmountInCents: 10000,
                })
                .expect(201)
        ).body.commitment;
        const ids = root.plan.installments.map(
            (item: { id: string }) => item.id,
        );
        const anticipation = browser.post(`${base}/${root.id}/anticipations`, {
            selection: { mode: 'FROM_END', quantity: 2 },
            values: [ids[1], ids[0]].map((id: string) => ({
                installmentId: id,
                expectedInstallmentVersion: 1,
                paidAmountInCents: 9000,
            })),
            factDate: today,
            method: 'PIX',
            expectedCommitmentVersion: 1,
        });
        const payment = browser.post(
            `${base}/${root.id}/installments/${ids[1]}/disbursements`,
            {
                expectedCommitmentVersion: 1,
                expectedInstallmentVersion: 1,
                amountInCents: 1000,
                factDate: today,
                method: 'PIX',
            },
        );
        const outcomes = await Promise.all([anticipation, payment]);
        expect(outcomes.map((result) => result.status).sort()).toEqual([
            201, 409,
        ]);
        const count = (
            await db.query(
                'SELECT COUNT(*)::int AS n FROM financial_installment_anticipations WHERE commitment_id=$1',
                [root.id],
            )
        )[0].n;
        expect([0, 2]).toContain(count);
        expect(
            (await browser.agent.get(`${base}/${root.id}`).expect(200)).body
                .commitment.version,
        ).toBe(count === 2 ? 3 : 2);
    });
});
