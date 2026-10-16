import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
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
import { SETTLEMENT_ADJUSTMENT_REPOSITORY } from '../dist/modules/finances/application/ports/private/settlement-adjustment.repository.js';
import type { TypeOrmSettlementAdjustmentRepository } from '../dist/modules/finances/infrastructure/typeorm/repositories/typeorm-settlement-adjustment.repository.js';
import {
    commitmentPath,
    financeBase,
    financeBrowser,
    financeSnapshot,
    obligationPath,
    sharedExpenseInput,
    sharedFinance,
    type SharedFinance,
} from './settlement-fixture.js';

describe('CARD-018 specific rules and assignments HTTP/PostgreSQL', () => {
    let app: INestApplication<Server>, db: DataSource, today: string;

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
                now: () => new Date(today + 'T15:00:00Z'),
                today: () => today,
            })
            .compile();
        app = module.createNestApplication();
        configureApp(app);
        await app.init();
        db = app.get(DataSource);
        await db.query('TRUNCATE persons CASCADE');
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        if (migrationSource.isInitialized) {
            await migrationSource.runMigrations();
            await migrationSource.destroy();
        }
        await app?.close();
    });

    const rulePath = (f: SharedFinance, id: string) =>
        `${commitmentPath(f.space, id)}/settlement-rule`;
    const assignmentPath = (f: SharedFinance, id: string) =>
        `${obligationPath(f.space, id)}/settlement-assignment`;
    const ruleBody = (f: SharedFinance, version = 1, day = 31) => ({
        expectedSpaceVersion: f.context.version,
        expectedCommitmentVersion: version,
        rule: { kind: 'MONTHLY_DAY', dayOfMonth: day },
    });
    const assignmentBody = (
        f: SharedFinance,
        version: number,
        settlement: object,
        cycles: { id: string; version: number }[] = [],
    ) => ({
        expectedSpaceVersion: f.context.version,
        expectedObligationVersion: version,
        expectedCycleVersions: cycles.map(({ id, version }) => ({
            cycleId: id,
            version,
        })),
        settlement,
    });
    const expense = async (
        f: SharedFinance,
        paid = 40000,
        settlement: object = { mode: 'NONE' },
    ) =>
        (
            await f.a
                .post(
                    `${financeBase(f.space)}/shared-cash-expenses`,
                    sharedExpenseInput(f, 50000, paid, settlement),
                )
                .expect(201)
        ).body;
    const options = async (f: SharedFinance, id: string) =>
        (
            await f.a.agent
                .get(`${obligationPath(f.space, id)}/settlement-options`)
                .expect(200)
        ).body;
    const obligation = async (id: string) =>
        (
            await db.query(
                'SELECT * FROM inter_member_obligations WHERE id=$1',
                [id],
            )
        )[0];
    async function cycle(f: SharedFinance, date: string, finalized = false) {
        const id = randomUUID();
        await db.query(
            'INSERT INTO settlement_cycles(id,space_id,target_date,status,version,finalized_at) VALUES($1,$2,$3,$4,1,$5)',
            [
                id,
                f.space,
                date,
                finalized ? 'FINALIZED' : 'OPEN',
                finalized ? new Date(today + 'T15:00:00Z') : null,
            ],
        );
        return { id, version: 1, targetDate: date };
    }

    it.each(['expense', 'income', 'card'] as const)(
        'keeps inherited snapshots and economic history when %s receives a specific rule and a later realization',
        async (kind) => {
            const f = await sharedFinance(app);
            await f.a
                .put(`${financeBase(f.space)}/default-settlement-rule`, {
                    expectedVersion: 0,
                    rule: { kind: 'MONTHLY_DAY', dayOfMonth: 20 },
                })
                .expect(200);
            const input = sharedExpenseInput(f, 50000, 10000);
            const initial = (
                await f.a
                    .post(
                        `${financeBase(f.space)}/${
                            kind === 'expense'
                                ? 'shared-cash-expenses'
                                : kind === 'income'
                                  ? 'incomes'
                                  : 'credit-card-purchases'
                        }`,
                        kind === 'income'
                            ? {
                                  description: 'Receita compartilhada',
                                  amountInCents: 50000,
                                  expectedReceiptDate: '2026-10-20',
                                  expectedRecipientMemberId: f.ma,
                                  expectedSpaceVersion: f.context.version,
                                  participationSplit: input.responsibilitySplit,
                                  receipt: {
                                      recipientMemberId: f.ma,
                                      amountInCents: 10000,
                                      factDate: '2026-10-14',
                                      settlement: { mode: 'NONE' },
                                  },
                              }
                            : kind === 'card'
                              ? {
                                    description: input.description,
                                    amountInCents: input.amountInCents,
                                    factDate: input.factDate,
                                    expectedSpaceVersion:
                                        input.expectedSpaceVersion,
                                    responsibilitySplit:
                                        input.responsibilitySplit,
                                    externalLiability: {
                                        holderMemberId: f.ma,
                                        amountInCents: 10000,
                                    },
                                    settlement: { mode: 'NONE' },
                                }
                              : input,
                    )
                    .expect(201)
            ).body;
            const id = initial.commitment.id as string;
            const initialVersion = initial.commitment.version as number;
            const specificVersion = initialVersion + 1;
            const previous = await financeSnapshot(db);
            const key = randomUUID();
            const changed = (
                await f.b
                    .put(rulePath(f, id), ruleBody(f, initialVersion), key)
                    .expect(200)
            ).body;
            expect(changed).toMatchObject({
                commitmentId: id,
                commitmentVersion: specificVersion,
                settlementRule: {
                    source: 'SPECIFIC',
                    rule: { kind: 'MONTHLY_DAY', dayOfMonth: 31 },
                    version: specificVersion,
                    suggestedTargetDate: '2026-10-31',
                },
                affectedCycleIds: [],
                replayed: false,
            });
            const afterRule = await financeSnapshot(db);
            for (const table of [
                'financial_disbursements',
                'financial_receipts',
                'financial_external_liabilities',
                'financial_commitment_shares',
                'financial_income_shares',
                'inter_member_obligations',
                'settlement_cycles',
            ])
                expect(afterRule[table]).toEqual(previous[table]);
            const replay = await f.b
                .put(rulePath(f, id), ruleBody(f, initialVersion), key)
                .expect(200);
            expect(replay.body).toEqual({ ...changed, replayed: true });
            expect(await financeSnapshot(db)).toEqual(afterRule);
            await f.a
                .put(`${financeBase(f.space)}/default-settlement-rule`, {
                    expectedVersion: 1,
                    rule: { kind: 'MONTHLY_DAY', dayOfMonth: 15 },
                })
                .expect(200);
            const subresource =
                kind === 'expense'
                    ? 'disbursement'
                    : kind === 'income'
                      ? 'receipt'
                      : 'external-liability';
            const nextOptions = (
                await f.a.agent
                    .get(
                        `${commitmentPath(f.space, id)}/${subresource}-options`,
                    )
                    .expect(200)
            ).body;
            expect(nextOptions).toMatchObject({
                defaultSettlementRule: {
                    rule: { kind: 'MONTHLY_DAY', dayOfMonth: 20 },
                },
                settlementRule: {
                    source: 'SPECIFIC',
                    rule: { kind: 'MONTHLY_DAY', dayOfMonth: 31 },
                    version: specificVersion,
                },
                suggestedTargetDate: '2026-10-31',
            });
            const later = (
                await f.a
                    .post(
                        `${commitmentPath(f.space, id)}/${
                            kind === 'card'
                                ? 'external-liabilities'
                                : subresource + 's'
                        }`,
                        {
                            expectedCommitmentVersion: specificVersion,
                            expectedSpaceVersion: f.context.version,
                            amountInCents: 30000,
                            factDate: '2026-10-14',
                            ...(kind === 'expense'
                                ? { payerMemberId: f.ma, method: 'PIX' }
                                : kind === 'income'
                                  ? { recipientMemberId: f.ma }
                                  : { holderMemberId: f.ma }),
                            settlement: {
                                mode: 'SUGGESTED',
                                referenceDate: nextOptions.referenceDate,
                                expectedRuleVersion: specificVersion,
                            },
                        },
                    )
                    .expect(201)
            ).body;
            expect(later.commitment.version).toBe(specificVersion + 1);
            if (kind === 'income') {
                expect(later.settlementCycle).toBeNull();
                expect(later.obligation.remainingAmountInCents).toBe(16000);
            } else expect(later.settlementCycle.targetDate).toBe('2026-10-31');
            expect(later.commitment.settlementRuleSnapshot).toEqual(
                initial.commitment.settlementRuleSnapshot,
            );
            const facts = await db.query(
                `SELECT sequence FROM ${
                    kind === 'expense'
                        ? 'financial_disbursements'
                        : kind === 'income'
                          ? 'financial_receipts'
                          : 'financial_external_liabilities'
                } WHERE commitment_id=$1 ORDER BY sequence`,
                [id],
            );
            expect(facts).toEqual([{ sequence: 1 }, { sequence: 2 }]);
            const detail = (
                await f.a.agent.get(commitmentPath(f.space, id)).expect(200)
            ).body;
            expect(detail.commitment.amountInCents).toBe(50000);
            expect(detail.commitment.settlementRule).toMatchObject({
                source: 'SPECIFIC',
                rule: { kind: 'MONTHLY_DAY', dayOfMonth: 31 },
                version: specificVersion,
            });
            expect(detail.commitment.settlementRuleSnapshot).toEqual(
                initial.commitment.settlementRuleSnapshot,
            );
            const secondRule = (
                await f.a
                    .put(rulePath(f, id), ruleBody(f, specificVersion + 1, 10))
                    .expect(200)
            ).body;
            expect(secondRule.commitmentVersion).toBe(specificVersion + 2);
            expect(secondRule.settlementRule.version).toBe(specificVersion + 2);
            const ruleHistory = await db.query(
                'SELECT * FROM financial_commitment_settlement_rule_changes WHERE commitment_id=$1 ORDER BY version',
                [id],
            );
            expect(ruleHistory).toHaveLength(2);
            expect(ruleHistory[0]).toMatchObject({
                version: specificVersion,
                actor_id: f.b.context.person.id,
                previous_rule: null,
                rule: { kind: 'MONTHLY_DAY', dayOfMonth: 31 },
            });
            expect(ruleHistory[1]).toMatchObject({
                version: specificVersion + 2,
                actor_id: f.a.context.person.id,
                previous_rule: { kind: 'MONTHLY_DAY', dayOfMonth: 31 },
                rule: { kind: 'MONTHLY_DAY', dayOfMonth: 10 },
            });
            expect(ruleHistory[0].registered_at).toBeInstanceOf(Date);
        },
    );

    it('uses the specific income rule when the first receipt creates a new obligation', async () => {
        const f = await sharedFinance(app);
        const initial = (
            await f.a
                .post(`${financeBase(f.space)}/incomes`, {
                    description: 'Receita ainda não recebida',
                    amountInCents: 50000,
                    expectedReceiptDate: '2026-10-20',
                    expectedRecipientMemberId: f.ma,
                    expectedSpaceVersion: f.context.version,
                    participationSplit:
                        sharedExpenseInput(f).responsibilitySplit,
                    receipt: null,
                })
                .expect(201)
        ).body;
        await f.a
            .put(rulePath(f, initial.commitment.id), ruleBody(f))
            .expect(200);
        const receiptOptions = (
            await f.a.agent
                .get(
                    `${commitmentPath(f.space, initial.commitment.id)}/receipt-options`,
                )
                .expect(200)
        ).body;
        const realized = (
            await f.a
                .post(
                    `${commitmentPath(f.space, initial.commitment.id)}/receipts`,
                    {
                        expectedCommitmentVersion: 2,
                        expectedSpaceVersion: f.context.version,
                        amountInCents: 10000,
                        factDate: '2026-10-14',
                        recipientMemberId: f.ma,
                        settlement: {
                            mode: 'SUGGESTED',
                            referenceDate: receiptOptions.referenceDate,
                            expectedRuleVersion: 2,
                        },
                    },
                )
                .expect(201)
        ).body;
        expect(realized.settlementCycle.targetDate).toBe('2026-10-31');
        expect(realized.obligation.remainingAmountInCents).toBe(4000);
        expect(realized.commitment.version).toBe(3);
        expect(
            await db.query(
                'SELECT sequence FROM financial_receipts WHERE commitment_id=$1',
                [initial.commitment.id],
            ),
        ).toEqual([{ sequence: 1 }]);
    });

    it.each([
        ['2027-02-01', '2027-02-28'],
        ['2028-02-01', '2028-02-29'],
        ['2027-04-30', '2027-04-30'],
    ])(
        'suggests day 31 on %s as %s without creating a cycle',
        async (date, target) => {
            today = date;
            const f = await sharedFinance(app);
            const initial = await expense(f);
            const result = (
                await f.a
                    .put(rulePath(f, initial.commitment.id), ruleBody(f))
                    .expect(200)
            ).body;
            expect(result.settlementRule.suggestedTargetDate).toBe(target);
            expect(await db.query('SELECT * FROM settlement_cycles')).toEqual(
                [],
            );
            expect(
                (await obligation(initial.obligation.id)).cycle_id,
            ).toBeNull();
        },
    );

    it('moves only the remainder while preserving historical allocations and future reconciliation', async () => {
        const f = await sharedFinance(app);
        const initial = await expense(f, 40000, {
            mode: 'DATE',
            targetDate: '2026-10-20',
        });
        const oldCycle = initial.settlementCycle;
        await f.a
            .post(`${financeBase(f.space)}/settlement-transfers`, {
                expectedSpaceVersion: f.context.version,
                payerMemberId: f.mb,
                recipientMemberId: f.ma,
                amountInCents: 1000,
                factDate: '2026-10-14',
                allocations: [
                    {
                        obligationId: initial.obligation.id,
                        expectedObligationVersion: 1,
                        amountInCents: 1000,
                    },
                ],
            })
            .expect(201);
        const before = await obligation(initial.obligation.id);
        const allocations = await db.query(
            'SELECT * FROM settlement_allocations',
        );
        const financialFacts = await db.query(
            'SELECT * FROM financial_disbursements',
        );
        const available = await options(f, initial.obligation.id);
        expect(available.currentCycle.id).toBe(oldCycle.id);
        const target = await cycle(f, '2026-10-31');
        const key = randomUUID();
        const body = assignmentBody(
            f,
            before.version,
            { mode: 'CYCLE', cycleId: target.id },
            [available.currentCycle, target],
        );
        const result = (
            await f.b
                .post(assignmentPath(f, initial.obligation.id), body, key)
                .expect(200)
        ).body;
        expect(result).toMatchObject({
            obligation: {
                id: initial.obligation.id,
                cycleId: target.id,
                version: before.version + 1,
                remainingAmountInCents: Number(
                    before.remaining_amount_in_cents,
                ),
            },
            replayed: false,
        });
        expect(result.affectedCycleIds.sort()).toEqual(
            [oldCycle.id, target.id].sort(),
        );
        const moved = await obligation(initial.obligation.id);
        expect(moved).toEqual({
            ...before,
            cycle_id: target.id,
            version: before.version + 1,
        });
        expect(await db.query('SELECT * FROM settlement_allocations')).toEqual(
            allocations,
        );
        expect(allocations[0].cycle_id).toBe(oldCycle.id);
        expect(await db.query('SELECT * FROM financial_disbursements')).toEqual(
            financialFacts,
        );
        const history = await db.query(
            'SELECT * FROM inter_member_obligation_changes WHERE obligation_id=$1 ORDER BY version',
            [initial.obligation.id],
        );
        expect(history.at(-1)).toMatchObject({
            actor_id: f.b.context.person.id,
            type: 'ASSIGNMENT_CHANGED',
            version: moved.version,
        });
        expect(JSON.stringify(history.at(-1).snapshot)).toContain(target.id);
        expect(JSON.stringify(history.at(-1).snapshot)).toContain(oldCycle.id);
        const snapshot = await financeSnapshot(db);
        expect(
            (
                await f.b
                    .post(assignmentPath(f, initial.obligation.id), body, key)
                    .expect(200)
            ).body,
        ).toEqual({ ...result, replayed: true });
        expect(await financeSnapshot(db)).toEqual(snapshot);
        const subsequent = (
            await f.a
                .post(
                    `${commitmentPath(f.space, initial.commitment.id)}/disbursements`,
                    {
                        expectedCommitmentVersion: 1,
                        expectedSpaceVersion: f.context.version,
                        amountInCents: 10000,
                        factDate: '2026-10-14',
                        payerMemberId: f.ma,
                        method: 'PIX',
                        settlement: { mode: 'NONE' },
                    },
                )
                .expect(201)
        ).body;
        expect(subsequent.obligation.cycleId).toBe(target.id);
        expect(subsequent.obligation.remainingAmountInCents).toBe(19000);
        expect(await db.query('SELECT * FROM settlement_allocations')).toEqual(
            allocations,
        );
    });

    it('creates a date destination only on confirmation and allows returning to an undated obligation', async () => {
        const f = await sharedFinance(app);
        const initial = await expense(f);
        const snapshot = await financeSnapshot(db);
        const available = await options(f, initial.obligation.id);
        expect(available).toMatchObject({ currentCycle: null, eligible: true });
        expect(await financeSnapshot(db)).toEqual(snapshot);
        const dated = (
            await f.a
                .post(
                    assignmentPath(f, initial.obligation.id),
                    assignmentBody(f, 1, {
                        mode: 'DATE',
                        targetDate: '2026-11-10',
                    }),
                )
                .expect(200)
        ).body;
        expect(dated.settlementCycle.targetDate).toBe('2026-11-10');
        expect(dated.affectedCycleIds).toEqual([dated.settlementCycle.id]);
        expect(await db.query('SELECT * FROM settlement_cycles')).toHaveLength(
            1,
        );
        const current = await options(f, initial.obligation.id);
        const undated = (
            await f.a
                .post(
                    assignmentPath(f, initial.obligation.id),
                    assignmentBody(
                        f,
                        dated.obligation.version,
                        { mode: 'NONE' },
                        [current.currentCycle],
                    ),
                )
                .expect(200)
        ).body;
        expect(undated.obligation.cycleId).toBeNull();
        expect(undated.settlementCycle).toBeNull();
        expect(undated.affectedCycleIds).toEqual([dated.settlementCycle.id]);
        expect(await db.query('SELECT * FROM settlement_cycles')).toHaveLength(
            1,
        );
    });

    it('rejects finalized origins and destinations, stale cycles and resolved obligations without side effects', async () => {
        const f = await sharedFinance(app);
        const initial = await expense(f, 40000, {
            mode: 'DATE',
            targetDate: '2026-10-20',
        });
        const origin = (await options(f, initial.obligation.id)).currentCycle;
        const finalized = await cycle(f, '2026-10-31', true);
        const snapshot = await financeSnapshot(db);
        const rejected = await f.a
            .post(
                assignmentPath(f, initial.obligation.id),
                assignmentBody(f, 1, { mode: 'CYCLE', cycleId: finalized.id }, [
                    origin,
                    finalized,
                ]),
            )
            .expect(409);
        expect(rejected.body.code).toBe('SETTLEMENT_CYCLE_FINALIZED');
        expect(await financeSnapshot(db)).toEqual(snapshot);
        const target = await cycle(f, '2026-11-10');
        const stale = await financeSnapshot(db);
        await f.a
            .post(
                assignmentPath(f, initial.obligation.id),
                assignmentBody(f, 1, { mode: 'CYCLE', cycleId: target.id }, [
                    origin,
                    { ...target, version: 0 },
                ]),
            )
            .expect(400);
        await db.query('UPDATE settlement_cycles SET version=2 WHERE id=$1', [
            target.id,
        ]);
        const staleCycle = await financeSnapshot(db);
        await f.a
            .post(
                assignmentPath(f, initial.obligation.id),
                assignmentBody(f, 1, { mode: 'CYCLE', cycleId: target.id }, [
                    origin,
                    target,
                ]),
            )
            .expect(409);
        expect(await financeSnapshot(db)).toEqual(staleCycle);
        expect(stale.settlement_cycles).toHaveLength(3);
        await db.query(
            "UPDATE settlement_cycles SET status='FINALIZED',finalized_at=now() WHERE id=$1",
            [origin.id],
        );
        const closedOrigin = await options(f, initial.obligation.id);
        expect(closedOrigin.eligible).toBe(false);
        const beforeOrigin = await financeSnapshot(db);
        await f.a
            .post(
                assignmentPath(f, initial.obligation.id),
                assignmentBody(f, 1, { mode: 'NONE' }, [
                    closedOrigin.currentCycle,
                ]),
            )
            .expect(409);
        expect(await financeSnapshot(db)).toEqual(beforeOrigin);
        const loose = await expense(f);
        await f.a
            .post(`${financeBase(f.space)}/settlement-transfers`, {
                expectedSpaceVersion: f.context.version,
                payerMemberId: f.mb,
                recipientMemberId: f.ma,
                amountInCents: loose.obligation.remainingAmountInCents,
                factDate: '2026-10-14',
                allocations: [
                    {
                        obligationId: loose.obligation.id,
                        expectedObligationVersion: 1,
                        amountInCents: loose.obligation.remainingAmountInCents,
                    },
                ],
            })
            .expect(201);
        const resolved = await obligation(loose.obligation.id);
        const beforeResolved = await financeSnapshot(db);
        await f.a
            .post(
                assignmentPath(f, loose.obligation.id),
                assignmentBody(f, resolved.version, {
                    mode: 'DATE',
                    targetDate: '2026-12-10',
                }),
            )
            .expect(400);
        expect(await financeSnapshot(db)).toEqual(beforeResolved);
    });

    it('enforces session, membership, space state and replay authorization', async () => {
        const f = await sharedFinance(app);
        const initial = await expense(f);
        const outsider = await financeBrowser(app, 'Terceiro');
        const path = rulePath(f, initial.commitment.id);
        const key = randomUUID();
        await request(app.getHttpServer())
            .get(
                `${obligationPath(f.space, initial.obligation.id)}/settlement-options`,
            )
            .expect(401);
        await outsider.agent
            .get(
                `${obligationPath(f.space, initial.obligation.id)}/settlement-options`,
            )
            .expect(404);
        await outsider.put(path, ruleBody(f), key).expect(404);
        await outsider
            .post(
                assignmentPath(f, initial.obligation.id),
                assignmentBody(f, 1, { mode: 'NONE' }),
            )
            .expect(404);
        await f.a.agent
            .put(path)
            .set('Origin', 'http://localhost:3000')
            .set('Idempotency-Key', randomUUID())
            .send(ruleBody(f))
            .expect(403);
        await f.a.agent
            .post(assignmentPath(f, initial.obligation.id))
            .set('Origin', 'http://localhost:3000')
            .set('Idempotency-Key', randomUUID())
            .send(assignmentBody(f, 1, { mode: 'NONE' }))
            .expect(403);
        const response = (await f.a.put(path, ruleBody(f), key).expect(200))
            .body;
        const after = await financeSnapshot(db);
        await f.a
            .put(
                path,
                {
                    ...ruleBody(f),
                    rule: { kind: 'MONTHLY_DAY', dayOfMonth: 25 },
                },
                key,
            )
            .expect(409);
        expect(await financeSnapshot(db)).toEqual(after);
        await db.query('UPDATE space_members SET person_id=$2 WHERE id=$1', [
            f.ma,
            outsider.context.person.id,
        ]);
        await f.a.put(path, ruleBody(f), key).expect(404);
        await db.query('UPDATE space_members SET person_id=$2 WHERE id=$1', [
            f.ma,
            f.a.context.person.id,
        ]);
        await db.query(
            "UPDATE spaces SET status='CLOSING',version=version+1 WHERE id=$1",
            [f.space],
        );
        await f.a
            .put(path, ruleBody(f, response.commitmentVersion))
            .expect(409);
        const [closing] = await db.query(
            'SELECT version FROM spaces WHERE id=$1',
            [f.space],
        );
        await f.b
            .post(assignmentPath(f, initial.obligation.id), {
                ...assignmentBody(f, 1, {
                    mode: 'DATE',
                    targetDate: '2026-10-31',
                }),
                expectedSpaceVersion: closing.version,
            })
            .expect(200);
        await db.query(
            "UPDATE spaces SET status='CLOSED',version=version+1 WHERE id=$1",
            [f.space],
        );
        await f.b.agent
            .get(
                `${obligationPath(f.space, initial.obligation.id)}/settlement-options`,
            )
            .expect(200);
        const closed = await db.query(
            'SELECT version FROM spaces WHERE id=$1',
            [f.space],
        );
        await f.b
            .post(assignmentPath(f, initial.obligation.id), {
                ...assignmentBody(f, 1, { mode: 'NONE' }),
                expectedSpaceVersion: closed[0].version,
            })
            .expect(409);
    });

    it.each([
        { rule: { kind: 'MONTHLY_DAY', dayOfMonth: 0 } },
        { rule: { kind: 'MONTHLY_DAY', dayOfMonth: 32 } },
        { rule: { kind: 'MONTHLY_DAY', dayOfMonth: 1.5 } },
        { rule: { kind: 'MONTHLY_DAY', dayOfMonth: 20, unexpected: true } },
        { rule: null },
        { unexpected: true },
    ])(
        'reports invalid specific rule fields in Portuguese: %j',
        async (invalid) => {
            const f = await sharedFinance(app);
            const initial = await expense(f);
            const before = await financeSnapshot(db);
            const response = await f.a
                .put(rulePath(f, initial.commitment.id), {
                    ...ruleBody(f),
                    ...invalid,
                })
                .expect(400);
            expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
            const fields = response.body.details.fields;
            expect(fields.length).toBeGreaterThan(0);
            expect(JSON.stringify(fields)).toMatch(
                /Informe|campo|limite|válid|permitido/,
            );
            expect(JSON.stringify(fields)).not.toMatch(
                /Expected|Invalid|unrecognized|Too (small|big)/,
            );
            expect(await financeSnapshot(db)).toEqual(before);
        },
    );

    it.each(['rule', 'assignment'] as const)(
        'allows only one competing %s command and serializes identical retries',
        async (kind) => {
            const f = await sharedFinance(app);
            const initial = await expense(f);
            const path =
                kind === 'rule'
                    ? rulePath(f, initial.commitment.id)
                    : assignmentPath(f, initial.obligation.id);
            const body =
                kind === 'rule'
                    ? ruleBody(f)
                    : assignmentBody(f, 1, {
                          mode: 'DATE',
                          targetDate: '2026-10-31',
                      });
            const send = (key: string) =>
                kind === 'rule'
                    ? f.a.put(path, body, key)
                    : f.a.post(path, body, key);
            const results = await concurrent(f.space, () =>
                Promise.all([send(randomUUID()), send(randomUUID())]),
            );
            expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
            const fresh = await expense(f);
            const retryPath =
                kind === 'rule'
                    ? rulePath(f, fresh.commitment.id)
                    : assignmentPath(f, fresh.obligation.id);
            const retryBody =
                kind === 'rule'
                    ? ruleBody(f)
                    : assignmentBody(f, 1, {
                          mode: 'DATE',
                          targetDate: '2026-11-30',
                      });
            const key = randomUUID();
            const retrySend = () =>
                kind === 'rule'
                    ? f.a.put(retryPath, retryBody, key)
                    : f.a.post(retryPath, retryBody, key);
            const retries = await concurrent(f.space, () =>
                Promise.all([retrySend(), retrySend()]),
            );
            expect(retries.map((r) => r.status)).toEqual([200, 200]);
            expect(retries.map((r) => r.body.replayed).sort()).toEqual([
                false,
                true,
            ]);
        },
    );

    it.each(['rule', 'assignment'] as const)(
        'rolls back %s, history, destination, audit and receipt on audit failure',
        async (kind) => {
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            const f = await sharedFinance(app);
            const initial = await expense(f);
            const path =
                kind === 'rule'
                    ? rulePath(f, initial.commitment.id)
                    : assignmentPath(f, initial.obligation.id);
            const body =
                kind === 'rule'
                    ? ruleBody(f)
                    : assignmentBody(f, 1, {
                          mode: 'DATE',
                          targetDate: '2026-10-31',
                      });
            const key = randomUUID();
            const send = () =>
                kind === 'rule'
                    ? f.a.put(path, body, key)
                    : f.a.post(path, body, key);
            const snapshot = await financeSnapshot(db);
            await db.query(
                "CREATE FUNCTION reject_card018_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'CARD-018 forced audit failure'; END $$",
            );
            await db.query(
                'CREATE TRIGGER reject_card018_audit BEFORE INSERT ON financial_settlement_adjustment_audit FOR EACH ROW EXECUTE FUNCTION reject_card018_audit()',
            );
            try {
                await send().expect(500);
                expect(await financeSnapshot(db)).toEqual(snapshot);
            } finally {
                await db.query(
                    'DROP TRIGGER reject_card018_audit ON financial_settlement_adjustment_audit',
                );
                await db.query('DROP FUNCTION reject_card018_audit()');
            }
            await send().expect(200);
            expect(
                await db.query(
                    'SELECT * FROM financial_settlement_adjustment_audit WHERE target_id=$1',
                    [
                        kind === 'rule'
                            ? initial.commitment.id
                            : initial.obligation.id,
                    ],
                ),
            ).toHaveLength(1);
            expect(
                await db.query(
                    'SELECT * FROM financial_settlement_adjustment_receipts WHERE idempotency_key=$1',
                    [key],
                ),
            ).toHaveLength(1);
        },
    );

    it('serializes moving a remainder against its settlement transfer without losing either version', async () => {
        const f = await sharedFinance(app);
        const initial = await expense(f);
        const results = await concurrent(f.space, () =>
            Promise.all([
                f.a.post(
                    assignmentPath(f, initial.obligation.id),
                    assignmentBody(f, 1, {
                        mode: 'DATE',
                        targetDate: '2026-10-31',
                    }),
                ),
                f.b.post(`${financeBase(f.space)}/settlement-transfers`, {
                    expectedSpaceVersion: f.context.version,
                    payerMemberId: f.mb,
                    recipientMemberId: f.ma,
                    amountInCents: 1000,
                    factDate: '2026-10-14',
                    allocations: [
                        {
                            obligationId: initial.obligation.id,
                            expectedObligationVersion: 1,
                            amountInCents: 1000,
                        },
                    ],
                }),
            ]),
        );
        expect(results.filter((r) => r.status === 409)).toHaveLength(1);
        expect(
            results.filter((r) => r.status === 200 || r.status === 201),
        ).toHaveLength(1);
        const current = await obligation(initial.obligation.id);
        expect(current.version).toBe(2);
        if (results[0].status === 200) {
            expect(current.cycle_id).not.toBeNull();
            expect(current.remaining_amount_in_cents).toBe('10000');
            expect(
                await db.query('SELECT * FROM settlement_transfers'),
            ).toEqual([]);
        } else {
            expect(current.cycle_id).toBeNull();
            expect(current.remaining_amount_in_cents).toBe('9000');
            expect(await db.query('SELECT * FROM settlement_cycles')).toEqual(
                [],
            );
        }
    });

    it('keeps assignment options on one snapshot when a concurrent command moves the obligation', async () => {
        const f = await sharedFinance(app);
        const initial = await expense(f, 40000, {
            mode: 'DATE',
            targetDate: '2026-10-20',
        });
        const before = await options(f, initial.obligation.id);
        const repo = app.get<TypeOrmSettlementAdjustmentRepository>(
            SETTLEMENT_ADJUSTMENT_REPOSITORY,
        );
        const readCycle = repo.cycle.bind(repo);
        let entered!: () => void, resume!: () => void;
        const reached = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const released = new Promise<void>((resolve) => {
            resume = resolve;
        });
        vi.spyOn(repo, 'cycle').mockImplementationOnce(async (space, id) => {
            entered();
            await released;
            return readCycle(space, id);
        });
        const reading = options(f, initial.obligation.id);
        try {
            await Promise.race([
                reached,
                reading.then(() => {
                    throw new Error('Expected snapshot read to pause');
                }),
            ]);
            const moved = (
                await f.b
                    .post(
                        assignmentPath(f, initial.obligation.id),
                        assignmentBody(f, 1, { mode: 'NONE' }, [
                            before.currentCycle,
                        ]),
                    )
                    .expect(200)
            ).body;
            expect(moved.obligation.cycleId).toBeNull();
        } finally {
            resume();
        }
        const snapshot = await reading;
        expect(snapshot.obligation).toEqual(before.obligation);
        expect(snapshot.currentCycle).toEqual(before.currentCycle);
        expect(
            (await options(f, initial.obligation.id)).obligation,
        ).toMatchObject({ cycleId: null, version: 2 });
    });

    it('pages authorized open cycles and binds the options cursor to the actor and obligation', async () => {
        const f = await sharedFinance(app);
        const initial = await expense(f);
        for (let day = 1; day <= 21; day++)
            await cycle(f, `2026-11-${String(day).padStart(2, '0')}`);
        const finalized = await cycle(f, '2026-12-01', true);
        const otherSpace = (
            await f.a.post('/v2/spaces', { name: 'Outra casa' }).expect(201)
        ).body.space.id;
        const foreign = await cycle({ ...f, space: otherSpace }, '2026-11-01');
        const before = await financeSnapshot(db);
        const first = await options(f, initial.obligation.id);
        expect(first.cycles).toHaveLength(20);
        expect(first.nextCursor).toEqual(expect.any(String));
        expect(first.cycles.map((c: { id: string }) => c.id)).not.toContain(
            finalized.id,
        );
        expect(first.cycles.map((c: { id: string }) => c.id)).not.toContain(
            foreign.id,
        );
        const path = `${obligationPath(f.space, initial.obligation.id)}/settlement-options`;
        const second = (
            await f.a.agent
                .get(path)
                .query({ cursor: first.nextCursor })
                .expect(200)
        ).body;
        expect(second.cycles).toHaveLength(1);
        expect(second.cycles[0].targetDate).toBe('2026-11-21');
        expect(second.nextCursor).toBeNull();
        await f.b.agent
            .get(path)
            .query({ cursor: first.nextCursor })
            .expect(400);
        expect(await financeSnapshot(db)).toEqual(before);
        const target = await cycle(f, '2026-12-10');
        const snapshot = await financeSnapshot(db);
        await f.a
            .post(
                assignmentPath(f, initial.obligation.id),
                assignmentBody(f, 1, { mode: 'CYCLE', cycleId: foreign.id }, [
                    foreign,
                ]),
            )
            .expect(404);
        await f.a
            .post(
                assignmentPath(f, initial.obligation.id),
                assignmentBody(f, 1, { mode: 'CYCLE', cycleId: target.id }, [
                    { ...target, id: foreign.id },
                ]),
            )
            .expect(409);
        expect(await financeSnapshot(db)).toEqual(snapshot);
    });

    it('round-trips the assignment migration without inventing historical rules', async () => {
        const f = await sharedFinance(app);
        const initial = await expense(f);
        const economicState = await db.query(
            'SELECT * FROM financial_commitments',
        );
        await reachAssignmentMigration();
        await migrationSource.undoLastMigration();
        expect(
            (
                await db.query(
                    "SELECT to_regclass('financial_commitment_settlement_rules') AS name",
                )
            )[0].name,
        ).toBeNull();
        expect(
            (
                await db.query(
                    "SELECT to_regclass('financial_settlement_adjustment_audit') AS name",
                )
            )[0].name,
        ).toBeNull();
        await migrationSource.runMigrations();
        expect(await db.query('SELECT * FROM financial_commitments')).toEqual(
            economicState,
        );
        expect(
            await db.query(
                'SELECT * FROM financial_commitment_settlement_rule_changes',
            ),
        ).toEqual([]);
        expect(
            await db.query(
                'SELECT * FROM financial_commitment_settlement_rules',
            ),
        ).toEqual([]);
        expect((await obligation(initial.obligation.id)).version).toBe(1);
    });

    it('refuses a destructive downgrade with specific rules and preserves history atomically', async () => {
        const f = await sharedFinance(app);
        const initial = await expense(f);
        await f.a
            .put(rulePath(f, initial.commitment.id), ruleBody(f))
            .expect(200);
        await reachAssignmentMigration();
        const before = await financeSnapshot(db);
        const migrations = await db.query(
            'SELECT * FROM migrations ORDER BY id',
        );
        await expect(migrationSource.undoLastMigration()).rejects.toThrow();
        expect(await financeSnapshot(db)).toEqual(before);
        expect(await db.query('SELECT * FROM migrations ORDER BY id')).toEqual(
            migrations,
        );
        await expect(
            db.query(
                'UPDATE financial_commitment_settlement_rules SET rule=$2::jsonb WHERE commitment_id=$1',
                [
                    initial.commitment.id,
                    JSON.stringify({ kind: 'MONTHLY_DAY', dayOfMonth: 0 }),
                ],
            ),
        ).rejects.toThrow();
        expect(await financeSnapshot(db)).toEqual(before);
    });

    async function reachAssignmentMigration() {
        await migrationSource.initialize();
        while (true) {
            const [{ name }] = await migrationSource.query(
                'SELECT name FROM migrations ORDER BY id DESC LIMIT 1',
            );
            if (String(name).startsWith('CustomSettlementAssignment')) return;
            if (name === 'FinancialCommandAudit1792154979034')
                throw new Error('Expected CARD-018 migration');
            await migrationSource.undoLastMigration();
        }
    }

    async function concurrent<T>(space: string, start: () => Promise<T>) {
        const gate = db.createQueryRunner();
        await gate.connect();
        await gate.startTransaction();
        let pending: Promise<T> | undefined;
        try {
            const [{ pid }] = await gate.query(
                'SELECT pg_backend_pid() AS pid',
            );
            await gate.query('SELECT id FROM spaces WHERE id=$1 FOR UPDATE', [
                space,
            ]);
            pending = start();
            await vi.waitFor(
                async () => {
                    const waiting = await db.query(
                        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
                        [pid],
                    );
                    expect(
                        new Set(waiting.map((r: { pid: number }) => r.pid))
                            .size,
                    ).toBe(2);
                },
                { timeout: 10000, interval: 20 },
            );
            await gate.commitTransaction();
            return await pending;
        } finally {
            if (gate.isTransactionActive) await gate.rollbackTransaction();
            await gate.release();
            if (pending) await Promise.allSettled([pending]);
        }
    }
});
