import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
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
    commitmentPath,
    competingFinanceCommands,
    financeBase,
    financeBrowser,
    financeSnapshot,
    rewindFinanceMigrationsTo,
    sharedFinance,
    type SharedFinance,
} from './settlement-fixture.js';

describe('CARD-031 explicit economic adjustments and cancellation without realization', () => {
    let app: INestApplication<Server>;
    let db: DataSource;
    const today = '2026-10-14';
    const instant = new Date('2026-10-14T15:00:00Z');

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

    const adjustment = (extra: object = {}) => ({
        expectedCommitmentVersion: 1,
        direction: 'INCREASE',
        amountInCents: 1700,
        reason: 'Encargo acordado',
        factDate: today,
        ...extra,
    });
    const cancellation = (extra: object = {}) => ({
        expectedCommitmentVersion: 1,
        reason: 'Planejamento cancelado',
        factDate: today,
        ...extra,
    });
    const split = (f: SharedFinance) => ({
        mode: 'PERCENTAGES',
        shares: [
            { memberId: f.ma, basisPoints: 6000 },
            { memberId: f.mb, basisPoints: 4000 },
        ],
    });
    const personalExpense = async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const root = (
            await browser
                .post(`${financeBase(space)}/planned-expenses`, {
                    scope: 'PERSONAL',
                    description: 'Compra prevista',
                    amountInCents: 50000,
                    expectedPaymentDate: '2026-10-20',
                })
                .expect(201)
        ).body.commitment;
        return { browser, space, root, path: commitmentPath(space, root.id) };
    };
    const sharedRoot = async (f: SharedFinance, kind: 'EXPENSE' | 'INCOME') =>
        (
            await f.a
                .post(
                    `${financeBase(f.space)}/${kind === 'EXPENSE' ? 'planned-expenses' : 'incomes'}`,
                    kind === 'EXPENSE'
                        ? {
                              scope: 'SHARED',
                              description: 'Despesa prevista',
                              amountInCents: 50000,
                              expectedPaymentDate: '2026-10-20',
                              expectedSpaceVersion: f.context.version,
                              expectedPayerMemberId: f.ma,
                              responsibilitySplit: split(f),
                          }
                        : {
                              description: 'Receita prevista',
                              amountInCents: 50000,
                              expectedReceiptDate: '2026-10-20',
                              expectedSpaceVersion: f.context.version,
                              expectedRecipientMemberId: f.ma,
                              participationSplit: split(f),
                              receipt: null,
                          },
                )
                .expect(201)
        ).body.commitment;
    const factCounts = async (id: string) =>
        (
            await db.query(
                `SELECT
            (SELECT COUNT(*) FROM financial_disbursements WHERE commitment_id=$1)::int AS disbursements,
            (SELECT COUNT(*) FROM financial_receipts WHERE commitment_id=$1)::int AS receipts,
            (SELECT COUNT(*) FROM financial_external_liabilities WHERE commitment_id=$1)::int AS liabilities,
            (SELECT COUNT(*) FROM inter_member_obligations WHERE commitment_id=$1)::int AS obligations`,
                [id],
            )
        )[0];

    it('adds 1700 to 50000 with explicit history while keeping cash facts absent and replay stable', async () => {
        const f = await personalExpense();
        const input = adjustment();
        const before = await financeSnapshot(db);
        const preview = (
            await f.browser
                .post(`${f.path}/adjustment-preview`, input)
                .expect(200)
        ).body;
        expect(preview).toMatchObject({
            amountInCents: 50000,
            proposedAmountInCents: 51700,
            requiresAcceptance: false,
        });
        expect(await financeSnapshot(db)).toEqual(before);
        const key = randomUUID();
        const result = (
            await f.browser
                .post(`${f.path}/adjustments`, input, key)
                .expect(201)
        ).body;
        expect(result.adjustment).toMatchObject({
            direction: 'INCREASE',
            amountInCents: 1700,
            reason: input.reason,
            previousAmountInCents: 50000,
            resultingAmountInCents: 51700,
        });
        expect(await factCounts(f.root.id)).toEqual({
            disbursements: 0,
            receipts: 0,
            liabilities: 0,
            obligations: 0,
        });
        const written = await financeSnapshot(db);
        expect(
            (
                await f.browser
                    .post(`${f.path}/adjustments`, input, key)
                    .expect(200)
            ).body.replayed,
        ).toBe(true);
        expect(await financeSnapshot(db)).toEqual(written);
        await f.browser
            .post(
                `${f.path}/adjustments`,
                { ...input, amountInCents: 1800 },
                key,
            )
            .expect(409);
        const forecast = (
            await f.browser.agent
                .get(`${financeBase(f.space)}/financial-forecast?month=2026-10`)
                .expect(200)
        ).body;
        expect(forecast.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    commitmentId: f.root.id,
                    amountInCents: 51700,
                }),
            ]),
        );
        expect(
            (await f.browser.agent.get(f.path).expect(200)).body.commitment,
        ).toMatchObject({ amountInCents: 51700 });
    });

    it('keeps September recognition intact and recognizes only the October surcharge on its own date', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = financeBase(space);
        const root = (
            await browser
                .post(`${base}/planned-expenses`, {
                    scope: 'PERSONAL',
                    description: 'Despesa reconhecida em setembro',
                    amountInCents: 50000,
                    expectedPaymentDate: '2026-09-20',
                })
                .expect(201)
        ).body.commitment;
        const path = commitmentPath(space, root.id);
        const paid = (
            await browser
                .post(`${path}/disbursements`, {
                    expectedCommitmentVersion: 1,
                    amountInCents: 10000,
                    factDate: '2026-09-20',
                    method: 'PIX',
                })
                .expect(201)
        ).body;
        const septemberPath = `${base}/financial-overview?month=2026-09`;
        const beforeSeptember = (
            await browser.agent.get(septemberPath).expect(200)
        ).body;
        expect(beforeSeptember.totals).toMatchObject({
            expenseAmountInCents: '50000',
            paidAmountInCents: '10000',
        });
        const input = adjustment({
            expectedCommitmentVersion: paid.commitment.version,
            reason: 'Encargo de outubro acordado posteriormente',
        });
        const changed = (
            await browser.post(`${path}/adjustments`, input).expect(201)
        ).body;
        const september = (await browser.agent.get(septemberPath).expect(200))
            .body;
        expect(september.totals).toEqual(beforeSeptember.totals);
        const october = (
            await browser.agent
                .get(`${base}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        expect(october.totals).toMatchObject({
            expenseAmountInCents: '1700',
            paidAmountInCents: '0',
            receivedAmountInCents: '0',
            disbursedAmountInCents: '0',
        });
        const timeline = (
            await browser.agent
                .get(`${base}/financial-timeline?month=2026-10&view=HISTORY`)
                .expect(200)
        ).body;
        expect(timeline.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: changed.adjustment.id,
                    commitmentId: root.id,
                    type: 'EXPENSE_SURCHARGE',
                    amountInCents: 1700,
                    relevantDate: today,
                    reason: input.reason,
                    dateNature: 'ACTUAL',
                    recordedByPersonId: browser.context.person.id,
                }),
            ]),
        );
        expect(
            timeline.items.some(
                (item: { commitmentId: string; type: string }) =>
                    item.commitmentId === root.id && item.type === 'EXPENSE',
            ),
        ).toBe(false);
        const detail = (await browser.agent.get(path).expect(200)).body;
        expect(detail).toMatchObject({
            originalAmountInCents: 50000,
            commitment: {
                amountInCents: 51700,
                factDate: null,
                expectedPaymentDate: '2026-09-20',
            },
            paidAmountInCents: 10000,
            remainingAmountInCents: 41700,
        });
        expect(detail.adjustments).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: changed.adjustment.id,
                    amountInCents: 1700,
                    reason: input.reason,
                    factDate: today,
                }),
            ]),
        );
        expect(await factCounts(root.id)).toEqual({
            disbursements: 1,
            receipts: 0,
            liabilities: 0,
            obligations: 0,
        });
    });

    it('records discounts and personal income corrections without manufacturing receipts', async () => {
        const f = await personalExpense();
        const discount = (
            await f.browser
                .post(
                    `${f.path}/adjustments`,
                    adjustment({
                        direction: 'DECREASE',
                        amountInCents: 5000,
                        reason: 'Desconto comercial',
                    }),
                )
                .expect(201)
        ).body;
        expect(discount.adjustment).toMatchObject({
            previousAmountInCents: 50000,
            resultingAmountInCents: 45000,
        });
        const income = (
            await f.browser
                .post(`${financeBase(f.space)}/incomes`, {
                    description: 'Receita prevista',
                    amountInCents: 50000,
                    expectedReceiptDate: '2026-10-20',
                    receipt: null,
                })
                .expect(201)
        ).body.commitment;
        const path = commitmentPath(f.space, income.id);
        const increased = (
            await f.browser
                .post(`${path}/adjustments`, adjustment())
                .expect(201)
        ).body;
        expect(increased.adjustment.resultingAmountInCents).toBe(51700);
        const decreased = (
            await f.browser
                .post(
                    `${path}/adjustments`,
                    adjustment({
                        expectedCommitmentVersion: increased.version,
                        direction: 'DECREASE',
                        amountInCents: 2000,
                        reason: 'Correção do valor esperado',
                    }),
                )
                .expect(201)
        ).body;
        expect(decreased.adjustment.resultingAmountInCents).toBe(49700);
        expect(await factCounts(income.id)).toEqual({
            disbursements: 0,
            receipts: 0,
            liabilities: 0,
            obligations: 0,
        });
    });

    it('allows a full personal discount down to zero while preserving the original and adjustment history', async () => {
        const f = await personalExpense();
        const input = adjustment({
            direction: 'DECREASE',
            amountInCents: 50000,
            reason: 'Abatimento integral',
        });
        const preview = (
            await f.browser
                .post(`${f.path}/adjustment-preview`, input)
                .expect(200)
        ).body;
        expect(preview).toMatchObject({
            originalAmountInCents: 50000,
            amountInCents: 50000,
            proposedAmountInCents: 0,
        });
        const result = (
            await f.browser.post(`${f.path}/adjustments`, input).expect(201)
        ).body;
        expect(result.adjustment).toMatchObject({
            previousAmountInCents: 50000,
            resultingAmountInCents: 0,
            reason: input.reason,
        });
        expect(
            (await f.browser.agent.get(f.path).expect(200)).body.commitment
                .amountInCents,
        ).toBe(0);
        const history = await db.query(
            'SELECT amount_in_cents::text AS amount FROM financial_commitment_versions WHERE commitment_id=$1 AND version=1',
            [f.root.id],
        );
        expect(history).toMatchObject([{ amount: '50000' }]);
        expect(
            (
                await db.query(
                    'SELECT COUNT(*)::int AS n FROM financial_commitment_adjustments WHERE commitment_id=$1',
                    [f.root.id],
                )
            )[0].n,
        ).toBe(1);
        expect(await factCounts(f.root.id)).toEqual({
            disbursements: 0,
            receipts: 0,
            liabilities: 0,
            obligations: 0,
        });
    });

    it('applies a shared onerous adjustment only after recipient acceptance and preserves rejected proposals', async () => {
        const f = await sharedFinance(app);
        for (const kind of ['EXPENSE', 'INCOME'] as const) {
            const root = await sharedRoot(f, kind);
            const path = commitmentPath(f.space, root.id);
            const input = adjustment({
                expectedSpaceVersion: f.context.version,
                direction: kind === 'EXPENSE' ? 'INCREASE' : 'DECREASE',
            });
            const pending = (
                await f.a.post(`${path}/adjustments`, input).expect(201)
            ).body;
            expect(pending.proposal).toMatchObject({
                status: 'PROPOSED',
                recipientMemberId: f.mb,
            });
            expect(await factCounts(root.id)).toEqual({
                disbursements: 0,
                receipts: 0,
                liabilities: 0,
                obligations: 0,
            });
            expect(
                (
                    await db.query(
                        'SELECT COUNT(*)::int AS n FROM financial_commitment_adjustments WHERE commitment_id=$1',
                        [root.id],
                    )
                )[0].n,
            ).toBe(0);
            const decision = {
                expectedProposalVersion: 1,
                expectedCommitmentVersion: 1,
                expectedSpaceVersion: f.context.version,
            };
            await f.a
                .post(
                    `${path}/change-proposals/${pending.proposal.id}/acceptance`,
                    decision,
                )
                .expect(403);
            await f.b
                .post(
                    `${path}/change-proposals/${pending.proposal.id}/rejection`,
                    decision,
                )
                .expect(201);
            expect(
                (
                    await db.query(
                        'SELECT COUNT(*)::int AS n FROM financial_commitment_adjustments WHERE commitment_id=$1',
                        [root.id],
                    )
                )[0].n,
            ).toBe(0);
            const next = (
                await f.a.post(`${path}/adjustments`, input).expect(201)
            ).body;
            const key = randomUUID();
            const acceptancePath = `${path}/change-proposals/${next.proposal.id}/acceptance`;
            if (kind === 'EXPENSE') {
                const beforeFailure = await financeSnapshot(db);
                await db.query(
                    'ALTER TABLE financial_command_audit ADD CONSTRAINT test_card_031_acceptance_audit_failure CHECK (false) NOT VALID',
                );
                try {
                    await f.b.post(acceptancePath, decision, key).expect(500);
                    expect(await financeSnapshot(db)).toEqual(beforeFailure);
                } finally {
                    await db.query(
                        'ALTER TABLE financial_command_audit DROP CONSTRAINT test_card_031_acceptance_audit_failure',
                    );
                }
            }
            const accepted = (
                await f.b.post(acceptancePath, decision, key).expect(201)
            ).body;
            expect(accepted.proposal.status).toBe('ACCEPTED');
            expect(accepted.adjustment.resultingAmountInCents).toBe(
                kind === 'EXPENSE' ? 51700 : 48300,
            );
            const beforeReplay = await financeSnapshot(db);
            await f.b.post(acceptancePath, decision, key).expect(200);
            expect(await financeSnapshot(db)).toEqual(beforeReplay);
            expect(
                (
                    await db.query(
                        'SELECT COUNT(*)::int AS n FROM financial_commitment_adjustments WHERE commitment_id=$1',
                        [root.id],
                    )
                )[0].n,
            ).toBe(1);
        }
    });

    it('blocks a reduction below realized value and applies nothing on stale or invalid input', async () => {
        const f = await personalExpense();
        const paid = (
            await f.browser
                .post(`${f.path}/disbursements`, {
                    expectedCommitmentVersion: 1,
                    amountInCents: 20000,
                    factDate: today,
                    method: 'PIX',
                })
                .expect(201)
        ).body;
        const before = await financeSnapshot(db);
        await f.browser
            .post(
                `${f.path}/adjustments`,
                adjustment({
                    expectedCommitmentVersion: paid.commitment.version,
                    direction: 'DECREASE',
                    amountInCents: 40000,
                }),
            )
            .expect(409);
        await f.browser
            .post(
                `${f.path}/adjustments`,
                adjustment({ expectedCommitmentVersion: 999 }),
            )
            .expect(409);
        await f.browser
            .post(
                `${f.path}/adjustments`,
                adjustment({
                    expectedCommitmentVersion: paid.commitment.version,
                    direction: 'DECREASE',
                    amountInCents: 60000,
                }),
            )
            .expect(400);
        await f.browser
            .post(`${f.path}/adjustments`, adjustment({ amountInCents: 0 }))
            .expect(400);
        await f.browser
            .post(`${f.path}/adjustments`, adjustment({ reason: ' ' }))
            .expect(400);
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('adjusts one recurring occurrence or installment while preserving the other targets and cash facts', async () => {
        const f = await personalExpense();
        const base = financeBase(f.space);
        const recurring = (
            await f.browser
                .post(`${base}/recurring-commitments`, {
                    scope: 'PERSONAL',
                    kind: 'EXPENSE',
                    description: 'Mensalidade',
                    amountInCents: 50000,
                    recurrence: { frequency: 'MONTHLY', dayOfMonth: 20 },
                    startsOn: '2026-10-01',
                })
                .expect(201)
        ).body.commitment;
        const recurrence = `${base}/recurring-commitments/${recurring.id}`;
        const before = await financeSnapshot(db);
        await f.browser
            .post(
                `${commitmentPath(f.space, recurring.id)}/adjustments`,
                adjustment({ referenceDate: '2026-10-20' }),
            )
            .expect(400);
        expect(await financeSnapshot(db)).toEqual(before);
        const changed = (
            await f.browser
                .post(
                    `${commitmentPath(f.space, recurring.id)}/adjustments`,
                    adjustment({
                        referenceDate: '2026-10-20',
                        expectedOccurrenceVersion: 1,
                    }),
                )
                .expect(201)
        ).body;
        expect(changed.adjustment.resultingAmountInCents).toBe(51700);
        expect(
            (
                await f.browser.agent
                    .get(`${recurrence}/occurrences?month=2026-10`)
                    .expect(200)
            ).body.items[0].amountInCents,
        ).toBe(51700);
        expect(
            (
                await f.browser.agent
                    .get(`${recurrence}/occurrences?month=2026-11`)
                    .expect(200)
            ).body.items[0].amountInCents,
        ).toBe(50000);
        const installments = `${base}/installment-commitments`;
        const plan = (
            await f.browser
                .post(installments, {
                    scope: 'PERSONAL',
                    description: 'Compra em parcelas',
                    count: 2,
                    explicitDueDates: ['2026-10-20', '2026-11-20'],
                    amountsInCents: [50000, 50000],
                })
                .expect(201)
        ).body.commitment;
        await f.browser
            .post(
                `${commitmentPath(f.space, plan.id)}/adjustments`,
                adjustment({
                    installmentId: plan.plan.installments[1].id,
                    expectedOccurrenceVersion: 1,
                }),
            )
            .expect(201);
        const parcels = (
            await f.browser.agent
                .get(`${installments}/${plan.id}/installments`)
                .expect(200)
        ).body.items;
        expect(
            parcels.map(
                (item: { amountInCents: number }) => item.amountInCents,
            ),
        ).toEqual([50000, 51700]);
        expect(await factCounts(plan.id)).toEqual({
            disbursements: 0,
            receipts: 0,
            liabilities: 0,
            obligations: 0,
        });
    });

    it('cancels personal and shared pending expense and income while blocking later realization', async () => {
        const f = await sharedFinance(app);
        const personal = await financeBrowser(app);
        const personalSpace = personal.context.personalSpace.id as string;
        for (const shared of [false, true]) {
            for (const kind of ['EXPENSE', 'INCOME'] as const) {
                const browser = shared ? f.a : personal;
                const space = shared ? f.space : personalSpace;
                const root = shared
                    ? await sharedRoot(f, kind)
                    : (
                          await browser
                              .post(
                                  `${financeBase(space)}/${kind === 'EXPENSE' ? 'planned-expenses' : 'incomes'}`,
                                  kind === 'EXPENSE'
                                      ? {
                                            scope: 'PERSONAL',
                                            description: 'Cancelar despesa',
                                            amountInCents: 50000,
                                            expectedPaymentDate: '2026-10-20',
                                        }
                                      : {
                                            description: 'Cancelar receita',
                                            amountInCents: 50000,
                                            expectedReceiptDate: '2026-10-20',
                                            receipt: null,
                                        },
                              )
                              .expect(201)
                      ).body.commitment;
                const path = commitmentPath(space, root.id);
                const input = cancellation(
                    shared ? { expectedSpaceVersion: f.context.version } : {},
                );
                const before = await financeSnapshot(db);
                const preview = (
                    await browser
                        .post(`${path}/cancellation-preview`, input)
                        .expect(200)
                ).body;
                expect(preview).toMatchObject({
                    eligible: true,
                    fulfilledAmountInCents: 0,
                });
                expect(await financeSnapshot(db)).toEqual(before);
                const key = randomUUID();
                const cancelled = (
                    await browser
                        .post(`${path}/cancellations`, input, key)
                        .expect(201)
                ).body;
                expect(cancelled.status).toBe('CANCELLED');
                expect(cancelled.cancellation).toMatchObject({
                    reason: input.reason,
                    factDate: today,
                });
                const timeline = (
                    await browser.agent
                        .get(
                            `${financeBase(space)}/financial-timeline?month=2026-10&view=HISTORY`,
                        )
                        .expect(200)
                ).body;
                expect(timeline.items).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({
                            id: cancelled.cancellation.id,
                            commitmentId: root.id,
                            type:
                                kind === 'EXPENSE'
                                    ? 'EXPENSE_CANCELLATION'
                                    : 'INCOME_CANCELLATION',
                            reason: input.reason,
                            relevantDate: today,
                        }),
                    ]),
                );
                const written = await financeSnapshot(db);
                expect(
                    (
                        await browser
                            .post(`${path}/cancellations`, input, key)
                            .expect(200)
                    ).body.replayed,
                ).toBe(true);
                expect(await financeSnapshot(db)).toEqual(written);
                await browser
                    .post(
                        `${path}/${kind === 'EXPENSE' ? 'disbursements' : 'receipts'}`,
                        {
                            expectedCommitmentVersion: cancelled.version,
                            amountInCents: 1000,
                            factDate: today,
                            ...(kind === 'EXPENSE' ? { method: 'PIX' } : {}),
                            ...(shared
                                ? {
                                      expectedSpaceVersion: f.context.version,
                                      settlement: { mode: 'NONE' },
                                      ...(kind === 'EXPENSE'
                                          ? { payerMemberId: f.ma }
                                          : { recipientMemberId: f.ma }),
                                  }
                                : {}),
                        },
                    )
                    .expect(409);
                expect(await financeSnapshot(db)).toEqual(written);
                expect(await factCounts(root.id)).toEqual({
                    disbursements: 0,
                    receipts: 0,
                    liabilities: 0,
                    obligations: 0,
                });
            }
        }
    });

    it('serializes cancellation against realization and rejects cancellation once a fact exists', async () => {
        const f = await sharedFinance(app);
        const root = await sharedRoot(f, 'EXPENSE');
        const path = commitmentPath(f.space, root.id);
        const outcomes = await competingFinanceCommands(db, f.space, () =>
            Promise.all([
                f.a.post(
                    `${path}/cancellations`,
                    cancellation({ expectedSpaceVersion: f.context.version }),
                ),
                f.a.post(`${path}/disbursements`, {
                    expectedCommitmentVersion: 1,
                    expectedSpaceVersion: f.context.version,
                    payerMemberId: f.ma,
                    amountInCents: 1000,
                    factDate: today,
                    method: 'PIX',
                    settlement: { mode: 'NONE' },
                }),
            ]),
        );
        expect(outcomes.map((response) => response.status).sort()).toEqual([
            201, 409,
        ]);
        const counts = await factCounts(root.id);
        const cancellations = (
            await db.query(
                'SELECT COUNT(*)::int AS n FROM financial_commitment_cancellations WHERE commitment_id=$1',
                [root.id],
            )
        )[0].n;
        expect(counts.disbursements + cancellations).toBe(1);
        const realized = await personalExpense();
        const paid = (
            await realized.browser
                .post(`${realized.path}/disbursements`, {
                    expectedCommitmentVersion: 1,
                    amountInCents: 1000,
                    factDate: today,
                    method: 'PIX',
                })
                .expect(201)
        ).body;
        const before = await financeSnapshot(db);
        await realized.browser
            .post(
                `${realized.path}/cancellations`,
                cancellation({
                    expectedCommitmentVersion: paid.commitment.version,
                }),
            )
            .expect(409);
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('rolls back adjustments and cancellation when audit persistence fails', async () => {
        const f = await personalExpense();
        const before = await financeSnapshot(db);
        await db.query(
            'ALTER TABLE financial_command_audit ADD CONSTRAINT test_card_031_audit_failure CHECK (false) NOT VALID',
        );
        try {
            await f.browser
                .post(`${f.path}/adjustments`, adjustment())
                .expect(500);
            expect(await financeSnapshot(db)).toEqual(before);
            await f.browser
                .post(`${f.path}/cancellations`, cancellation())
                .expect(500);
            expect(await financeSnapshot(db)).toEqual(before);
        } finally {
            await db.query(
                'ALTER TABLE financial_command_audit DROP CONSTRAINT test_card_031_audit_failure',
            );
        }
        expect(
            (
                await f.browser
                    .post(`${f.path}/adjustments`, adjustment())
                    .expect(201)
            ).body.adjustment.resultingAmountInCents,
        ).toBe(51700);
    });

    it('reapplies the empty migration and protects correction history against destructive rollback', async () => {
        await migrationSource.initialize();
        try {
            await rewindFinanceMigrationsTo(
                migrationSource,
                'FinancialCorrections1792251398684',
            );
            await migrationSource.undoLastMigration();
            for (const table of [
                'financial_commitment_adjustments',
                'financial_commitment_cancellations',
            ])
                expect(
                    (
                        await migrationSource.query(
                            'SELECT to_regclass($1) AS relation',
                            [table],
                        )
                    )[0].relation,
                ).toBeNull();
            await migrationSource.runMigrations();
            for (const table of [
                'financial_commitment_adjustments',
                'financial_commitment_cancellations',
            ])
                expect(
                    (
                        await migrationSource.query(
                            'SELECT to_regclass($1) AS relation',
                            [table],
                        )
                    )[0].relation,
                ).toBe(table);
            const f = await personalExpense();
            const adjusted = (
                await f.browser
                    .post(`${f.path}/adjustments`, adjustment())
                    .expect(201)
            ).body;
            await rewindFinanceMigrationsTo(
                migrationSource,
                'FinancialCorrections1792251398684',
            );
            const before = await financeSnapshot(db);
            await expect(migrationSource.undoLastMigration()).rejects.toThrow();
            expect(await financeSnapshot(db)).toEqual(before);
            expect(
                (
                    await db.query(
                        'SELECT id FROM financial_commitment_adjustments WHERE commitment_id=$1',
                        [f.root.id],
                    )
                )[0].id,
            ).toBe(adjusted.adjustment.id);
        } finally {
            await migrationSource.runMigrations();
            await migrationSource.destroy();
        }
    });
});
