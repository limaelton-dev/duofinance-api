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
    commitmentPath,
    competingFinanceCommands,
    financeBase,
    financeBrowser,
    financeSnapshot,
    sharedFinance,
    type SharedFinance,
} from './settlement-fixture.js';

describe('CARD-030 prospective financial changes and recipient acceptance', () => {
    let app: INestApplication<Server>;
    let db: DataSource;
    let currentDate = '2026-10-14';
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
        currentDate = '2026-10-14';
        const module = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(FINANCES_CLOCK)
            .useValue({ now: () => instant, today: () => currentDate })
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

    const distribution = (f: SharedFinance, a = 6000, b = 4000) => ({
        mode: 'PERCENTAGES',
        shares: [
            { memberId: f.ma, basisPoints: a },
            { memberId: f.mb, basisPoints: b },
        ],
    });
    const recurringInput = (f: SharedFinance) => ({
        scope: 'SHARED',
        kind: 'EXPENSE',
        description: 'Aluguel',
        amountInCents: 150000,
        recurrence: { frequency: 'MONTHLY', dayOfMonth: 14 },
        startsOn: '2026-10-01',
        expectedSpaceVersion: f.context.version,
        expectedMemberId: f.ma,
        distribution: distribution(f),
    });
    const changeInput = (f: SharedFinance) => ({
        scope: 'SHARED',
        kind: 'EXPENSE',
        valueMode: 'FIXED',
        description: 'Aluguel reajustado',
        amountInCents: 170000,
        recurrence: { frequency: 'MONTHLY', dayOfMonth: 14 },
        effectiveFrom: '2026-11-01',
        expectedCommitmentVersion: 1,
        expectedSpaceVersion: f.context.version,
        expectedMemberId: f.ma,
        distribution: distribution(f),
    });
    const decisionInput = (f: SharedFinance) => ({
        expectedProposalVersion: 1,
        expectedCommitmentVersion: 1,
        expectedSpaceVersion: f.context.version,
    });
    const createRent = async (f: SharedFinance) =>
        (
            await f.a
                .post(
                    `${financeBase(f.space)}/recurring-commitments`,
                    recurringInput(f),
                )
                .expect(201)
        ).body.commitment;
    const recurringPath = (f: SharedFinance, id: string) =>
        `${financeBase(f.space)}/recurring-commitments/${id}`;

    it('preserves the old rent and realized snapshot until recipient acceptance and the effective boundary', async () => {
        const f = await sharedFinance(app);
        const root = await createRent(f);
        const path = commitmentPath(f.space, root.id);
        const recurrence = recurringPath(f, root.id);
        const old = (
            await f.a
                .post(`${recurrence}/occurrences/2026-10-14/disbursements`, {
                    expectedCommitmentVersion: 1,
                    expectedOccurrenceVersion: 1,
                    expectedSpaceVersion: f.context.version,
                    payerMemberId: f.ma,
                    amountInCents: 150000,
                    factDate: currentDate,
                    method: 'PIX',
                    settlement: { mode: 'NONE' },
                })
                .expect(201)
        ).body.occurrence;
        const input = changeInput(f);
        const before = await financeSnapshot(db);
        const preview = (
            await f.a.post(`${path}/change-preview`, input).expect(200)
        ).body;
        expect(preview.requiresAcceptance).toBe(true);
        expect(preview.impactByMember).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    memberId: f.mb,
                    requiresAcceptance: true,
                }),
            ]),
        );
        expect(await financeSnapshot(db)).toEqual(before);
        await f.a.post(`${path}/versions`, input).expect(409);
        expect(await financeSnapshot(db)).toEqual(before);
        const key = randomUUID();
        const proposed = (
            await f.a.post(`${path}/change-proposals`, input, key).expect(201)
        ).body;
        expect(proposed).toMatchObject({
            replayed: false,
            proposal: { version: 1, status: 'PROPOSED' },
        });
        const afterProposal = await financeSnapshot(db);
        expect(
            (await f.a.post(`${path}/change-proposals`, input, key).expect(200))
                .body,
        ).toMatchObject({
            replayed: true,
            proposal: { id: proposed.proposal.id },
        });
        expect(await financeSnapshot(db)).toEqual(afterProposal);
        await f.a
            .post(
                `${path}/change-proposals`,
                { ...input, description: 'Outro reajuste' },
                key,
            )
            .expect(409);
        const novemberBefore = (
            await f.b.agent
                .get(`${recurrence}/occurrences?month=2026-11`)
                .expect(200)
        ).body;
        expect(novemberBefore.items).toMatchObject([
            { amountInCents: 150000, economicVersion: 1 },
        ]);
        expect(novemberBefore.items[0].economicShares).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    memberId: f.ma,
                    amountInCents: 90000,
                }),
                expect.objectContaining({
                    memberId: f.mb,
                    amountInCents: 60000,
                }),
            ]),
        );
        expect(
            (
                await f.b.agent
                    .get(
                        `${financeBase(f.space)}/financial-change-proposals?status=PROPOSED&recipient=ME`,
                    )
                    .expect(200)
            ).body.items,
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: proposed.proposal.id }),
            ]),
        );
        const decision = `${path}/change-proposals/${proposed.proposal.id}/acceptance`;
        const acceptanceKey = randomUUID();
        const accepted = (
            await f.b
                .post(decision, decisionInput(f), acceptanceKey)
                .expect(201)
        ).body;
        expect(accepted.proposal).toMatchObject({
            id: proposed.proposal.id,
            status: 'ACCEPTED',
            version: 2,
        });
        const afterAcceptance = await financeSnapshot(db);
        expect(
            (
                await f.b
                    .post(decision, decisionInput(f), acceptanceKey)
                    .expect(200)
            ).body.replayed,
        ).toBe(true);
        expect(await financeSnapshot(db)).toEqual(afterAcceptance);
        expect(
            (await f.a.agent.get(recurrence).expect(200)).body.commitment,
        ).toMatchObject({
            amountInCents: 150000,
            version: 2,
            currentEconomicVersion: 1,
        });
        const novemberAfter = (
            await f.b.agent
                .get(`${recurrence}/occurrences?month=2026-11`)
                .expect(200)
        ).body.items[0];
        expect(novemberAfter).toMatchObject({
            referenceDate: '2026-11-14',
            amountInCents: 170000,
            economicVersion: 2,
        });
        expect(novemberAfter.economicShares).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    memberId: f.ma,
                    amountInCents: 102000,
                }),
                expect.objectContaining({
                    memberId: f.mb,
                    amountInCents: 68000,
                }),
            ]),
        );
        expect(
            (
                await f.b.agent
                    .get(`${recurrence}/occurrences?month=2026-10`)
                    .expect(200)
            ).body.items[0],
        ).toMatchObject({
            id: old.id,
            amountInCents: 150000,
            economicVersion: 1,
            status: 'FULFILLED',
        });
        currentDate = '2026-11-01';
        expect(
            (await f.b.agent.get(recurrence).expect(200)).body.commitment,
        ).toMatchObject({ amountInCents: 170000, currentEconomicVersion: 2 });
        expect(
            (
                await db.query(
                    'SELECT COUNT(*)::int AS n FROM financial_recurrence_versions WHERE commitment_id=$1',
                    [root.id],
                )
            )[0].n,
        ).toBe(2);
    });

    it('lets only the burdened recipient decide and retains rejected proposal history without changing economics', async () => {
        const f = await sharedFinance(app);
        const outsider = await financeBrowser(app, 'Pessoa externa');
        const root = await createRent(f);
        const path = commitmentPath(f.space, root.id);
        const proposal = (
            await f.a
                .post(`${path}/change-proposals`, {
                    ...changeInput(f),
                    amountInCents: 150000,
                    distribution: distribution(f, 5000, 5000),
                })
                .expect(201)
        ).body.proposal;
        const proposalPath = `${path}/change-proposals/${proposal.id}`;
        const before = await financeSnapshot(db);
        await f.a
            .post(`${proposalPath}/acceptance`, decisionInput(f))
            .expect(403);
        await outsider
            .post(`${proposalPath}/acceptance`, decisionInput(f))
            .expect(404);
        expect(await financeSnapshot(db)).toEqual(before);
        const key = randomUUID();
        const rejected = (
            await f.b
                .post(`${proposalPath}/rejection`, decisionInput(f), key)
                .expect(201)
        ).body;
        expect(rejected.proposal).toMatchObject({
            status: 'REJECTED',
            version: 2,
        });
        expect(
            (
                await f.b
                    .post(`${proposalPath}/rejection`, decisionInput(f), key)
                    .expect(200)
            ).body.replayed,
        ).toBe(true);
        await f.b
            .post(`${proposalPath}/acceptance`, decisionInput(f))
            .expect(409);
        expect(
            (await f.a.agent.get(proposalPath).expect(200)).body.proposal,
        ).toMatchObject({ id: proposal.id, status: 'REJECTED' });
        expect(
            (await f.b.agent.get(`${path}/change-proposals`).expect(200)).body
                .items,
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: proposal.id,
                    status: 'REJECTED',
                }),
            ]),
        );
        expect(
            (
                await f.b.agent
                    .get(
                        `${financeBase(f.space)}/financial-change-proposals?status=PROPOSED&recipient=ME`,
                    )
                    .expect(200)
            ).body.items,
        ).toEqual([]);
        expect(
            (await f.b.agent.get(recurringPath(f, root.id)).expect(200)).body
                .commitment,
        ).toMatchObject({ version: 1, amountInCents: 150000 });
    });

    it('serializes competing acceptance and rejection into one decision and one economic result', async () => {
        const f = await sharedFinance(app);
        const root = await createRent(f);
        const path = commitmentPath(f.space, root.id);
        const proposal = (
            await f.a
                .post(`${path}/change-proposals`, changeInput(f))
                .expect(201)
        ).body.proposal;
        const proposalPath = `${path}/change-proposals/${proposal.id}`;
        const results = await competingFinanceCommands(db, f.space, () =>
            Promise.all([
                f.b.post(`${proposalPath}/acceptance`, decisionInput(f)),
                f.b.post(`${proposalPath}/rejection`, decisionInput(f)),
            ]),
        );
        expect(results.map((response) => response.status).sort()).toEqual([
            201, 409,
        ]);
        const winner = results.find((response) => response.status === 201)!.body
            .proposal;
        expect(
            (await f.b.agent.get(proposalPath).expect(200)).body.proposal,
        ).toMatchObject({ status: winner.status, version: 2 });
        expect(
            (
                await db.query(
                    'SELECT COUNT(*)::int AS n FROM financial_recurrence_versions WHERE commitment_id=$1',
                    [root.id],
                )
            )[0].n,
        ).toBe(winner.status === 'ACCEPTED' ? 2 : 1);
    });

    it('rejects proposals made obsolete by a new version, intervening realization or a past effective date', async () => {
        const f = await sharedFinance(app);
        for (const conflict of ['VERSION', 'REALIZATION', 'DATE']) {
            const root = await createRent(f);
            const path = commitmentPath(f.space, root.id);
            const recurrence = recurringPath(f, root.id);
            const proposal = (
                await f.a
                    .post(`${path}/change-proposals`, changeInput(f))
                    .expect(201)
            ).body.proposal;
            if (conflict === 'VERSION')
                await f.a
                    .post(`${path}/versions`, {
                        ...changeInput(f),
                        amountInCents: 140000,
                    })
                    .expect(201);
            if (conflict === 'REALIZATION')
                await f.a
                    .post(
                        `${recurrence}/occurrences/2026-11-14/disbursements`,
                        {
                            expectedCommitmentVersion: 1,
                            expectedOccurrenceVersion: 1,
                            expectedSpaceVersion: f.context.version,
                            payerMemberId: f.ma,
                            amountInCents: 1000,
                            factDate: currentDate,
                            method: 'PIX',
                            settlement: { mode: 'NONE' },
                        },
                    )
                    .expect(201);
            if (conflict === 'DATE') currentDate = '2026-11-02';
            const before = await financeSnapshot(db);
            await f.b
                .post(`${path}/change-proposals/${proposal.id}/acceptance`, {
                    ...decisionInput(f),
                    expectedCommitmentVersion: conflict === 'VERSION' ? 2 : 1,
                })
                .expect(409);
            expect(await financeSnapshot(db)).toEqual(before);
            currentDate = '2026-10-14';
        }
    });

    it('keeps variable value updates and non-onerous legacy maintenance independent from structural consent', async () => {
        const f = await sharedFinance(app);
        const base = `${financeBase(f.space)}/recurring-commitments`;
        const root = (
            await f.a
                .post(base, {
                    ...recurringInput(f),
                    amountInCents: undefined,
                    valueMode: 'VARIABLE',
                    expectedAmountInCents: 150000,
                })
                .expect(201)
        ).body.commitment;
        const path = commitmentPath(f.space, root.id);
        const change = {
            ...changeInput(f),
            valueMode: 'VARIABLE',
            amountInCents: undefined,
            expectedAmountInCents: 170000,
        };
        expect(
            (await f.a.post(`${path}/change-preview`, change).expect(200)).body
                .requiresAcceptance,
        ).toBe(false);
        await f.a.post(`${base}/${root.id}/versions`, change).expect(201);
        const value = (
            await f.a
                .put(`${base}/${root.id}/occurrences/2026-11-14/value`, {
                    expectedCommitmentVersion: 2,
                    expectedOccurrenceVersion: 1,
                    expectedSpaceVersion: f.context.version,
                    amountInCents: 200000,
                })
                .expect(200)
        ).body;
        expect(value.occurrence).toMatchObject({ amountInCents: 200000 });
        expect(
            (await f.b.agent.get(`${path}/change-proposals`).expect(200)).body
                .items,
        ).toEqual([]);
        const structural = {
            ...change,
            expectedCommitmentVersion: 2,
            effectiveFrom: '2026-12-01',
            distribution: distribution(f, 5000, 5000),
        };
        expect(
            (await f.a.post(`${path}/change-preview`, structural).expect(200))
                .body.requiresAcceptance,
        ).toBe(true);
        await f.a.post(`${base}/${root.id}/versions`, structural).expect(409);
        await f.a.post(`${path}/change-proposals`, structural).expect(201);
    });

    it('requires consent for a larger annual occurrence even when its aggregate exposure is lower', async () => {
        const f = await sharedFinance(app);
        const root = await createRent(f);
        const path = commitmentPath(f.space, root.id);
        const input = {
            ...changeInput(f),
            recurrence: {
                frequency: 'ANNUAL',
                monthOfYear: 12,
                dayOfMonth: 14,
            },
        };
        const before = await financeSnapshot(db);
        const preview = (
            await f.a.post(`${path}/change-preview`, input).expect(200)
        ).body;
        expect(preview.proposedOccurrences).toContain('2026-12-14');
        expect(preview.requiresAcceptance).toBe(true);
        const recipient = preview.impactByMember.find(
            (member: { memberId: string }) => member.memberId === f.mb,
        );
        expect(recipient.requiresAcceptance).toBe(true);
        expect(BigInt(recipient.fixedDeltaInCents) < 0n).toBe(true);
        expect(await financeSnapshot(db)).toEqual(before);
        await f.a.post(`${path}/versions`, input).expect(409);
        expect(await financeSnapshot(db)).toEqual(before);
        const proposed = (
            await f.a.post(`${path}/change-proposals`, input).expect(201)
        ).body;
        expect(proposed.proposal).toMatchObject({
            status: 'PROPOSED',
            recipientMemberId: f.mb,
        });
    });

    it('requires the member losing shared income to accept even when the total income stays unchanged', async () => {
        const f = await sharedFinance(app);
        const root = (
            await f.a
                .post(`${financeBase(f.space)}/recurring-commitments`, {
                    ...recurringInput(f),
                    kind: 'INCOME',
                    description: 'Renda compartilhada',
                })
                .expect(201)
        ).body.commitment;
        const path = commitmentPath(f.space, root.id);
        const input = {
            ...changeInput(f),
            kind: 'INCOME',
            description: 'Renda compartilhada',
            amountInCents: 150000,
            distribution: distribution(f, 7000, 3000),
        };
        const preview = (
            await f.a.post(`${path}/change-preview`, input).expect(200)
        ).body;
        expect(preview.requiresAcceptance).toBe(true);
        expect(preview.impactByMember).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    memberId: f.mb,
                    requiresAcceptance: true,
                }),
                expect.objectContaining({
                    memberId: f.ma,
                    requiresAcceptance: false,
                }),
            ]),
        );
        await f.a.post(`${path}/versions`, input).expect(409);
        const proposal = (
            await f.a.post(`${path}/change-proposals`, input).expect(201)
        ).body.proposal;
        await f.b
            .post(
                `${path}/change-proposals/${proposal.id}/acceptance`,
                decisionInput(f),
            )
            .expect(201);
        const future = (
            await f.b.agent
                .get(`${recurringPath(f, root.id)}/occurrences?month=2026-11`)
                .expect(200)
        ).body.items[0];
        expect(future.economicShares).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    memberId: f.mb,
                    amountInCents: 45000,
                }),
            ]),
        );
    });

    it('accepts an onerous planned expense change and targets only selected future installments', async () => {
        const f = await sharedFinance(app);
        const base = financeBase(f.space);
        const planned = (
            await f.a
                .post(`${base}/planned-expenses`, {
                    scope: 'SHARED',
                    description: 'Reserva',
                    amountInCents: 150000,
                    expectedPaymentDate: '2026-11-14',
                    expectedSpaceVersion: f.context.version,
                    expectedPayerMemberId: f.ma,
                    responsibilitySplit: distribution(f),
                })
                .expect(201)
        ).body.commitment;
        const plannedPath = commitmentPath(f.space, planned.id);
        const input = {
            scope: 'SHARED',
            kind: 'EXPENSE',
            description: 'Reserva maior',
            amountInCents: 170000,
            effectiveFrom: '2026-11-01',
            expectedCommitmentVersion: 1,
            expectedSpaceVersion: f.context.version,
            expectedMemberId: f.ma,
            distribution: distribution(f),
        };
        const proposal = (
            await f.a.post(`${plannedPath}/change-proposals`, input).expect(201)
        ).body.proposal;
        await f.b
            .post(
                `${plannedPath}/change-proposals/${proposal.id}/acceptance`,
                decisionInput(f),
            )
            .expect(201);
        currentDate = '2026-11-01';
        expect(
            (await f.b.agent.get(plannedPath).expect(200)).body.commitment,
        ).toMatchObject({ amountInCents: 170000, version: 2 });
        currentDate = '2026-10-14';
        const installmentBase = `${base}/installment-commitments`;
        const plan = (
            await f.a
                .post(installmentBase, {
                    scope: 'SHARED',
                    description: 'Móveis',
                    count: 2,
                    explicitDueDates: ['2026-10-20', '2026-11-20'],
                    amountsInCents: [150000, 150000],
                    distribution: distribution(f),
                    expectedMemberId: f.ma,
                    expectedSpaceVersion: f.context.version,
                    expectedRuleVersion: 0,
                })
                .expect(201)
        ).body.commitment;
        const planPath = commitmentPath(f.space, plan.id);
        const selected = plan.plan.installments[1].id as string;
        const parcelProposal = (
            await f.a
                .post(`${planPath}/change-proposals`, {
                    ...input,
                    description: 'Móveis',
                    amountInCents: 150000,
                    distribution: distribution(f, 5000, 5000),
                    installmentIds: [selected],
                })
                .expect(201)
        ).body.proposal;
        await f.b
            .post(
                `${planPath}/change-proposals/${parcelProposal.id}/acceptance`,
                decisionInput(f),
            )
            .expect(201);
        const beforeEffectiveDate = (
            await f.b.agent
                .get(`${installmentBase}/${plan.id}/installments`)
                .expect(200)
        ).body.items;
        expect(beforeEffectiveDate[1].economicShares).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    memberId: f.mb,
                    amountInCents: 60000,
                }),
            ]),
        );
        const futureHistory = (
            await f.b.agent.get(`${planPath}/versions`).expect(200)
        ).body;
        expect(futureHistory).toMatchObject({
            commitmentId: plan.id,
            version: 2,
            nextVersions: [{ targetId: selected, effectiveFrom: '2026-11-01' }],
        });
        expect(futureHistory.currentVersions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ targetId: selected, version: null }),
            ]),
        );
        currentDate = '2026-11-01';
        const parcels = (
            await f.b.agent
                .get(`${installmentBase}/${plan.id}/installments`)
                .expect(200)
        ).body.items;
        expect(parcels[0].economicShares).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    memberId: f.mb,
                    amountInCents: 60000,
                }),
            ]),
        );
        expect(parcels[1].economicShares).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    memberId: f.mb,
                    amountInCents: 75000,
                }),
            ]),
        );
        const activeHistory = (
            await f.b.agent.get(`${planPath}/versions`).expect(200)
        ).body;
        expect(activeHistory.nextVersions).toEqual([]);
        expect(activeHistory.currentVersions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    targetId: selected,
                    version: expect.objectContaining({ version: 2 }),
                }),
            ]),
        );
    });

    it('reapplies the empty migration and blocks destructive rollback after a proposal is recorded', async () => {
        await migrationSource.initialize();
        try {
            await rewindFinanceMigrationsTo(
                migrationSource,
                'CommitmentChanges1792250149185',
            );
            await migrationSource.undoLastMigration();
            for (const table of [
                'financial_commitment_change_proposals',
                'financial_integrity_command_receipts',
                'financial_non_recurring_versions',
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
                'financial_commitment_change_proposals',
                'financial_integrity_command_receipts',
                'financial_non_recurring_versions',
            ])
                expect(
                    (
                        await migrationSource.query(
                            'SELECT to_regclass($1) AS relation',
                            [table],
                        )
                    )[0].relation,
                ).toBe(table);
            const f = await sharedFinance(app);
            const root = await createRent(f);
            const path = commitmentPath(f.space, root.id);
            const proposal = (
                await f.a
                    .post(`${path}/change-proposals`, changeInput(f))
                    .expect(201)
            ).body.proposal;
            await rewindFinanceMigrationsTo(
                migrationSource,
                'CommitmentChanges1792250149185',
            );
            const before = await financeSnapshot(db);
            await expect(migrationSource.undoLastMigration()).rejects.toThrow(
                'Cannot revert commitment changes',
            );
            expect(await financeSnapshot(db)).toEqual(before);
            expect(
                (
                    await f.b.agent
                        .get(`${path}/change-proposals/${proposal.id}`)
                        .expect(200)
                ).body.proposal,
            ).toMatchObject({
                id: proposal.id,
                status: 'PROPOSED',
                version: 1,
            });
        } finally {
            await migrationSource.runMigrations();
            await migrationSource.destroy();
        }
    });

    it('rolls back proposal decision and economic version when its audit cannot be recorded', async () => {
        const f = await sharedFinance(app);
        const root = await createRent(f);
        const path = commitmentPath(f.space, root.id);
        const proposal = (
            await f.a
                .post(`${path}/change-proposals`, changeInput(f))
                .expect(201)
        ).body.proposal;
        const decision = `${path}/change-proposals/${proposal.id}/acceptance`;
        const before = await financeSnapshot(db);
        await db.query(
            'ALTER TABLE financial_command_audit ADD CONSTRAINT test_card_030_audit_failure CHECK (false) NOT VALID',
        );
        try {
            await f.b.post(decision, decisionInput(f)).expect(500);
            expect(await financeSnapshot(db)).toEqual(before);
        } finally {
            await db.query(
                'ALTER TABLE financial_command_audit DROP CONSTRAINT test_card_030_audit_failure',
            );
        }
        expect(
            (await f.b.post(decision, decisionInput(f)).expect(201)).body
                .proposal,
        ).toMatchObject({ status: 'ACCEPTED', version: 2 });
    });
});
