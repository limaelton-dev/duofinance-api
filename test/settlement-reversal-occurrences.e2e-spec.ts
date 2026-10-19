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
    financeBase,
    financeSnapshot,
    sharedFinance,
    type SharedFinance,
} from './settlement-fixture.js';

type Obligation = {
    id: string;
    occurrence_id: string;
    version: number;
    debtor_member_id: string;
    creditor_member_id: string;
    remaining_amount_in_cents: string;
    recognized_amount_in_cents: string;
};
type Preview = {
    allocations: { id: string; amountInCents: number }[];
    obligations: { id: string; version: number; occurrenceId: string }[];
    cycles: { id: string; version: number }[];
    impact: {
        occurrenceId: string;
        debtorMemberId: string;
        creditorMemberId: string;
        remainingAmountInCents: number;
    }[];
};

describe('Settlement reversals preserve recurring and installment sources HTTP/PostgreSQL', () => {
    let app: INestApplication<Server>, db: DataSource;
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
            .useValue({ now: () => instant, today: () => '2026-10-14' })
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

    async function sources(
        f: SharedFinance,
        modality: 'RECURRING' | 'INSTALLMENT',
    ) {
        const recurring = modality === 'RECURRING';
        const base = `${financeBase(f.space)}/${recurring ? 'recurring' : 'installment'}-commitments`;
        const root = (
            await f.a
                .post(base, {
                    scope: 'SHARED',
                    description: 'Despesa por ocorrência',
                    expectedSpaceVersion: f.context.version,
                    distribution: {
                        mode: 'AMOUNTS',
                        shares: [f.ma, f.mb].map((memberId) => ({
                            memberId,
                            amountInCents: recurring ? 5000 : 10000,
                        })),
                    },
                    ...(recurring
                        ? {
                              kind: 'EXPENSE',
                              amountInCents: 10000,
                              recurrence: {
                                  frequency: 'MONTHLY',
                                  dayOfMonth: 14,
                              },
                              startsOn: '2026-09-01',
                          }
                        : {
                              count: 2,
                              explicitDueDates: ['2026-09-14', '2026-10-14'],
                              amountsInCents: [10000, 10000],
                              expectedRuleVersion: 0,
                          }),
                })
                .expect(201)
        ).body.commitment;
        const paths: string[] = recurring
            ? ['2026-09-14', '2026-10-14'].map(
                  (date) => `${base}/${root.id}/occurrences/${date}`,
              )
            : root.plan.installments.map(
                  (item: { id: string }) =>
                      `${base}/${root.id}/installments/${item.id}`,
              );
        return {
            root,
            pay: async (index: number, payerMemberId: string) => {
                const detail = (
                    await f.a.agent.get(`${base}/${root.id}`).expect(200)
                ).body;
                const previous: Obligation[] = await db.query(
                    'SELECT * FROM inter_member_obligations WHERE commitment_id=$1',
                    [root.id],
                );
                await f.a
                    .post(`${paths[index]}/disbursements`, {
                        expectedSpaceVersion: f.context.version,
                        expectedCommitmentVersion: detail.commitment.version,
                        ...(recurring
                            ? { expectedOccurrenceVersion: 1 }
                            : { expectedInstallmentVersion: 1 }),
                        amountInCents: 10000,
                        factDate: index === 0 ? '2026-09-14' : '2026-10-14',
                        method: 'PIX',
                        payerMemberId,
                        settlement: { mode: 'NONE' },
                    })
                    .expect(201);
                const current: Obligation[] = await db.query(
                    'SELECT * FROM inter_member_obligations WHERE commitment_id=$1',
                    [root.id],
                );
                const created = current.filter(
                    (o) => !previous.some((p) => p.id === o.id),
                );
                expect(created).toHaveLength(1);
                return created[0];
            },
        };
    }

    async function transfer(f: SharedFinance, rows: Obligation[]) {
        return (
            await f.a
                .post(`${financeBase(f.space)}/settlement-transfers`, {
                    expectedSpaceVersion: f.context.version,
                    factDate: '2026-10-14',
                    payerMemberId: f.mb,
                    recipientMemberId: f.ma,
                    amountInCents: rows.length * 5000,
                    allocations: rows.map((o) => ({
                        obligationId: o.id,
                        amountInCents: 5000,
                        expectedObligationVersion: o.version,
                    })),
                })
                .expect(201)
        ).body.transfer.id as string;
    }

    for (const modality of ['RECURRING', 'INSTALLMENT'] as const) {
        it.each(['TRANSFER', 'OFFSET', 'BATCH_TRANSFER'] as const)(
            `${modality}: reverses %s within each source and preserves independent debts`,
            async (mode) => {
                const f = await sharedFinance(app);
                const source = await sources(f, modality);
                const first = await source.pay(0, f.ma);
                let originalId: string | undefined;
                if (mode === 'TRANSFER')
                    originalId = await transfer(f, [first]);
                const second = await source.pay(
                    1,
                    mode === 'BATCH_TRANSFER' ? f.ma : f.mb,
                );
                expect(second.occurrence_id).not.toBe(first.occurrence_id);
                if (mode === 'BATCH_TRANSFER')
                    originalId = await transfer(f, [first, second]);
                if (mode === 'OFFSET') {
                    originalId = (
                        await f.a
                            .post(
                                `${financeBase(f.space)}/settlement-offsets`,
                                {
                                    expectedSpaceVersion: f.context.version,
                                    factDate: '2026-10-14',
                                    scope: {
                                        cycleIds: [],
                                        obligationIds: [first.id, second.id],
                                    },
                                    expectedCycleVersions: [],
                                    allocations: [first, second].map((o) => ({
                                        obligationId: o.id,
                                        expectedObligationVersion: o.version,
                                        amountInCents: 5000,
                                    })),
                                },
                            )
                            .expect(201)
                    ).body.offset.id;
                }
                const path = `${financeBase(f.space)}/settlement-${mode === 'OFFSET' ? 'offsets' : 'transfers'}/${originalId}`;
                const snapshot = await financeSnapshot(db);
                const preview: Preview = (
                    await f.a.agent.get(`${path}/reversal-options`).expect(200)
                ).body;
                expect(await financeSnapshot(db)).toEqual(snapshot);
                const affected =
                    mode === 'TRANSFER' ? [first] : [first, second];
                expect(preview.obligations.map((o) => o.id).sort()).toEqual(
                    affected.map((o) => o.id).sort(),
                );
                expect(preview.impact).toHaveLength(affected.length);
                for (const o of affected)
                    expect(preview.impact).toContainEqual(
                        expect.objectContaining({
                            occurrenceId: o.occurrence_id,
                            debtorMemberId: o.debtor_member_id,
                            creditorMemberId: o.creditor_member_id,
                            remainingAmountInCents: 5000,
                        }),
                    );
                const input = {
                    expectedSpaceVersion: f.context.version,
                    factDate: '2026-10-14',
                    expectedObligationVersions: preview.obligations.map(
                        (o) => ({ obligationId: o.id, version: o.version }),
                    ),
                    expectedCycleVersions: preview.cycles.map((c) => ({
                        cycleId: c.id,
                        version: c.version,
                    })),
                    applications: preview.allocations.map((a) => ({
                        allocationId: a.id,
                        amountInCents: a.amountInCents,
                    })),
                };
                await f.a
                    .post(`${path}/reversals`, {
                        ...input,
                        expectedObligationVersions:
                            input.expectedObligationVersions.map((o) => ({
                                ...o,
                                version: o.version + 1,
                            })),
                    })
                    .expect(409);
                expect(await financeSnapshot(db)).toEqual(snapshot);
                const key = randomUUID();
                const result = (
                    await f.a.post(`${path}/reversals`, input, key).expect(201)
                ).body;
                expect(
                    result.effects
                        .map((o: { obligationId: string }) => o.obligationId)
                        .sort(),
                ).toEqual(affected.map((o) => o.id).sort());
                const rows: Obligation[] = await db.query(
                    'SELECT * FROM inter_member_obligations WHERE commitment_id=$1 ORDER BY id',
                    [source.root.id],
                );
                expect(rows).toHaveLength(2);
                for (const original of [first, second]) {
                    const row = rows.find((o) => o.id === original.id)!;
                    expect(row).toMatchObject({
                        occurrence_id: original.occurrence_id,
                        debtor_member_id: original.debtor_member_id,
                        creditor_member_id: original.creditor_member_id,
                        remaining_amount_in_cents: '5000',
                        recognized_amount_in_cents: '5000',
                    });
                }
                if (mode === 'TRANSFER')
                    expect(rows.find((o) => o.id === second.id)).toEqual(
                        second,
                    );
                expect(
                    (
                        await db.query(
                            'SELECT count(*)::int AS n FROM settlement_offsets',
                        )
                    )[0].n,
                ).toBe(mode === 'OFFSET' ? 1 : 0);
                const after = await financeSnapshot(db);
                const replay = (
                    await f.a.post(`${path}/reversals`, input, key).expect(200)
                ).body;
                expect(replay).toMatchObject({
                    reversal: result.reversal,
                    replayed: true,
                });
                expect(await financeSnapshot(db)).toEqual(after);
            },
        );
    }
});
