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

describe('CARD-029 installment resolutions', () => {
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

    it('previews and records one global negotiated payoff after a partial payment, preserving child facts and replay', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/installment-commitments`;
        const root = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    description: 'Plano',
                    count: 2,
                    firstDueDate: '2026-11-20',
                    cadence: 'MONTHLY',
                    totalAmountInCents: 20000,
                })
                .expect(201)
        ).body.commitment;
        const first = root.plan.installments[0];
        await browser
            .post(`${base}/${root.id}/installments/${first.id}/disbursements`, {
                expectedCommitmentVersion: 1,
                expectedInstallmentVersion: 1,
                amountInCents: 2000,
                factDate: today,
                method: 'PIX',
            })
            .expect(201);
        await browser
            .post(`${base}/${root.id}/payoff-preview`, {
                paidAmountInCents: 15000,
                factDate: '2026-10-13',
            })
            .expect(400);
        const snapshot = await financeSnapshot(db);
        const preview = (
            await browser
                .post(`${base}/${root.id}/payoff-preview`, {
                    paidAmountInCents: 15000,
                    factDate: today,
                    expectedCommitmentVersion: 2,
                })
                .expect(200)
        ).body;
        expect(preview).toMatchObject({
            expectedRemainingAmountInCents: 18000,
            paidAmountInCents: 15000,
            adjustmentInCents: -3000,
            expectedCommitmentVersion: 2,
        });
        expect(
            preview.items.map(
                (item: { expectedRemainingAmountInCents: number }) =>
                    item.expectedRemainingAmountInCents,
            ),
        ).toEqual([8000, 10000]);
        expect(await financeSnapshot(db)).toEqual(snapshot);
        const command = {
            paidAmountInCents: 15000,
            factDate: today,
            method: 'DEBIT',
            installments: preview.items.map(
                (item: {
                    installmentId: string;
                    expectedInstallmentVersion: number;
                }) => ({
                    installmentId: item.installmentId,
                    expectedInstallmentVersion: item.expectedInstallmentVersion,
                }),
            ),
            expectedCommitmentVersion: 2,
        };
        await browser
            .post(`${base}/${root.id}/payoffs`, {
                ...command,
                factDate: '2026-10-13',
            })
            .expect(400);
        expect(await financeSnapshot(db)).toEqual(snapshot);
        const key = randomUUID();
        const created = (
            await browser
                .post(`${base}/${root.id}/payoffs`, command, key)
                .expect(201)
        ).body;
        expect(created.commitment.plan).toMatchObject({
            status: 'COMPLETED',
            totalAmountInCents: 20000,
            fulfilledAmountInCents: 17000,
            remainingAmountInCents: 0,
        });
        expect(
            created.commitment.plan.installments.map(
                (item: { status: string }) => item.status,
            ),
        ).toEqual(['PAID_OFF', 'PAID_OFF']);
        expect(
            created.items.map(
                (item: { expectedRemainingAmountInCents: number }) =>
                    item.expectedRemainingAmountInCents,
            ),
        ).toEqual([8000, 10000]);
        expect(
            (
                await browser
                    .post(`${base}/${root.id}/payoffs`, command, key)
                    .expect(200)
            ).body.replayed,
        ).toBe(true);
        await browser
            .post(
                `${base}/${root.id}/payoffs`,
                { ...command, paidAmountInCents: 14000 },
                key,
            )
            .expect(409);
        const facts = await db.query(
            'SELECT occurrence_id,amount_in_cents FROM financial_disbursements WHERE commitment_id=$1 ORDER BY sequence',
            [root.id],
        );
        expect(
            facts.map(
                (fact: {
                    occurrence_id: string | null;
                    amount_in_cents: string;
                }) => [fact.occurrence_id, fact.amount_in_cents],
            ),
        ).toEqual([
            [first.id, '2000'],
            [null, '15000'],
        ]);
        const links = await db.query(
            'SELECT installment_id,expected_remaining_amount_in_cents FROM financial_installment_resolutions WHERE commitment_id=$1 ORDER BY expected_remaining_amount_in_cents',
            [root.id],
        );
        expect(
            links.map(
                (link: { expected_remaining_amount_in_cents: string }) =>
                    link.expected_remaining_amount_in_cents,
            ),
        ).toEqual(['8000', '10000']);
        const overview = (
            await browser.agent
                .get(`${financeBase(space)}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        expect(overview.totals).toMatchObject({
            expenseAmountInCents: '17000',
            paidAmountInCents: '17000',
        });
        expect(
            (
                await browser.agent
                    .get(
                        `${financeBase(space)}/financial-forecast?month=2026-11`,
                    )
                    .expect(200)
            ).body.totals.expectedAmountInCents,
        ).toBe('0');
        expect(
            (
                await browser.agent
                    .get(`${base}/${root.id}/installments`)
                    .expect(200)
            ).body.items[0].facts,
        ).toHaveLength(1);
        expect(
            await db.query(
                'SELECT action FROM financial_command_audit WHERE commitment_id=$1 AND action=$2',
                [root.id, 'PAYOFF_INSTALLMENTS'],
            ),
        ).toHaveLength(1);
    });

    it('allocates shared payoff discount and actor-owned surcharge only in the global fact', async () => {
        const f = await sharedFinance(app);
        const base = `${financeBase(f.space)}/installment-commitments`;
        const create = async (description: string) =>
            (
                await f.a
                    .post(base, {
                        scope: 'SHARED',
                        description,
                        count: 2,
                        firstDueDate: '2026-11-20',
                        cadence: 'MONTHLY',
                        totalAmountInCents: 20000,
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
        const discounted = await create('Desconto global');
        const preview = (
            await f.a
                .post(`${base}/${discounted.id}/payoff-preview`, {
                    paidAmountInCents: 16000,
                    factDate: today,
                    payerMemberId: f.ma,
                    method: 'PIX',
                    settlement: { mode: 'NONE' },
                    expectedCommitmentVersion: 1,
                    expectedSpaceVersion: f.context.version,
                })
                .expect(200)
        ).body;
        expect(
            preview.effectiveEconomicShares.map(
                (share: { amountInCents: number }) => share.amountInCents,
            ),
        ).toEqual([8000, 8000]);
        await f.a
            .post(`${base}/${discounted.id}/payoff-preview`, {
                paidAmountInCents: 16000,
                factDate: today,
                settlement: { mode: 'CYCLE', cycleId: randomUUID() },
            })
            .expect(404);
        const command = {
            paidAmountInCents: 16000,
            factDate: today,
            method: 'PIX',
            payerMemberId: f.ma,
            installments: preview.items.map(
                (item: {
                    installmentId: string;
                    expectedInstallmentVersion: number;
                }) => ({
                    installmentId: item.installmentId,
                    expectedInstallmentVersion: item.expectedInstallmentVersion,
                }),
            ),
            expectedCommitmentVersion: 1,
            expectedSpaceVersion: f.context.version,
            settlement: { mode: 'NONE' },
        };
        const discountedResult = await f.a.post(
            `${base}/${discounted.id}/payoffs`,
            command,
        );
        expect(
            discountedResult.status,
            JSON.stringify(discountedResult.body),
        ).toBe(201);
        const surcharged = await create('Acréscimo do ator');
        const extra = (
            await f.a
                .post(`${base}/${surcharged.id}/payoff-preview`, {
                    paidAmountInCents: 22000,
                    factDate: today,
                })
                .expect(200)
        ).body;
        expect(
            extra.effectiveEconomicShares.find(
                (share: { memberId: string }) => share.memberId === f.ma,
            ).amountInCents,
        ).toBe(12000);
        expect(
            extra.effectiveEconomicShares.find(
                (share: { memberId: string }) => share.memberId === f.mb,
            ).amountInCents,
        ).toBe(10000);
        await f.a
            .post(`${base}/${surcharged.id}/payoffs`, {
                ...command,
                paidAmountInCents: 22000,
                installments: extra.items.map(
                    (item: {
                        installmentId: string;
                        expectedInstallmentVersion: number;
                    }) => ({
                        installmentId: item.installmentId,
                        expectedInstallmentVersion:
                            item.expectedInstallmentVersion,
                    }),
                ),
            })
            .expect(201);
        const overview = (
            await f.a.agent
                .get(`${financeBase(f.space)}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        expect(overview.totals).toMatchObject({
            expenseAmountInCents: '38000',
            paidAmountInCents: '38000',
        });
        const member = (id: string) =>
            overview.byMember.find(
                (item: { memberId: string }) => item.memberId === id,
            );
        expect(member(f.ma).expenseAmountInCents).toBe('20000');
        expect(member(f.mb).expenseAmountInCents).toBe('18000');
        const obligations = await db.query(
            'SELECT occurrence_id,original_amount_in_cents FROM inter_member_obligations WHERE commitment_id IN ($1,$2) ORDER BY original_amount_in_cents',
            [discounted.id, surcharged.id],
        );
        expect(
            obligations.map(
                (item: {
                    occurrence_id: string | null;
                    original_amount_in_cents: string;
                }) => [item.occurrence_id, item.original_amount_in_cents],
            ),
        ).toEqual([
            [null, '8000'],
            [null, '10000'],
        ]);
        const otherPayoff = (
            await db.query(
                'SELECT id FROM financial_installment_payoffs WHERE commitment_id=$1',
                [surcharged.id],
            )
        )[0].id as string;
        await expect(
            db.query(
                'UPDATE financial_installment_resolutions SET payoff_id=$1 WHERE commitment_id=$2',
                [otherPayoff, discounted.id],
            ),
        ).rejects.toThrow();
    });

    it('cancels selected future remainders without refunding prior partial cash and rejects external liability atomically', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/installment-commitments`;
        const root = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    description: 'Extinto',
                    count: 3,
                    firstDueDate: '2026-11-20',
                    cadence: 'MONTHLY',
                    totalAmountInCents: 30000,
                })
                .expect(201)
        ).body.commitment;
        const ids = root.plan.installments.map(
            (item: { id: string }) => item.id,
        );
        await browser
            .post(`${base}/${root.id}/installments/${ids[0]}/disbursements`, {
                expectedCommitmentVersion: 1,
                expectedInstallmentVersion: 1,
                amountInCents: 2000,
                factDate: today,
                method: 'PIX',
            })
            .expect(201);
        const options = (
            await browser.agent
                .get(`${base}/${root.id}/resolution-options`)
                .expect(200)
        ).body;
        expect(options.totalOpenCount).toBe(3);
        expect(
            options.items.map(
                (item: { cancellationEligible: boolean }) =>
                    item.cancellationEligible,
            ),
        ).toEqual([true, true, true]);
        const first = [
            { installmentId: ids[0], expectedInstallmentVersion: 2 },
        ];
        const beforeBackdated = await financeSnapshot(db);
        await browser
            .post(`${base}/${root.id}/future-installment-cancellations`, {
                installments: first,
                reason: 'Contrato rescindido',
                factDate: '2026-10-13',
                expectedCommitmentVersion: 2,
            })
            .expect(400);
        expect(await financeSnapshot(db)).toEqual(beforeBackdated);
        await browser
            .post(`${base}/${root.id}/future-installment-cancellations`, {
                installments: first,
                reason: 'Contrato rescindido',
                factDate: today,
                expectedCommitmentVersion: 2,
            })
            .expect(201);
        const details = (
            await browser.agent
                .get(`${base}/${root.id}/installments`)
                .expect(200)
        ).body;
        expect(details.items[0]).toMatchObject({
            status: 'CANCELLED',
            fulfilledAmountInCents: 2000,
            remainingAmountInCents: 0,
        });
        expect(details.items[0].facts).toHaveLength(1);
        await browser
            .post(`${base}/${root.id}/installments/${ids[0]}/disbursements`, {
                expectedCommitmentVersion: 3,
                expectedInstallmentVersion: 3,
                amountInCents: 1000,
                factDate: today,
                method: 'PIX',
            })
            .expect(409);
        const overview = (
            await browser.agent
                .get(`${financeBase(space)}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        expect(overview.totals).toMatchObject({
            expenseAmountInCents: '2000',
            paidAmountInCents: '2000',
        });
        expect(
            (
                await browser.agent
                    .get(
                        `${financeBase(space)}/financial-forecast?month=2026-11`,
                    )
                    .expect(200)
            ).body.totals.expectedAmountInCents,
        ).toBe('0');
        const liability = (
            await browser
                .post(
                    `${base}/${root.id}/installments/${ids[1]}/external-liabilities`,
                    {
                        expectedCommitmentVersion: 3,
                        expectedInstallmentVersion: 1,
                        amountInCents: 3000,
                        factDate: today,
                    },
                )
                .expect(201)
        ).body;
        expect(liability).toBeTruthy();
        const before = await financeSnapshot(db);
        await browser
            .post(`${base}/${root.id}/future-installment-cancellations`, {
                installments: [
                    { installmentId: ids[1], expectedInstallmentVersion: 2 },
                    { installmentId: ids[2], expectedInstallmentVersion: 1 },
                ],
                reason: 'Não devido',
                factDate: today,
                expectedCommitmentVersion: 4,
            })
            .expect(409);
        expect(await financeSnapshot(db)).toEqual(before);
        const remaining = (
            await browser
                .post(`${base}/${root.id}/payoff-preview`, {
                    paidAmountInCents: 10000,
                    factDate: today,
                })
                .expect(200)
        ).body;
        expect(remaining.expectedRemainingAmountInCents).toBe(17000);
        const resolved = (
            await browser
                .post(`${base}/${root.id}/payoffs`, {
                    paidAmountInCents: 17000,
                    factDate: today,
                    method: 'PIX',
                    expectedCommitmentVersion: 4,
                    installments: remaining.items.map(
                        (item: {
                            installmentId: string;
                            expectedInstallmentVersion: number;
                        }) => ({
                            installmentId: item.installmentId,
                            expectedInstallmentVersion:
                                item.expectedInstallmentVersion,
                        }),
                    ),
                })
                .expect(201)
        ).body;
        expect(resolved.commitment.plan).toMatchObject({
            status: 'COMPLETED',
            remainingAmountInCents: 0,
        });
        expect(
            (
                await db.query(
                    'SELECT remaining_amount_in_cents FROM financial_external_liabilities WHERE commitment_id=$1',
                    [root.id],
                )
            )[0].remaining_amount_in_cents,
        ).toBe('3000');
        const finalOverview = (
            await browser.agent
                .get(`${financeBase(space)}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        expect(finalOverview.totals).toMatchObject({
            expenseAmountInCents: '22000',
            paidAmountInCents: '19000',
        });
    });

    it('serializes payoff against another resolution and protects migration rollback after a global fact', async () => {
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
                    totalAmountInCents: 20000,
                })
                .expect(201)
        ).body.commitment;
        const ids = root.plan.installments.map(
            (item: { id: string }) => item.id,
        );
        const payoff = browser.post(`${base}/${root.id}/payoffs`, {
            paidAmountInCents: 19000,
            factDate: today,
            method: 'PIX',
            expectedCommitmentVersion: 1,
            installments: ids.map((installmentId: string) => ({
                installmentId,
                expectedInstallmentVersion: 1,
            })),
        });
        const cancel = browser.post(
            `${base}/${root.id}/future-installment-cancellations`,
            {
                expectedCommitmentVersion: 1,
                factDate: today,
                reason: 'Extinto',
                installments: [
                    { installmentId: ids[0], expectedInstallmentVersion: 1 },
                ],
            },
        );
        const outcomes = await Promise.all([payoff, cancel]);
        expect(outcomes.map((item) => item.status).sort()).toEqual([201, 409]);
        const count = (
            await db.query(
                'SELECT COUNT(*)::int AS n FROM financial_installment_resolutions WHERE commitment_id=$1',
                [root.id],
            )
        )[0].n;
        expect([1, 2]).toContain(count);
        await migrationSource.initialize();
        try {
            if (count === 1) {
                const current = (
                    await browser.agent.get(`${base}/${root.id}`).expect(200)
                ).body.commitment;
                const preview = (
                    await browser
                        .post(`${base}/${root.id}/payoff-preview`, {
                            paidAmountInCents: 9000,
                            factDate: today,
                        })
                        .expect(200)
                ).body;
                await browser
                    .post(`${base}/${root.id}/payoffs`, {
                        paidAmountInCents: 9000,
                        factDate: today,
                        method: 'PIX',
                        expectedCommitmentVersion: current.version,
                        installments: preview.items.map(
                            (item: {
                                installmentId: string;
                                expectedInstallmentVersion: number;
                            }) => ({
                                installmentId: item.installmentId,
                                expectedInstallmentVersion:
                                    item.expectedInstallmentVersion,
                            }),
                        ),
                    })
                    .expect(201);
            }
            await expect(migrationSource.undoLastMigration()).rejects.toThrow(
                'Cannot revert installment resolutions',
            );
            expect(
                (
                    await migrationSource.query(
                        'SELECT COUNT(*)::int AS n FROM financial_installment_payoffs WHERE commitment_id=$1',
                        [root.id],
                    )
                )[0].n,
            ).toBe(1);
        } finally {
            await migrationSource.destroy();
        }
    });

    it('reverses the empty schema and rolls back a payoff when audit persistence fails', async () => {
        await migrationSource.initialize();
        try {
            await migrationSource.undoLastMigration();
            expect(
                (
                    await migrationSource.query(
                        "SELECT to_regclass('financial_installment_payoffs') AS relation",
                    )
                )[0].relation,
            ).toBeNull();
            await migrationSource.runMigrations();
        } finally {
            await migrationSource.destroy();
        }
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/installment-commitments`;
        const root = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    description: 'Auditoria',
                    count: 1,
                    firstDueDate: '2026-11-20',
                    cadence: 'MONTHLY',
                    totalAmountInCents: 10000,
                })
                .expect(201)
        ).body.commitment;
        const command = {
            paidAmountInCents: 9000,
            factDate: today,
            method: 'PIX',
            expectedCommitmentVersion: 1,
            installments: [
                {
                    installmentId: root.plan.installments[0].id,
                    expectedInstallmentVersion: 1,
                },
            ],
        };
        await db.query(
            "ALTER TABLE financial_command_audit ADD CONSTRAINT test_card_029_audit_failure CHECK (action <> 'PAYOFF_INSTALLMENTS') NOT VALID",
        );
        try {
            await browser
                .post(`${base}/${root.id}/payoffs`, command)
                .expect(500);
            expect(
                (
                    await db.query(
                        'SELECT COUNT(*)::int AS n FROM financial_installment_payoffs WHERE commitment_id=$1',
                        [root.id],
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
                (await browser.agent.get(`${base}/${root.id}`).expect(200)).body
                    .commitment.version,
            ).toBe(1);
        } finally {
            await db.query(
                'ALTER TABLE financial_command_audit DROP CONSTRAINT test_card_029_audit_failure',
            );
        }
        expect(
            (
                await browser
                    .post(`${base}/${root.id}/payoffs`, command)
                    .expect(201)
            ).body.commitment.plan.status,
        ).toBe('COMPLETED');
    });

    it('keeps the Wave 04 journey congruent across avulso, recurrence, maintenance, anticipation and resolution', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = financeBase(space);
        const planned = (
            await browser
                .post(`${base}/planned-expenses`, {
                    scope: 'PERSONAL',
                    description: 'Avulsa',
                    amountInCents: 1000,
                    expectedPaymentDate: today,
                })
                .expect(201)
        ).body.commitment;
        await browser
            .post(`${base}/financial-commitments/${planned.id}/disbursements`, {
                expectedCommitmentVersion: 1,
                amountInCents: 1000,
                factDate: today,
                method: 'PIX',
            })
            .expect(201);
        const recurring = `${base}/recurring-commitments`;
        const fixed = (
            await browser
                .post(recurring, {
                    scope: 'PERSONAL',
                    kind: 'EXPENSE',
                    description: 'Fixa',
                    amountInCents: 2000,
                    recurrence: { frequency: 'MONTHLY', dayOfMonth: 14 },
                    startsOn: '2026-10-01',
                })
                .expect(201)
        ).body.commitment;
        await browser
            .post(
                `${recurring}/${fixed.id}/occurrences/${today}/disbursements`,
                {
                    expectedCommitmentVersion: 1,
                    expectedOccurrenceVersion: 1,
                    amountInCents: 2000,
                    factDate: today,
                    method: 'PIX',
                },
            )
            .expect(201);
        const changed = (
            await browser
                .post(`${recurring}/${fixed.id}/versions`, {
                    scope: 'PERSONAL',
                    kind: 'EXPENSE',
                    valueMode: 'FIXED',
                    description: 'Fixa reajustada',
                    amountInCents: 2500,
                    recurrence: { frequency: 'MONTHLY', dayOfMonth: 20 },
                    effectiveFrom: '2026-11-15',
                    expectedCommitmentVersion: 1,
                })
                .expect(201)
        ).body.commitment;
        expect(changed.economicVersion).toBe(2);
        const variable = (
            await browser
                .post(recurring, {
                    scope: 'PERSONAL',
                    kind: 'EXPENSE',
                    valueMode: 'VARIABLE',
                    description: 'Variável',
                    recurrence: { frequency: 'MONTHLY', dayOfMonth: 14 },
                    startsOn: '2026-10-01',
                    expectedAmountInCents: 2800,
                })
                .expect(201)
        ).body.commitment;
        await browser
            .put(`${recurring}/${variable.id}/occurrences/${today}/value`, {
                expectedCommitmentVersion: 1,
                expectedOccurrenceVersion: 1,
                amountInCents: 3000,
            })
            .expect(200);
        await browser
            .post(
                `${recurring}/${variable.id}/occurrences/${today}/disbursements`,
                {
                    expectedCommitmentVersion: 1,
                    expectedOccurrenceVersion: 2,
                    amountInCents: 3000,
                    factDate: today,
                    method: 'PIX',
                },
            )
            .expect(201);
        const installmentBase = `${base}/installment-commitments`;
        const plan = (
            await browser
                .post(installmentBase, {
                    scope: 'PERSONAL',
                    description: 'Parcelada',
                    count: 3,
                    firstDueDate: '2026-11-20',
                    cadence: 'MONTHLY',
                    totalAmountInCents: 3000,
                })
                .expect(201)
        ).body.commitment;
        const ids = plan.plan.installments.map(
            (item: { id: string }) => item.id,
        );
        await browser
            .post(`${installmentBase}/${plan.id}/anticipations`, {
                selection: { mode: 'IDS', installmentIds: [ids[2]] },
                values: [
                    {
                        installmentId: ids[2],
                        expectedInstallmentVersion: 1,
                        paidAmountInCents: 900,
                    },
                ],
                factDate: today,
                method: 'PIX',
                expectedCommitmentVersion: 1,
            })
            .expect(201);
        const payoffPreview = (
            await browser
                .post(`${installmentBase}/${plan.id}/payoff-preview`, {
                    paidAmountInCents: 1800,
                    factDate: today,
                })
                .expect(200)
        ).body;
        expect(payoffPreview.expectedRemainingAmountInCents).toBe(2000);
        await browser
            .post(`${installmentBase}/${plan.id}/payoffs`, {
                paidAmountInCents: 1800,
                factDate: today,
                method: 'PIX',
                expectedCommitmentVersion: 2,
                installments: payoffPreview.items.map(
                    (item: {
                        installmentId: string;
                        expectedInstallmentVersion: number;
                    }) => ({
                        installmentId: item.installmentId,
                        expectedInstallmentVersion:
                            item.expectedInstallmentVersion,
                    }),
                ),
            })
            .expect(201);
        const extinct = (
            await browser
                .post(installmentBase, {
                    scope: 'PERSONAL',
                    description: 'Extinta',
                    count: 1,
                    firstDueDate: '2026-11-25',
                    cadence: 'MONTHLY',
                    totalAmountInCents: 500,
                })
                .expect(201)
        ).body.commitment;
        await browser
            .post(
                `${installmentBase}/${extinct.id}/future-installment-cancellations`,
                {
                    installments: [
                        {
                            installmentId: extinct.plan.installments[0].id,
                            expectedInstallmentVersion: 1,
                        },
                    ],
                    reason: 'Contrato encerrado',
                    factDate: today,
                    expectedCommitmentVersion: 1,
                },
            )
            .expect(201);
        const overview = (
            await browser.agent
                .get(`${base}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        expect(overview.totals).toMatchObject({
            expenseAmountInCents: '8700',
            paidAmountInCents: '8700',
        });
        const forecast = (
            await browser.agent
                .get(`${base}/financial-forecast?month=2026-12`)
                .expect(200)
        ).body;
        expect(forecast.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    commitmentId: fixed.id,
                    amountInCents: 2500,
                }),
                expect.objectContaining({
                    commitmentId: variable.id,
                    amountInCents: null,
                }),
            ]),
        );
        expect(
            forecast.items.some(
                (item: { commitmentId: string }) =>
                    item.commitmentId === plan.id ||
                    item.commitmentId === extinct.id,
            ),
        ).toBe(false);
        const timeline = (
            await browser.agent
                .get(`${base}/financial-timeline?month=2026-10&view=HISTORY`)
                .expect(200)
        ).body;
        expect(
            timeline.items.map((item: { type: string }) => item.type),
        ).toEqual(
            expect.arrayContaining(['EXPENSE_PAYOFF', 'EXPENSE_CANCELLATION']),
        );
    });
});
