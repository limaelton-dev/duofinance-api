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
    sharedExpenseInput,
    sharedFinance,
    type SharedFinance,
} from './settlement-fixture.js';

describe('CARD-032 compensating financial reversals preserve original facts', () => {
    let app: INestApplication<Server>;
    let db: DataSource;
    let today: string;

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
        today = '2026-10-14';
        const module = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(FINANCES_CLOCK)
            .useValue({
                now: () => new Date(`${today}T15:00:00Z`),
                today: () => today,
            })
            .overrideProvider(TODAY_CLOCK)
            .useValue({ now: () => new Date(`${today}T15:00:00Z`) })
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

    const reversal = (
        id: string,
        amountInCents: number,
        extra: object = {},
    ) => ({
        originalKind: 'DISBURSEMENT',
        originalId: id,
        amountInCents,
        expectedCommitmentVersion: 1,
        reason: 'Correção do lançamento',
        factDate: today,
        ...extra,
    });
    const personal = async (amountInCents = 50000) => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const created = (
            await browser
                .post(`${financeBase(space)}/personal-expenses`, {
                    description: 'Pagamento a corrigir',
                    amountInCents,
                    factDate: today,
                    disbursement: { method: 'PIX' },
                })
                .expect(201)
        ).body;
        const [fact]: { id: string }[] = await db.query(
            'SELECT id FROM financial_disbursements WHERE commitment_id=$1',
            [created.commitment.id],
        );
        return {
            browser,
            space,
            root: created.commitment,
            fact,
            path: commitmentPath(space, created.commitment.id),
        };
    };
    const openObligations = (id: string) =>
        db.query(
            'SELECT * FROM inter_member_obligations WHERE commitment_id=$1 AND remaining_amount_in_cents>0 ORDER BY id',
            [id],
        );
    const transfer = async (
        f: SharedFinance,
        id: string,
        amountInCents: number,
    ) => {
        const [o] = await openObligations(id);
        return (
            await f.a
                .post(`${financeBase(f.space)}/settlement-transfers`, {
                    expectedSpaceVersion: f.context.version,
                    payerMemberId: o.debtor_member_id,
                    recipientMemberId: o.creditor_member_id,
                    amountInCents,
                    factDate: today,
                    allocations: [
                        {
                            obligationId: o.id,
                            expectedObligationVersion: o.version,
                            amountInCents,
                        },
                    ],
                })
                .expect(201)
        ).body;
    };
    const details = async (
        browser: Awaited<ReturnType<typeof financeBrowser>>,
        path: string,
    ) => (await browser.agent.get(path).expect(200)).body;

    it('previews without writes and reverses partially with stable replay, bounded totals and unchanged originals', async () => {
        const f = await personal();
        const original = await db.query(
            'SELECT * FROM financial_disbursements WHERE id=$1',
            [f.fact.id],
        );
        const input = reversal(f.fact.id, 20000);
        const before = await financeSnapshot(db);
        const preview = (
            await f.browser
                .post(`${f.path}/reversal-preview`, input)
                .expect(200)
        ).body;
        expect(preview.original).toMatchObject({
            id: f.fact.id,
            amountInCents: 50000,
            reversibleAmountInCents: 50000,
        });
        expect(preview).toMatchObject({
            eligible: true,
            blockingReason: null,
            cashImpactInCents: '20000',
            supportedImpactInCents: '-20000',
            externalOutstandingImpactInCents: '0',
        });
        expect(await financeSnapshot(db)).toEqual(before);
        const key = randomUUID();
        const created = (
            await f.browser.post(`${f.path}/reversals`, input, key).expect(201)
        ).body;
        expect(created.reversal).toMatchObject({
            originalId: f.fact.id,
            originalKind: 'DISBURSEMENT',
            amountInCents: 20000,
            reason: input.reason,
            factDate: today,
        });
        expect(await details(f.browser, f.path)).toMatchObject({
            paidAmountInCents: 30000,
            supportedAmountInCents: 30000,
            remainingAmountInCents: 20000,
        });
        const written = await financeSnapshot(db);
        expect(
            (
                await f.browser
                    .post(`${f.path}/reversals`, input, key)
                    .expect(200)
            ).body,
        ).toEqual({ ...created, replayed: true });
        await f.browser
            .post(
                `${f.path}/reversals`,
                { ...input, amountInCents: 20001 },
                key,
            )
            .expect(409);
        await f.browser
            .post(
                `${f.path}/reversals`,
                reversal(f.fact.id, 30001, {
                    expectedCommitmentVersion: created.version,
                }),
            )
            .expect(409);
        expect(await financeSnapshot(db)).toEqual(written);
        const full = (
            await f.browser
                .post(
                    `${f.path}/reversals`,
                    reversal(f.fact.id, 30000, {
                        expectedCommitmentVersion: created.version,
                    }),
                )
                .expect(201)
        ).body;
        await f.browser
            .post(
                `${f.path}/reversals`,
                reversal(f.fact.id, 1, {
                    expectedCommitmentVersion: full.version,
                }),
            )
            .expect(409);
        expect(
            await db.query(
                'SELECT * FROM financial_disbursements WHERE id=$1',
                [f.fact.id],
            ),
        ).toEqual(original);
        const detail = await details(f.browser, f.path);
        expect(detail).toMatchObject({
            paidAmountInCents: 0,
            supportedAmountInCents: 0,
            remainingAmountInCents: 50000,
        });
        expect(detail.disbursements).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: f.fact.id,
                    amountInCents: 50000,
                }),
            ]),
        );
        const history = (
            await f.browser.agent.get(`${f.path}/reversals`).expect(200)
        ).body;
        expect(history.items).toHaveLength(2);
        expect(history.nextCursor).toBeNull();
    });

    it('allows a new payment after a full reversal without losing or shrinking the original', async () => {
        const f = await personal();
        const reversed = (
            await f.browser
                .post(`${f.path}/reversals`, reversal(f.fact.id, 50000))
                .expect(201)
        ).body;
        await f.browser
            .post(`${f.path}/disbursements`, {
                expectedCommitmentVersion: reversed.version,
                amountInCents: 50000,
                method: 'CASH',
                factDate: today,
            })
            .expect(201);
        const detail = await details(f.browser, f.path);
        expect(detail).toMatchObject({
            paidAmountInCents: 50000,
            remainingAmountInCents: 0,
        });
        expect(detail.disbursements).toHaveLength(2);
        expect(
            (
                await db.query(
                    'SELECT SUM(amount_in_cents)::text AS amount FROM financial_disbursements WHERE commitment_id=$1',
                    [f.root.id],
                )
            )[0].amount,
        ).toBe('100000');
    });

    it.each([0, 20000])(
        'reconciles expense support after preserving an existing internal transfer of %s',
        async (transferred) => {
            const f = await sharedFinance(app);
            const created = (
                await f.a
                    .post(
                        `${financeBase(f.space)}/shared-cash-expenses`,
                        sharedExpenseInput(f),
                    )
                    .expect(201)
            ).body;
            const id = created.commitment.id as string;
            const [fact] = await db.query(
                'SELECT id FROM financial_disbursements WHERE commitment_id=$1',
                [id],
            );
            if (transferred) await transfer(f, id, transferred);
            const transfers = await db.query(
                'SELECT * FROM settlement_transfers ORDER BY id',
            );
            await f.a
                .post(
                    `${commitmentPath(f.space, id)}/reversals`,
                    reversal(fact.id, 50000, {
                        expectedSpaceVersion: f.context.version,
                    }),
                )
                .expect(201);
            expect(
                await db.query(
                    'SELECT * FROM settlement_transfers ORDER BY id',
                ),
            ).toEqual(transfers);
            const open = await openObligations(id);
            if (!transferred) expect(open).toHaveLength(0);
            else
                expect(open).toMatchObject([
                    {
                        debtor_member_id: f.ma,
                        creditor_member_id: f.mb,
                        remaining_amount_in_cents: '20000',
                    },
                ]);
            expect(
                await details(f.a, commitmentPath(f.space, id)),
            ).toMatchObject({
                supportedAmountInCents: 0,
                remainingAmountInCents: 50000,
            });
        },
    );

    it('reverses all received income while preserving the repasse and creating its return obligation', async () => {
        const f = await sharedFinance(app);
        const created = (
            await f.a
                .post(`${financeBase(f.space)}/incomes`, {
                    description: 'Receita compartilhada',
                    amountInCents: 100000,
                    expectedReceiptDate: today,
                    expectedSpaceVersion: f.context.version,
                    expectedRecipientMemberId: f.ma,
                    participationSplit: {
                        mode: 'PERCENTAGES',
                        shares: [
                            { memberId: f.ma, basisPoints: 6000 },
                            { memberId: f.mb, basisPoints: 4000 },
                        ],
                    },
                    receipt: {
                        amountInCents: 100000,
                        factDate: today,
                        recipientMemberId: f.ma,
                        settlement: { mode: 'NONE' },
                    },
                })
                .expect(201)
        ).body;
        const id = created.commitment.id as string;
        const [fact] = await db.query(
            'SELECT id FROM financial_receipts WHERE commitment_id=$1',
            [id],
        );
        await transfer(f, id, 40000);
        const original = await db.query(
            'SELECT * FROM financial_receipts WHERE commitment_id=$1',
            [id],
        );
        const transfers = await db.query(
            'SELECT * FROM settlement_transfers ORDER BY id',
        );
        await f.a
            .post(
                `${commitmentPath(f.space, id)}/reversals`,
                reversal(fact.id, 100000, {
                    originalKind: 'RECEIPT',
                    expectedCommitmentVersion: created.commitment.version,
                    expectedSpaceVersion: f.context.version,
                }),
            )
            .expect(201);
        expect(
            await db.query(
                'SELECT * FROM financial_receipts WHERE commitment_id=$1',
                [id],
            ),
        ).toEqual(original);
        expect(
            await db.query('SELECT * FROM settlement_transfers ORDER BY id'),
        ).toEqual(transfers);
        expect(await openObligations(id)).toMatchObject([
            {
                debtor_member_id: f.mb,
                creditor_member_id: f.ma,
                remaining_amount_in_cents: '40000',
            },
        ]);
        expect(await details(f.a, commitmentPath(f.space, id))).toMatchObject({
            receivedAmountInCents: 0,
            remainingAmountInCents: 100000,
        });
    });

    it('requires reversing external settlements before principal and preserves holder authorization and cash isolation', async () => {
        const f = await sharedFinance(app);
        const created = (
            await f.a
                .post(`${financeBase(f.space)}/credit-card-purchases`, {
                    description: 'Compra externa',
                    amountInCents: 50000,
                    factDate: today,
                    expectedSpaceVersion: f.context.version,
                    externalLiability: {
                        amountInCents: 50000,
                        holderMemberId: f.ma,
                    },
                    responsibilitySplit: {
                        mode: 'AMOUNTS',
                        shares: [
                            { memberId: f.ma, amountInCents: 30000 },
                            { memberId: f.mb, amountInCents: 20000 },
                        ],
                    },
                    settlement: { mode: 'NONE' },
                })
                .expect(201)
        ).body;
        const path = commitmentPath(f.space, created.commitment.id);
        const liabilityId = created.externalLiability.id as string;
        const settled = (
            await f.a
                .post(
                    `${path}/external-liabilities/${liabilityId}/settlements`,
                    {
                        expectedCommitmentVersion: 1,
                        expectedSpaceVersion: f.context.version,
                        amountInCents: 20000,
                        factDate: today,
                    },
                )
                .expect(201)
        ).body;
        const originals = await db.query(
            'SELECT * FROM financial_external_liability_settlements WHERE commitment_id=$1',
            [created.commitment.id],
        );
        const before = await financeSnapshot(db);
        const blocked = (
            await f.a
                .post(
                    `${path}/reversal-preview`,
                    reversal(liabilityId, 50000, {
                        originalKind: 'EXTERNAL_LIABILITY',
                        expectedCommitmentVersion: 2,
                        expectedSpaceVersion: f.context.version,
                    }),
                )
                .expect(200)
        ).body;
        expect(blocked).toMatchObject({
            eligible: false,
            blockingReason: 'FINANCIAL_REVERSAL_SETTLEMENT_REQUIRED',
        });
        await f.a
            .post(
                `${path}/reversals`,
                reversal(liabilityId, 50000, {
                    originalKind: 'EXTERNAL_LIABILITY',
                    expectedCommitmentVersion: 2,
                    expectedSpaceVersion: f.context.version,
                }),
            )
            .expect(409);
        const input = reversal(settled.settlement.id, 20000, {
            originalKind: 'EXTERNAL_SETTLEMENT',
            expectedCommitmentVersion: 2,
            expectedSpaceVersion: f.context.version,
        });
        await f.b.post(`${path}/reversals`, input).expect(403);
        expect(await financeSnapshot(db)).toEqual(before);
        const settlementPreview = (
            await f.a.post(`${path}/reversal-preview`, input).expect(200)
        ).body;
        expect(settlementPreview).toMatchObject({
            eligible: true,
            cashImpactInCents: '20000',
            supportedImpactInCents: '0',
            externalOutstandingImpactInCents: '20000',
        });
        expect(await financeSnapshot(db)).toEqual(before);
        const reversed = (
            await f.a.post(`${path}/reversals`, input).expect(201)
        ).body;
        expect(await details(f.a, path)).toMatchObject({
            supportedAmountInCents: 50000,
            externalSettledAmountInCents: 0,
            externalOutstandingAmountInCents: 50000,
        });
        expect(
            await db.query(
                'SELECT * FROM financial_external_liability_settlements WHERE commitment_id=$1',
                [created.commitment.id],
            ),
        ).toEqual(originals);
        await f.a
            .post(
                `${path}/reversals`,
                reversal(liabilityId, 50000, {
                    originalKind: 'EXTERNAL_LIABILITY',
                    expectedCommitmentVersion: reversed.version,
                    expectedSpaceVersion: f.context.version,
                }),
            )
            .expect(201);
        expect(await details(f.a, path)).toMatchObject({
            supportedAmountInCents: 0,
            externalOutstandingAmountInCents: 0,
            remainingAmountInCents: 50000,
        });
    });

    it('isolates original kind, origin, access, dates, versions and invalid numeric input without writes', async () => {
        const f = await personal();
        const another = await personal();
        const outsider = await financeBrowser(app);
        const input = reversal(f.fact.id, 1000);
        const before = await financeSnapshot(db);
        await outsider.post(`${f.path}/reversals`, input).expect(404);
        await f.browser
            .post(`${f.path}/reversals`, {
                ...input,
                originalId: another.fact.id,
            })
            .expect(404);
        await f.browser
            .post(`${f.path}/reversals`, { ...input, originalKind: 'RECEIPT' })
            .expect(404);
        await f.browser
            .post(`${f.path}/reversals`, {
                ...input,
                expectedCommitmentVersion: 99,
            })
            .expect(409);
        await f.browser
            .post(`${f.path}/reversals`, {
                ...input,
                installmentId: randomUUID(),
            })
            .expect(404);
        for (const extra of [
            { amountInCents: 0 },
            { amountInCents: -1 },
            { amountInCents: '1000' },
            { reason: ' ' },
            { factDate: '2026-10-15' },
            { factDate: '2026-10-13' },
        ])
            await f.browser
                .post(`${f.path}/reversals`, { ...input, ...extra })
                .expect(400);
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('serializes duplicate and competing reversals using real PostgreSQL locks', async () => {
        const f = await sharedFinance(app);
        const created = (
            await f.a
                .post(
                    `${financeBase(f.space)}/shared-cash-expenses`,
                    sharedExpenseInput(f),
                )
                .expect(201)
        ).body;
        const [fact] = await db.query(
            'SELECT id FROM financial_disbursements WHERE commitment_id=$1',
            [created.commitment.id],
        );
        const path = `${commitmentPath(f.space, created.commitment.id)}/reversals`;
        const input = reversal(fact.id, 20000, {
            expectedSpaceVersion: f.context.version,
        });
        const key = randomUUID();
        const duplicate = await competingFinanceCommands(db, f.space, () =>
            Promise.all([
                f.a.post(path, input, key),
                f.a.post(path, input, key),
            ]),
        );
        expect(duplicate.map((response) => response.status).sort()).toEqual([
            200, 201,
        ]);
        const next = {
            ...input,
            expectedCommitmentVersion: duplicate[0].body.version,
        };
        const competing = await competingFinanceCommands(db, f.space, () =>
            Promise.all([f.a.post(path, next), f.b.post(path, next)]),
        );
        expect(competing.map((response) => response.status).sort()).toEqual([
            201, 409,
        ]);
        expect(
            await details(f.a, commitmentPath(f.space, created.commitment.id)),
        ).toMatchObject({
            supportedAmountInCents: 10000,
            remainingAmountInCents: 40000,
        });
    });

    it('rolls back the reversal, reconciliation and receipt when audit persistence fails', async () => {
        const f = await sharedFinance(app);
        const created = (
            await f.a
                .post(
                    `${financeBase(f.space)}/shared-cash-expenses`,
                    sharedExpenseInput(f),
                )
                .expect(201)
        ).body;
        const [fact] = await db.query(
            'SELECT id FROM financial_disbursements WHERE commitment_id=$1',
            [created.commitment.id],
        );
        const path = `${commitmentPath(f.space, created.commitment.id)}/reversals`;
        const input = reversal(fact.id, 50000, {
            expectedSpaceVersion: f.context.version,
        });
        const key = randomUUID();
        const before = await financeSnapshot(db);
        await db.query(
            'ALTER TABLE financial_command_audit ADD CONSTRAINT test_card_032_audit_failure CHECK (false) NOT VALID',
        );
        try {
            await f.a.post(path, input, key).expect(500);
            expect(await financeSnapshot(db)).toEqual(before);
        } finally {
            await db.query(
                'ALTER TABLE financial_command_audit DROP CONSTRAINT test_card_032_audit_failure',
            );
        }
        await f.a.post(path, input, key).expect(201);
        const written = await financeSnapshot(db);
        await f.a.post(path, input, key).expect(200);
        expect(await financeSnapshot(db)).toEqual(written);
    });

    it('serializes reversing an external principal against a new settlement without violating the linked balance', async () => {
        const f = await sharedFinance(app);
        const created = (
            await f.a
                .post(`${financeBase(f.space)}/credit-card-purchases`, {
                    description: 'Obrigação concorrente',
                    amountInCents: 50000,
                    factDate: today,
                    expectedSpaceVersion: f.context.version,
                    externalLiability: {
                        amountInCents: 50000,
                        holderMemberId: f.ma,
                    },
                    responsibilitySplit: {
                        mode: 'AMOUNTS',
                        shares: [
                            { memberId: f.ma, amountInCents: 30000 },
                            { memberId: f.mb, amountInCents: 20000 },
                        ],
                    },
                    settlement: { mode: 'NONE' },
                })
                .expect(201)
        ).body;
        const path = commitmentPath(f.space, created.commitment.id);
        const outcomes = await competingFinanceCommands(db, f.space, () =>
            Promise.all([
                f.a.post(
                    `${path}/reversals`,
                    reversal(created.externalLiability.id, 50000, {
                        originalKind: 'EXTERNAL_LIABILITY',
                        expectedSpaceVersion: f.context.version,
                    }),
                ),
                f.a.post(
                    `${path}/external-liabilities/${created.externalLiability.id}/settlements`,
                    {
                        expectedCommitmentVersion: 1,
                        expectedSpaceVersion: f.context.version,
                        amountInCents: 20000,
                        factDate: today,
                    },
                ),
            ]),
        );
        expect(outcomes.map((response) => response.status).sort()).toEqual([
            201, 409,
        ]);
        const detail = await details(f.a, path);
        if (outcomes[0].status === 201)
            expect(detail).toMatchObject({
                supportedAmountInCents: 0,
                externalOutstandingAmountInCents: 0,
                externalSettledAmountInCents: 0,
            });
        else
            expect(detail).toMatchObject({
                supportedAmountInCents: 50000,
                externalOutstandingAmountInCents: 30000,
                externalSettledAmountInCents: 20000,
            });
        expect(
            (
                await db.query(
                    'SELECT amount_in_cents::text AS amount FROM financial_external_liabilities WHERE id=$1',
                    [created.externalLiability.id],
                )
            )[0].amount,
        ).toBe('50000');
    });

    it('preserves the original month and records compensation only on its own civil date', async () => {
        const f = await personal();
        today = '2026-11-03';
        const reversed = (
            await f.browser
                .post(`${f.path}/reversals`, reversal(f.fact.id, 50000))
                .expect(201)
        ).body;
        const october = (
            await f.browser.agent
                .get(
                    `${financeBase(f.space)}/financial-timeline?month=2026-10&view=HISTORY`,
                )
                .expect(200)
        ).body;
        const november = (
            await f.browser.agent
                .get(
                    `${financeBase(f.space)}/financial-timeline?month=2026-11&view=HISTORY`,
                )
                .expect(200)
        ).body;
        expect(october.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: f.fact.id,
                    amountInCents: 50000,
                    relevantDate: '2026-10-14',
                }),
            ]),
        );
        expect(
            october.items.some(
                (item: { id: string }) => item.id === reversed.reversal.id,
            ),
        ).toBe(false);
        expect(november.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: reversed.reversal.id,
                    amountInCents: 50000,
                    relevantDate: '2026-11-03',
                }),
            ]),
        );
        const oldOverview = (
            await f.browser.agent
                .get(`${financeBase(f.space)}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        const newOverview = (
            await f.browser.agent
                .get(`${financeBase(f.space)}/financial-overview?month=2026-11`)
                .expect(200)
        ).body;
        expect(oldOverview.totals.paidAmountInCents).toBe('50000');
        expect(newOverview.totals.paidAmountInCents).toBe('-50000');
    });

    it('reverses a recurring fact on the exact occurrence while preserving its neighbors and snapshot', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/recurring-commitments`;
        const root = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    kind: 'EXPENSE',
                    description: 'Mensalidade',
                    amountInCents: 50000,
                    recurrence: { frequency: 'MONTHLY', dayOfMonth: 14 },
                    startsOn: '2026-10-01',
                })
                .expect(201)
        ).body.commitment;
        const first = (
            await browser
                .post(
                    `${base}/${root.id}/occurrences/2026-10-14/disbursements`,
                    {
                        expectedCommitmentVersion: 1,
                        expectedOccurrenceVersion: 1,
                        amountInCents: 20000,
                        factDate: today,
                        method: 'PIX',
                    },
                )
                .expect(201)
        ).body;
        const fact = first.occurrence.facts[0];
        const input = reversal(fact.id, 10000, {
            expectedCommitmentVersion: first.commitment.version,
            expectedOccurrenceVersion: first.occurrence.stateVersion,
            occurrenceId: first.occurrence.id,
        });
        await browser
            .post(`${commitmentPath(space, root.id)}/reversals`, input)
            .expect(201);
        const october = (
            await browser.agent
                .get(`${base}/${root.id}/occurrences?month=2026-10`)
                .expect(200)
        ).body.items[0];
        expect(october).toMatchObject({
            id: first.occurrence.id,
            fulfilledAmountInCents: 10000,
            remainingAmountInCents: 40000,
        });
        expect(october.facts).toEqual(expect.arrayContaining([fact]));
        const november = (
            await browser.agent
                .get(`${base}/${root.id}/occurrences?month=2026-11`)
                .expect(200)
        ).body.items[0];
        expect(november).toMatchObject({
            amountInCents: 50000,
            fulfilledAmountInCents: 0,
        });
    });

    it('reopens an anticipated installment while retaining its negotiated discount and schedule', async () => {
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
        const selection = {
            mode: 'IDS',
            installmentIds: [root.plan.installments[0].id],
        };
        const preview = (
            await browser
                .post(`${base}/${root.id}/anticipation-preview`, {
                    selection,
                    factDate: today,
                })
                .expect(200)
        ).body;
        const item = preview.items[0];
        const anticipated = (
            await browser
                .post(`${base}/${root.id}/anticipations`, {
                    selection,
                    factDate: today,
                    expectedCommitmentVersion: 1,
                    method: 'PIX',
                    values: [
                        {
                            installmentId: item.installmentId,
                            expectedInstallmentVersion:
                                item.expectedInstallmentVersion,
                            paidAmountInCents: 9000,
                        },
                    ],
                })
                .expect(201)
        ).body;
        const fact = anticipated.items[0].fact;
        const current = anticipated.commitment.plan.installments.find(
            (entry: { id: string }) => entry.id === item.installmentId,
        );
        await browser
            .post(
                `${commitmentPath(space, root.id)}/reversals`,
                reversal(fact.id, 9000, {
                    expectedCommitmentVersion: anticipated.commitment.version,
                    expectedOccurrenceVersion: current.stateVersion,
                    installmentId: item.installmentId,
                }),
            )
            .expect(201);
        const listed = (
            await browser.agent
                .get(`${base}/${root.id}/installments`)
                .expect(200)
        ).body.items;
        expect(
            listed.map((entry: { dueDate: string }) => entry.dueDate),
        ).toEqual(['2026-11-20', '2026-12-20']);
        expect(
            listed.find(
                (entry: { id: string }) => entry.id === item.installmentId,
            ),
        ).toMatchObject({
            amountInCents: 10000,
            effectiveAmountInCents: 9000,
            fulfilledAmountInCents: 0,
            remainingAmountInCents: 9000,
            anticipation: { factId: fact.id, adjustmentInCents: -1000 },
        });
        expect(
            listed.find(
                (entry: { id: string }) => entry.id !== item.installmentId,
            ),
        ).toMatchObject({
            amountInCents: 10000,
            remainingAmountInCents: 10000,
        });
        const november = (
            await browser.agent
                .get(`${financeBase(space)}/financial-forecast?month=2026-11`)
                .expect(200)
        ).body;
        expect(november.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: item.installmentId,
                    commitmentId: root.id,
                    amountInCents: 9000,
                    fulfilledAmountInCents: 0,
                    remainingAmountInCents: 9000,
                }),
            ]),
        );
        expect(november.totals).toMatchObject({
            expectedExpenseAmountInCents: '9000',
            fulfilledExpenseAmountInCents: '0',
            remainingExpenseAmountInCents: '9000',
        });
        const december = (
            await browser.agent
                .get(`${financeBase(space)}/financial-forecast?month=2026-12`)
                .expect(200)
        ).body;
        expect(december.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: root.plan.installments[1].id,
                    commitmentId: root.id,
                    amountInCents: 10000,
                    fulfilledAmountInCents: 0,
                    remainingAmountInCents: 10000,
                }),
            ]),
        );
        expect(december.totals).toMatchObject({
            expectedExpenseAmountInCents: '10000',
            fulfilledExpenseAmountInCents: '0',
            remainingExpenseAmountInCents: '10000',
        });
    });

    it('requires the indivisible global payoff to be fully reversed without creating payments per installment', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/installment-commitments`;
        const root = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    description: 'Plano global',
                    count: 2,
                    firstDueDate: '2026-11-20',
                    cadence: 'MONTHLY',
                    totalAmountInCents: 20000,
                })
                .expect(201)
        ).body.commitment;
        const preview = (
            await browser
                .post(`${base}/${root.id}/payoff-preview`, {
                    paidAmountInCents: 18000,
                    factDate: today,
                })
                .expect(200)
        ).body;
        const payoff = (
            await browser
                .post(`${base}/${root.id}/payoffs`, {
                    paidAmountInCents: 18000,
                    factDate: today,
                    method: 'PIX',
                    expectedCommitmentVersion: 1,
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
                .expect(201)
        ).body;
        const path = commitmentPath(space, root.id);
        const input = reversal(payoff.fact.id, 18000, {
            expectedCommitmentVersion: payoff.commitment.version,
        });
        const before = await financeSnapshot(db);
        const blocked = (
            await browser
                .post(`${path}/reversal-preview`, {
                    ...input,
                    amountInCents: 9000,
                })
                .expect(200)
        ).body;
        expect(blocked).toMatchObject({
            eligible: false,
            requiresFullReversal: true,
            blockingReason: 'FINANCIAL_REVERSAL_FULL_REQUIRED',
        });
        await browser
            .post(`${path}/reversals`, { ...input, amountInCents: 9000 })
            .expect(409);
        expect(await financeSnapshot(db)).toEqual(before);
        await browser.post(`${path}/reversals`, input).expect(201);
        const facts = await db.query(
            'SELECT id,occurrence_id,amount_in_cents::text AS amount FROM financial_disbursements WHERE commitment_id=$1',
            [root.id],
        );
        expect(facts).toEqual([
            { id: payoff.fact.id, occurrence_id: null, amount: '18000' },
        ]);
        const detail = (
            await browser.agent.get(`${base}/${root.id}`).expect(200)
        ).body.commitment;
        expect(detail.plan.status).toBe('OPEN');
        expect(
            detail.plan.installments.map(
                (item: { dueDate: string }) => item.dueDate,
            ),
        ).toEqual(['2026-11-20', '2026-12-20']);
        expect(detail.plan.fulfilledAmountInCents).toBe(0);
        expect(detail.plan.remainingAmountInCents).toBe(18000);
        expect(detail.plan.globalAdjustmentInCents).toBe(-2000);
        const first = detail.plan.installments[0];
        const paid = (
            await browser
                .post(
                    `${base}/${root.id}/installments/${first.id}/disbursements`,
                    {
                        expectedCommitmentVersion: detail.version,
                        expectedInstallmentVersion: first.stateVersion,
                        amountInCents: 5000,
                        factDate: today,
                        method: 'PIX',
                    },
                )
                .expect(201)
        ).body;
        expect(paid.commitment.plan).toMatchObject({
            globalAdjustmentInCents: -2000,
            remainingAmountInCents: 13000,
        });
        const nextPreview = (
            await browser
                .post(`${base}/${root.id}/payoff-preview`, {
                    paidAmountInCents: 13000,
                    factDate: today,
                    expectedCommitmentVersion: paid.commitment.version,
                })
                .expect(200)
        ).body;
        expect(nextPreview).toMatchObject({
            expectedRemainingAmountInCents: 13000,
            adjustmentInCents: 0,
        });
        const nextPayoff = (
            await browser
                .post(`${base}/${root.id}/payoffs`, {
                    paidAmountInCents: 13000,
                    factDate: today,
                    method: 'PIX',
                    expectedCommitmentVersion: paid.commitment.version,
                    installments: nextPreview.items.map(
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
        expect(nextPayoff.commitment.plan).toMatchObject({
            status: 'COMPLETED',
            fulfilledAmountInCents: 18000,
            remainingAmountInCents: 0,
            globalAdjustmentInCents: -2000,
        });
        const overview = (
            await browser.agent
                .get(`${financeBase(space)}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        expect(overview.totals.expenseAmountInCents).toBe('18000');
        expect(overview.totals.paidAmountInCents).toBe('18000');
    });

    it('blocks reversal of an old installment payment until its later active global payoff is compensated', async () => {
        const browser = await financeBrowser(app);
        const space = browser.context.personalSpace.id as string;
        const base = `${financeBase(space)}/installment-commitments`;
        const root = (
            await browser
                .post(base, {
                    scope: 'PERSONAL',
                    description: 'Parcial antes da quitação',
                    count: 2,
                    firstDueDate: '2026-11-20',
                    cadence: 'MONTHLY',
                    totalAmountInCents: 20000,
                })
                .expect(201)
        ).body.commitment;
        const first = root.plan.installments[0];
        const partial = (
            await browser
                .post(
                    `${base}/${root.id}/installments/${first.id}/disbursements`,
                    {
                        expectedCommitmentVersion: 1,
                        expectedInstallmentVersion: 1,
                        amountInCents: 2000,
                        factDate: today,
                        method: 'PIX',
                    },
                )
                .expect(201)
        ).body;
        const [original] = await db.query(
            'SELECT id FROM financial_disbursements WHERE commitment_id=$1 AND occurrence_id=$2',
            [root.id, first.id],
        );
        const preview = (
            await browser
                .post(`${base}/${root.id}/payoff-preview`, {
                    paidAmountInCents: 16000,
                    factDate: today,
                    expectedCommitmentVersion: partial.commitment.version,
                })
                .expect(200)
        ).body;
        const payoff = (
            await browser
                .post(`${base}/${root.id}/payoffs`, {
                    paidAmountInCents: 16000,
                    factDate: today,
                    expectedCommitmentVersion: partial.commitment.version,
                    method: 'PIX',
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
                .expect(201)
        ).body;
        const current = payoff.commitment.plan.installments.find(
            (item: { id: string }) => item.id === first.id,
        );
        const path = commitmentPath(space, root.id);
        const input = reversal(original.id, 1000, {
            expectedCommitmentVersion: payoff.commitment.version,
            expectedOccurrenceVersion: current.stateVersion,
            installmentId: first.id,
        });
        const before = await financeSnapshot(db);
        const blocked = (
            await browser.post(`${path}/reversal-preview`, input).expect(200)
        ).body;
        expect(blocked).toMatchObject({
            eligible: false,
            blockingReason: 'FINANCIAL_REVERSAL_FULL_REQUIRED',
            requiresFullReversal: true,
            blockingGlobalPayoffId: payoff.payoffId,
        });
        expect(
            (await browser.post(`${path}/reversals`, input).expect(409)).body
                .code,
        ).toBe('FINANCIAL_REVERSAL_FULL_REQUIRED');
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('paginates reversals with a cursor bound to the reader and keeps every original intact', async () => {
        const f = await sharedFinance(app);
        const created = (
            await f.a
                .post(
                    `${financeBase(f.space)}/shared-cash-expenses`,
                    sharedExpenseInput(f),
                )
                .expect(201)
        ).body;
        const [fact] = await db.query(
            'SELECT id FROM financial_disbursements WHERE commitment_id=$1',
            [created.commitment.id],
        );
        const path = commitmentPath(f.space, created.commitment.id);
        let version = 1;
        const ids: string[] = [];
        for (let index = 0; index < 21; index++) {
            const result = (
                await f.a
                    .post(
                        `${path}/reversals`,
                        reversal(fact.id, 1, {
                            expectedCommitmentVersion: version,
                            expectedSpaceVersion: f.context.version,
                        }),
                    )
                    .expect(201)
            ).body;
            version = result.version;
            ids.push(result.reversal.id);
        }
        const before = await financeSnapshot(db);
        const page = (await f.a.agent.get(`${path}/reversals`).expect(200))
            .body;
        expect(page.items).toHaveLength(20);
        expect(page.totalCount).toBe(21);
        expect(page.nextCursor).toBeTruthy();
        const last = (
            await f.a.agent
                .get(
                    `${path}/reversals?cursor=${encodeURIComponent(page.nextCursor)}`,
                )
                .expect(200)
        ).body;
        expect(last.items).toHaveLength(1);
        expect(last.totalCount).toBe(21);
        expect(last.nextCursor).toBeNull();
        expect(
            new Set(
                [...page.items, ...last.items].map(
                    (item: { id: string }) => item.id,
                ),
            ),
        ).toEqual(new Set(ids));
        await f.b.agent
            .get(
                `${path}/reversals?cursor=${encodeURIComponent(page.nextCursor)}`,
            )
            .expect(400);
        await f.a.agent.get(`${path}/reversals?cursor=invalid`).expect(400);
        expect(await financeSnapshot(db)).toEqual(before);
        expect((await details(f.a, path)).paidAmountInCents).toBe(49979);
    });

    it('keeps a finalized settlement composition intact and directs the correction into a new open cycle', async () => {
        const f = await sharedFinance(app);
        const created = (
            await f.a
                .post(
                    `${financeBase(f.space)}/shared-cash-expenses`,
                    sharedExpenseInput(f, 50000, 50000, {
                        mode: 'DATE',
                        targetDate: '2026-10-20',
                    }),
                )
                .expect(201)
        ).body;
        const id = created.commitment.id as string;
        const cycleId = created.obligation.cycleId as string;
        await transfer(f, id, 20000);
        const [cycle] = await db.query(
            'SELECT version FROM settlement_cycles WHERE id=$1',
            [cycleId],
        );
        await f.a
            .post(
                `${financeBase(f.space)}/settlement-cycles/${cycleId}/finalize`,
                {
                    expectedSpaceVersion: f.context.version,
                    expectedCycleVersion: cycle.version,
                },
            )
            .expect(200);
        const oldCycle = await db.query(
            'SELECT * FROM settlement_cycles WHERE id=$1',
            [cycleId],
        );
        const oldObligations = await db.query(
            'SELECT * FROM inter_member_obligations WHERE cycle_id=$1 ORDER BY id',
            [cycleId],
        );
        const allocations = await db.query(
            'SELECT * FROM settlement_allocations ORDER BY id',
        );
        const [fact] = await db.query(
            'SELECT id FROM financial_disbursements WHERE commitment_id=$1',
            [id],
        );
        const path = commitmentPath(f.space, id);
        const input = reversal(fact.id, 50000, {
            expectedSpaceVersion: f.context.version,
            settlement: { mode: 'NONE' },
        });
        const before = await financeSnapshot(db);
        const preview = (
            await f.a.post(`${path}/reversal-preview`, input).expect(200)
        ).body;
        expect(preview).toMatchObject({
            eligible: false,
            blockingReason: 'REVERSAL_CORRECTION_CYCLE_REQUIRED',
            reconciliation: {
                requiresOpenCycle: true,
                finalizedCycleIds: [cycleId],
            },
        });
        await f.a.post(`${path}/reversals`, input).expect(409);
        expect(await financeSnapshot(db)).toEqual(before);
        await f.a
            .post(`${path}/reversals`, {
                ...input,
                settlement: { mode: 'DATE', targetDate: '2026-10-21' },
            })
            .expect(201);
        expect(
            await db.query('SELECT * FROM settlement_cycles WHERE id=$1', [
                cycleId,
            ]),
        ).toEqual(oldCycle);
        expect(
            await db.query(
                'SELECT * FROM inter_member_obligations WHERE cycle_id=$1 ORDER BY id',
                [cycleId],
            ),
        ).toEqual(oldObligations);
        expect(
            await db.query('SELECT * FROM settlement_allocations ORDER BY id'),
        ).toEqual(allocations);
        const [open] = await openObligations(id);
        expect(open).toMatchObject({
            debtor_member_id: f.ma,
            creditor_member_id: f.mb,
            remaining_amount_in_cents: '20000',
        });
        expect(open.cycle_id).not.toBe(cycleId);
        const [next] = await db.query(
            'SELECT status,target_date::text AS date FROM settlement_cycles WHERE id=$1',
            [open.cycle_id],
        );
        expect(next).toEqual({ status: 'OPEN', date: '2026-10-21' });
    });

    it('keeps the accepted structural version and explicit adjustment intact throughout the 030 to 031 to 032 journey', async () => {
        const f = await sharedFinance(app);
        const root = (
            await f.a
                .post(`${financeBase(f.space)}/planned-expenses`, {
                    scope: 'SHARED',
                    description: 'Despesa da jornada',
                    amountInCents: 50000,
                    expectedPaymentDate: '2026-10-20',
                    expectedSpaceVersion: f.context.version,
                    expectedPayerMemberId: f.ma,
                    responsibilitySplit: {
                        mode: 'PERCENTAGES',
                        shares: [
                            { memberId: f.ma, basisPoints: 6000 },
                            { memberId: f.mb, basisPoints: 4000 },
                        ],
                    },
                })
                .expect(201)
        ).body.commitment;
        const path = commitmentPath(f.space, root.id);
        const configuration = {
            scope: 'SHARED',
            kind: 'EXPENSE',
            description: 'Regra acordada',
            amountInCents: 60000,
            effectiveFrom: '2026-10-15',
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
        const proposed = (
            await f.a
                .post(`${path}/change-proposals`, configuration)
                .expect(201)
        ).body;
        const accepted = (
            await f.b
                .post(
                    `${path}/change-proposals/${proposed.proposal.id}/acceptance`,
                    {
                        expectedProposalVersion: 1,
                        expectedCommitmentVersion: 1,
                        expectedSpaceVersion: f.context.version,
                    },
                )
                .expect(201)
        ).body;
        expect(accepted.proposal.status).toBe('ACCEPTED');
        today = '2026-10-15';
        const adjustment = (
            await f.a
                .post(`${path}/adjustments`, {
                    expectedCommitmentVersion: accepted.version,
                    expectedSpaceVersion: f.context.version,
                    direction: 'DECREASE',
                    amountInCents: 1000,
                    reason: 'Desconto manual acordado',
                    factDate: today,
                })
                .expect(201)
        ).body;
        const paid = (
            await f.a
                .post(`${path}/disbursements`, {
                    expectedCommitmentVersion: adjustment.version,
                    expectedSpaceVersion: f.context.version,
                    payerMemberId: f.ma,
                    amountInCents: 59000,
                    method: 'PIX',
                    factDate: today,
                    settlement: { mode: 'NONE' },
                })
                .expect(201)
        ).body;
        const [fact] = await db.query(
            'SELECT id FROM financial_disbursements WHERE commitment_id=$1',
            [root.id],
        );
        await f.a
            .post(
                `${path}/reversals`,
                reversal(fact.id, 10000, {
                    expectedCommitmentVersion: paid.commitment.version,
                    expectedSpaceVersion: f.context.version,
                }),
            )
            .expect(201);
        expect(await details(f.a, path)).toMatchObject({
            commitment: { amountInCents: 59000 },
            paidAmountInCents: 49000,
            remainingAmountInCents: 10000,
        });
        expect(
            (
                await f.a.agent
                    .get(`${path}/change-proposals/${proposed.proposal.id}`)
                    .expect(200)
            ).body.proposal.status,
        ).toBe('ACCEPTED');
        expect(
            (
                await db.query(
                    'SELECT amount_in_cents::text AS amount FROM financial_commitment_adjustments WHERE id=$1',
                    [adjustment.adjustment.id],
                )
            )[0].amount,
        ).toBe('1000');
        expect(
            (
                await db.query(
                    'SELECT amount_in_cents::text AS amount FROM financial_commitment_versions WHERE commitment_id=$1 AND version=1',
                    [root.id],
                )
            )[0].amount,
        ).toBe('50000');
    });

    it('revalidates suggested dates and rule versions before exposing a finalized destination as blocked', async () => {
        const f = await sharedFinance(app);
        await f.a
            .put(`${financeBase(f.space)}/default-settlement-rule`, {
                expectedVersion: 0,
                rule: { kind: 'MONTHLY_DAY', dayOfMonth: 20 },
            })
            .expect(200);
        const created = (
            await f.a
                .post(
                    `${financeBase(f.space)}/shared-cash-expenses`,
                    sharedExpenseInput(f, 50000, 50000, {
                        mode: 'DATE',
                        targetDate: '2026-10-20',
                    }),
                )
                .expect(201)
        ).body;
        const id = created.commitment.id as string;
        const cycleId = created.obligation.cycleId as string;
        await transfer(f, id, 20000);
        const [cycle] = await db.query(
            'SELECT version FROM settlement_cycles WHERE id=$1',
            [cycleId],
        );
        await f.a
            .post(
                `${financeBase(f.space)}/settlement-cycles/${cycleId}/finalize`,
                {
                    expectedSpaceVersion: f.context.version,
                    expectedCycleVersion: cycle.version,
                },
            )
            .expect(200);
        const [fact] = await db.query(
            'SELECT id FROM financial_disbursements WHERE commitment_id=$1',
            [id],
        );
        const path = commitmentPath(f.space, id);
        const input = reversal(fact.id, 50000, {
            expectedSpaceVersion: f.context.version,
        });
        const before = await financeSnapshot(db);
        for (const selection of [
            {
                mode: 'SUGGESTED',
                referenceDate: '2026-10-13',
                expectedRuleVersion: 1,
            },
            {
                mode: 'SUGGESTED',
                referenceDate: today,
                expectedRuleVersion: 999,
            },
        ]) {
            expect(
                (
                    await f.a
                        .post(`${path}/reversal-preview`, {
                            ...input,
                            settlement: selection,
                        })
                        .expect(409)
                ).body.code,
            ).toBe('EXPENSE_OPTIONS_CHANGED');
            expect(
                (
                    await f.a
                        .post(`${path}/reversals`, {
                            ...input,
                            settlement: selection,
                        })
                        .expect(409)
                ).body.code,
            ).toBe('EXPENSE_OPTIONS_CHANGED');
        }
        const selection = {
            mode: 'SUGGESTED',
            referenceDate: today,
            expectedRuleVersion: 1,
        };
        const blocked = (
            await f.a
                .post(`${path}/reversal-preview`, {
                    ...input,
                    settlement: selection,
                })
                .expect(200)
        ).body;
        expect(blocked).toMatchObject({
            eligible: false,
            blockingReason: 'SETTLEMENT_CYCLE_FINALIZED',
            reconciliation: { blockingReason: 'SETTLEMENT_CYCLE_FINALIZED' },
        });
        expect(
            (
                await f.a
                    .post(`${path}/reversals`, {
                        ...input,
                        settlement: selection,
                    })
                    .expect(409)
            ).body.code,
        ).toBe('SETTLEMENT_CYCLE_FINALIZED');
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it.each([
        {
            title: 'keeps an old 1700 adjustment and recognizes only 58300 when a later 60000 version is paid',
            adjustmentAmount: 1700,
            versionAmount: 60000,
            residualAmount: 58300,
            residualType: 'EXPENSE',
        },
        {
            title: 'recognizes a negative 10000 residual when a later 10000 version supersedes an old 20000 adjustment',
            adjustmentAmount: 20000,
            versionAmount: 10000,
            residualAmount: -10000,
            residualType: 'EXPENSE_DISCOUNT',
        },
    ])(
        '$title',
        async ({
            adjustmentAmount,
            versionAmount,
            residualAmount,
            residualType,
        }) => {
            const browser = await financeBrowser(app);
            const space = browser.context.personalSpace.id as string;
            const root = (
                await browser
                    .post(`${financeBase(space)}/planned-expenses`, {
                        scope: 'PERSONAL',
                        description: 'Histórico antes da nova versão',
                        amountInCents: 50000,
                        expectedPaymentDate: '2026-12-20',
                    })
                    .expect(201)
            ).body.commitment;
            const path = commitmentPath(space, root.id);
            const adjusted = (
                await browser
                    .post(`${path}/adjustments`, {
                        expectedCommitmentVersion: 1,
                        direction: 'INCREASE',
                        amountInCents: adjustmentAmount,
                        reason: 'Encargo anterior à revisão econômica',
                        factDate: today,
                    })
                    .expect(201)
            ).body;
            const changed = (
                await browser
                    .post(`${path}/versions`, {
                        scope: 'PERSONAL',
                        kind: 'EXPENSE',
                        description: 'Nova configuração econômica',
                        amountInCents: versionAmount,
                        effectiveFrom: '2026-11-01',
                        expectedCommitmentVersion: adjusted.version,
                    })
                    .expect(201)
            ).body;
            const originalVersions = await db.query(
                'SELECT * FROM financial_commitment_versions WHERE commitment_id=$1 ORDER BY version',
                [root.id],
            );
            const futureVersions = await db.query(
                'SELECT * FROM financial_non_recurring_versions WHERE commitment_id=$1 ORDER BY version',
                [root.id],
            );
            const oldAdjustments = await db.query(
                'SELECT * FROM financial_commitment_adjustments WHERE commitment_id=$1 ORDER BY commitment_version',
                [root.id],
            );
            today = '2026-12-20';
            await browser
                .post(`${path}/disbursements`, {
                    expectedCommitmentVersion: changed.version,
                    amountInCents: versionAmount,
                    method: 'PIX',
                    factDate: today,
                })
                .expect(201);
            const october = (
                await browser.agent
                    .get(
                        `${financeBase(space)}/financial-overview?month=2026-10`,
                    )
                    .expect(200)
            ).body;
            const december = (
                await browser.agent
                    .get(
                        `${financeBase(space)}/financial-overview?month=2026-12`,
                    )
                    .expect(200)
            ).body;
            expect(october.totals.expenseAmountInCents).toBe(
                adjustmentAmount.toString(),
            );
            expect(december.totals.expenseAmountInCents).toBe(
                residualAmount.toString(),
            );
            expect(
                BigInt(october.totals.expenseAmountInCents) +
                    BigInt(december.totals.expenseAmountInCents),
            ).toBe(BigInt(versionAmount));
            expect(december.totals.paidAmountInCents).toBe(
                versionAmount.toString(),
            );
            const timeline = (
                await browser.agent
                    .get(
                        `${financeBase(space)}/financial-timeline?month=2026-12&view=HISTORY`,
                    )
                    .expect(200)
            ).body;
            expect(timeline.items).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        commitmentId: root.id,
                        type: residualType,
                        amountInCents: Math.abs(residualAmount),
                        relevantDate: today,
                    }),
                ]),
            );
            expect(await details(browser, path)).toMatchObject({
                commitment: { amountInCents: versionAmount },
                paidAmountInCents: versionAmount,
                remainingAmountInCents: 0,
            });
            expect(
                await db.query(
                    'SELECT * FROM financial_commitment_versions WHERE commitment_id=$1 ORDER BY version',
                    [root.id],
                ),
            ).toEqual(originalVersions);
            expect(
                await db.query(
                    'SELECT * FROM financial_non_recurring_versions WHERE commitment_id=$1 ORDER BY version',
                    [root.id],
                ),
            ).toEqual(futureVersions);
            expect(
                await db.query(
                    'SELECT * FROM financial_commitment_adjustments WHERE commitment_id=$1 ORDER BY commitment_version',
                    [root.id],
                ),
            ).toEqual(oldAdjustments);
            expect(originalVersions).toMatchObject([
                { amount_in_cents: '50000' },
            ]);
            expect(futureVersions).toMatchObject([
                { amount_in_cents: versionAmount.toString() },
            ]);
        },
    );

    it('recognizes a manually adjusted shared installment once when its first realization is a later global payoff', async () => {
        const f = await sharedFinance(app);
        const base = `${financeBase(f.space)}/installment-commitments`;
        const root = (
            await f.a
                .post(base, {
                    scope: 'SHARED',
                    description: 'Juros antes da quitação',
                    count: 2,
                    firstDueDate: '2026-11-20',
                    cadence: 'MONTHLY',
                    totalAmountInCents: 20000,
                    distribution: {
                        mode: 'PERCENTAGES',
                        shares: [
                            { memberId: f.ma, basisPoints: 6000 },
                            { memberId: f.mb, basisPoints: 4000 },
                        ],
                    },
                    expectedMemberId: f.ma,
                    expectedSpaceVersion: f.context.version,
                    expectedRuleVersion: 0,
                })
                .expect(201)
        ).body.commitment;
        const path = commitmentPath(f.space, root.id);
        const proposed = (
            await f.a
                .post(`${path}/adjustments`, {
                    expectedCommitmentVersion: 1,
                    expectedSpaceVersion: f.context.version,
                    expectedOccurrenceVersion: 1,
                    installmentId: root.plan.installments[0].id,
                    direction: 'INCREASE',
                    amountInCents: 1700,
                    reason: 'Juros manuais anteriores à realização',
                    factDate: today,
                })
                .expect(201)
        ).body;
        expect(proposed.proposal.recipientMemberId).toBe(f.mb);
        const accepted = (
            await f.b
                .post(
                    `${path}/change-proposals/${proposed.proposal.id}/acceptance`,
                    {
                        expectedProposalVersion: 1,
                        expectedCommitmentVersion: 1,
                        expectedSpaceVersion: f.context.version,
                    },
                )
                .expect(201)
        ).body;
        expect(accepted.adjustment.amountInCents).toBe(1700);
        const oldAdjustments = await db.query(
            'SELECT * FROM financial_commitment_adjustments WHERE commitment_id=$1 ORDER BY commitment_version',
            [root.id],
        );
        today = '2026-11-14';
        const preview = (
            await f.a
                .post(`${base}/${root.id}/payoff-preview`, {
                    expectedCommitmentVersion: accepted.version,
                    expectedSpaceVersion: f.context.version,
                    paidAmountInCents: 21700,
                    factDate: today,
                    payerMemberId: f.ma,
                    method: 'PIX',
                    settlement: { mode: 'NONE' },
                })
                .expect(200)
        ).body;
        expect(preview).toMatchObject({
            expectedRemainingAmountInCents: 21700,
            adjustmentInCents: 0,
        });
        const paid = (
            await f.a
                .post(`${base}/${root.id}/payoffs`, {
                    expectedCommitmentVersion: accepted.version,
                    expectedSpaceVersion: f.context.version,
                    paidAmountInCents: 21700,
                    factDate: today,
                    payerMemberId: f.ma,
                    method: 'PIX',
                    settlement: { mode: 'NONE' },
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
                .expect(201)
        ).body;
        expect(paid.commitment.plan).toMatchObject({
            status: 'COMPLETED',
            fulfilledAmountInCents: 21700,
            remainingAmountInCents: 0,
        });
        const october = (
            await f.a.agent
                .get(`${financeBase(f.space)}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        const november = (
            await f.a.agent
                .get(`${financeBase(f.space)}/financial-overview?month=2026-11`)
                .expect(200)
        ).body;
        expect(october.totals.expenseAmountInCents).toBe('1700');
        expect(november.totals.expenseAmountInCents).toBe('20000');
        expect(
            BigInt(october.totals.expenseAmountInCents) +
                BigInt(november.totals.expenseAmountInCents),
        ).toBe(21700n);
        for (const [memberId, oldAmount, newAmount] of [
            [f.ma, '1020', '12000'],
            [f.mb, '680', '8000'],
        ]) {
            expect(
                october.byMember.find(
                    (member: { memberId: string }) =>
                        member.memberId === memberId,
                ).expenseAmountInCents,
            ).toBe(oldAmount);
            expect(
                november.byMember.find(
                    (member: { memberId: string }) =>
                        member.memberId === memberId,
                ).expenseAmountInCents,
            ).toBe(newAmount);
        }
        const timeline = (
            await f.a.agent
                .get(
                    `${financeBase(f.space)}/financial-timeline?month=2026-10&view=HISTORY`,
                )
                .expect(200)
        ).body;
        expect(timeline.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: accepted.adjustment.id,
                    type: 'EXPENSE_SURCHARGE',
                    amountInCents: 1700,
                    relevantDate: '2026-10-14',
                }),
            ]),
        );
        expect(
            await db.query(
                'SELECT * FROM financial_commitment_adjustments WHERE commitment_id=$1 ORDER BY commitment_version',
                [root.id],
            ),
        ).toEqual(oldAdjustments);
        expect(
            await db.query(
                'SELECT occurrence_id,amount_in_cents::text AS amount FROM financial_disbursements WHERE commitment_id=$1',
                [root.id],
            ),
        ).toEqual([{ occurrence_id: null, amount: '21700' }]);
    });

    it('does not recognize an installment twice when its fully reversed partial payment precedes the first global payoff', async () => {
        const f = await sharedFinance(app);
        const base = `${financeBase(f.space)}/installment-commitments`;
        const root = (
            await f.a
                .post(base, {
                    scope: 'SHARED',
                    description: 'Parcial revertido antes da primeira quitação',
                    count: 2,
                    firstDueDate: '2026-11-20',
                    cadence: 'MONTHLY',
                    totalAmountInCents: 20000,
                    distribution: {
                        mode: 'PERCENTAGES',
                        shares: [
                            { memberId: f.ma, basisPoints: 6000 },
                            { memberId: f.mb, basisPoints: 4000 },
                        ],
                    },
                    expectedMemberId: f.ma,
                    expectedSpaceVersion: f.context.version,
                    expectedRuleVersion: 0,
                })
                .expect(201)
        ).body.commitment;
        const first = root.plan.installments[0];
        const partial = (
            await f.a
                .post(
                    `${base}/${root.id}/installments/${first.id}/disbursements`,
                    {
                        expectedCommitmentVersion: 1,
                        expectedInstallmentVersion: 1,
                        expectedSpaceVersion: f.context.version,
                        amountInCents: 2000,
                        factDate: today,
                        payerMemberId: f.ma,
                        method: 'PIX',
                        settlement: { mode: 'NONE' },
                    },
                )
                .expect(201)
        ).body;
        const [fact] = await db.query(
            'SELECT * FROM financial_disbursements WHERE commitment_id=$1',
            [root.id],
        );
        const current = partial.commitment.plan.installments.find(
            (item: { id: string }) => item.id === first.id,
        );
        const reversed = (
            await f.a
                .post(
                    `${commitmentPath(f.space, root.id)}/reversals`,
                    reversal(fact.id, 2000, {
                        expectedCommitmentVersion: partial.commitment.version,
                        expectedOccurrenceVersion: current.stateVersion,
                        expectedSpaceVersion: f.context.version,
                        installmentId: first.id,
                    }),
                )
                .expect(201)
        ).body;
        today = '2026-11-14';
        const preview = (
            await f.a
                .post(`${base}/${root.id}/payoff-preview`, {
                    expectedCommitmentVersion: reversed.version,
                    expectedSpaceVersion: f.context.version,
                    paidAmountInCents: 20000,
                    factDate: today,
                    payerMemberId: f.ma,
                    method: 'PIX',
                    settlement: { mode: 'NONE' },
                })
                .expect(200)
        ).body;
        const paid = (
            await f.a
                .post(`${base}/${root.id}/payoffs`, {
                    expectedCommitmentVersion: reversed.version,
                    expectedSpaceVersion: f.context.version,
                    paidAmountInCents: 20000,
                    factDate: today,
                    payerMemberId: f.ma,
                    method: 'PIX',
                    settlement: { mode: 'NONE' },
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
                .expect(201)
        ).body;
        expect(paid.commitment.plan).toMatchObject({
            status: 'COMPLETED',
            fulfilledAmountInCents: 20000,
            remainingAmountInCents: 0,
        });
        const october = (
            await f.a.agent
                .get(`${financeBase(f.space)}/financial-overview?month=2026-10`)
                .expect(200)
        ).body;
        const november = (
            await f.a.agent
                .get(`${financeBase(f.space)}/financial-overview?month=2026-11`)
                .expect(200)
        ).body;
        expect(october.totals.expenseAmountInCents).toBe('10000');
        expect(november.totals.expenseAmountInCents).toBe('10000');
        expect(october.totals.paidAmountInCents).toBe('0');
        expect(november.totals.paidAmountInCents).toBe('20000');
        for (const [memberId, expected] of [
            [f.ma, 12000n],
            [f.mb, 8000n],
        ]) {
            const oldAmount = october.byMember.find(
                (member: { memberId: string }) => member.memberId === memberId,
            ).expenseAmountInCents;
            const newAmount = november.byMember.find(
                (member: { memberId: string }) => member.memberId === memberId,
            ).expenseAmountInCents;
            expect(BigInt(oldAmount) + BigInt(newAmount)).toBe(expected);
        }
        expect(
            (
                await db.query(
                    'SELECT * FROM financial_disbursements WHERE id=$1',
                    [fact.id],
                )
            )[0],
        ).toEqual(fact);
    });

    it('supports empty down and up but blocks a destructive down after financial reversal history exists', async () => {
        await migrationSource.initialize();
        try {
            await rewindFinanceMigrationsTo(
                migrationSource,
                'FinancialFulfillmentReversals1792252537110',
            );
            await migrationSource.undoLastMigration();
            expect(
                (
                    await db.query(
                        "SELECT to_regclass('public.financial_fulfillment_reversals') AS name",
                    )
                )[0].name,
            ).toBeNull();
            await migrationSource.runMigrations();
            const f = await personal();
            await f.browser
                .post(`${f.path}/reversals`, reversal(f.fact.id, 1000))
                .expect(201);
            await rewindFinanceMigrationsTo(
                migrationSource,
                'FinancialFulfillmentReversals1792252537110',
            );
            const before = await financeSnapshot(db);
            await expect(migrationSource.undoLastMigration()).rejects.toThrow(
                /hist[oó]rico|revers|compens/i,
            );
            expect(await financeSnapshot(db)).toEqual(before);
            expect(
                (
                    await db.query(
                        'SELECT name FROM migrations ORDER BY id DESC LIMIT 1',
                    )
                )[0].name,
            ).toBe('FinancialFulfillmentReversals1792252537110');
        } finally {
            await migrationSource.runMigrations();
            await migrationSource.destroy();
        }
    });
});
