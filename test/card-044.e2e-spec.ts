import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { EntityManager, type DataSource } from 'typeorm';
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    financeBrowser,
    financeSnapshot,
    sharedFinance,
    recordSharedObligation,
} from './settlement-fixture.js';
import { routineSnapshot } from './routine-fixture.js';
import {
    prepareShoppingDatabase,
    shoppingApp,
    shoppingSnapshot,
} from './shopping-fixture.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../dist/modules/finances/application/ports/private/shared-expense.repositories.js';
import {
    FINANCE_TODAY_COMPOSITION_QUERY_PORT,
    type FinanceTodayCompositionQueryPort,
} from '../dist/modules/finances/application/ports/public/finance-today-composition-query.port.js';
import { FinanceTodayUnavailableError } from '../dist/modules/finances/application/ports/public/finance-today-query.port.js';
import {
    ROUTINE_TODAY_QUERY_PORT,
    type RoutineTodayQueryPort,
} from '../dist/modules/routine/application/ports/public/routine-today-query.port.js';
import { RoutineAttentionUnavailableError } from '../dist/modules/routine/application/ports/public/routine-attention-query.port.js';
import {
    SHOPPING_ATTENTION_QUERY_PORT,
    ShoppingAttentionUnavailableError,
    type ShoppingAttentionQueryPort,
} from '../dist/modules/shopping/application/ports/public/shopping-attention-query.port.js';
import type {
    TodayBlock,
    TodayResponse,
} from '../dist/composition/today/today.response.js';

const block = (result: TodayResponse, kind: TodayBlock['kind']) =>
    result.blocks.find((value) => value.kind === kind)!;

describe('CARD-044 Today cross-module composition HTTP/PostgreSQL', () => {
    let app: INestApplication<Server>, db: DataSource, instant: string;
    beforeAll(prepareShoppingDatabase);
    beforeEach(async () => {
        instant = '2026-10-18T14:00:00Z';
        ({ app, db } = await shoppingApp(() => new Date(instant)));
        const clock = app.get<FinancesClock>(FINANCES_CLOCK);
        vi.spyOn(clock, 'today').mockReturnValue('2026-10-18');
        vi.spyOn(clock, 'now').mockImplementation(() => new Date(instant));
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await app?.close();
    });
    const snapshot = () =>
        Promise.all([
            financeSnapshot(db),
            routineSnapshot(db),
            shoppingSnapshot(db),
        ]);
    async function personal() {
        const b = await financeBrowser(app);
        return { b, base: `/v2/spaces/${b.context.personalSpace.id}` };
    }

    it.each(['PERSONAL', 'SHARED'] as const)(
        'distinguishes empty authorized %s data from unavailable sources',
        async (kind) => {
            const f = kind === 'SHARED' ? await sharedFinance(app) : null,
                p = f
                    ? { b: f.a, base: `/v2/spaces/${f.space}` }
                    : await personal(),
                before = await snapshot(),
                response = await p.b.agent.get(`${p.base}/today`).expect(200),
                result: TodayResponse = response.body;
            expect(response.headers['cache-control']).toBe('no-store');
            expect(result).toMatchObject({
                spaceType: kind,
                referenceDate: '2026-10-18',
                finance: { status: 'AVAILABLE' },
                routine: { status: 'AVAILABLE' },
                shopping: {
                    status: 'AVAILABLE',
                    data: { items: [], totalCount: 0, activeListCount: 0 },
                },
                capabilities: { spaceClosureAttention: 'SUPPORTED' },
            });
            expect(result.blocks.map((value) => value.kind)).toEqual([
                'ATTENTION',
                'TODAY',
                'NEXT_SETTLEMENT',
                'UPCOMING',
                'TASKS',
                'SHOPPING',
            ]);
            for (const value of result.blocks)
                expect(value).toMatchObject({
                    status:
                        kind === 'PERSONAL' && value.kind === 'NEXT_SETTLEMENT'
                            ? 'NOT_APPLICABLE'
                            : 'AVAILABLE',
                    items: [],
                    totalCount: 0,
                    knownTotalCount: 0,
                    hasMore: false,
                });
            expect(await snapshot()).toEqual(before);
        },
    );

    it('deduplicates urgent overdue tasks in attention while retaining full counts beyond each preview', async () => {
        const { b, base } = await personal();
        for (let i = 0; i < 6; i++)
            await b
                .post(`${base}/tasks`, {
                    description: `Urgente ${i}`,
                    urgency: 'URGENT',
                    deadline: { date: '2026-10-18', time: '10:00' },
                })
                .expect(201);
        const before = await snapshot(),
            result: TodayResponse = (
                await b.agent.get(`${base}/today`).expect(200)
            ).body;
        for (const [kind, limit] of [
            ['ATTENTION', 3],
            ['TODAY', 4],
            ['TASKS', 4],
        ] as const) {
            const value = block(result, kind);
            expect(value).toMatchObject({
                status: 'AVAILABLE',
                totalCount: 6,
                knownTotalCount: 6,
                hasMore: true,
            });
            expect(value.items).toHaveLength(limit);
            expect(
                new Set(
                    value.items.map((item) =>
                        item.reference.type === 'TASK'
                            ? item.reference.taskId
                            : '',
                    ),
                ).size,
            ).toBe(limit);
            expect(
                value.items.every(
                    (item) =>
                        item.type === 'TASK' &&
                        item.reference.type === 'TASK' &&
                        item.reference.kind === 'ONE_OFF',
                ),
            ).toBe(true);
        }
        expect(result.routine).toMatchObject({
            status: 'AVAILABLE',
            data: {
                counts: { totalCount: 6, overdue: 6, urgent: 6, today: 6 },
            },
        });
        expect(await snapshot()).toEqual(before);
    });

    it('counts overdue, current and upcoming financial commitments independently beyond four previews', async () => {
        const { b, base } = await personal();
        for (const date of ['2026-10-17', '2026-10-18', '2026-10-19'])
            for (let i = 0; i < 6; i++)
                await b
                    .post(`${base}/planned-expenses`, {
                        scope: 'PERSONAL',
                        description: `${date} ${i}`,
                        amountInCents: 1000,
                        expectedPaymentDate: date,
                    })
                    .expect(201);
        const before = await snapshot(),
            result: TodayResponse = (
                await b.agent.get(`${base}/today`).expect(200)
            ).body;
        for (const [kind, date, limit] of [
            ['ATTENTION', '2026-10-17', 3],
            ['TODAY', '2026-10-18', 4],
            ['UPCOMING', '2026-10-19', 4],
        ] as const) {
            const value = block(result, kind);
            expect(value).toMatchObject({
                totalCount: 6,
                knownTotalCount: 6,
                hasMore: true,
            });
            expect(value.items).toHaveLength(limit);
            expect(
                value.items.every(
                    (item) =>
                        item.type === 'FINANCIAL_COMMITMENT' &&
                        item.reference.type === 'FINANCIAL_COMMITMENT' &&
                        item.reference.expectedDate === date &&
                        item.reference.modality === 'ONE_TIME',
                ),
            ).toBe(true);
        }
        expect(await snapshot()).toEqual(before);
    });

    it('keeps old and current occurrences of one financial recurrence in their own buckets without materialization', async () => {
        const { b, base } = await personal(),
            root = (
                await b
                    .post(`${base}/recurring-commitments`, {
                        scope: 'PERSONAL',
                        kind: 'EXPENSE',
                        description: 'Aluguel recorrente',
                        amountInCents: 10000,
                        recurrence: { frequency: 'MONTHLY', dayOfMonth: 18 },
                        startsOn: '2025-09-01',
                    })
                    .expect(201)
            ).body.commitment,
            before = await snapshot(),
            result: TodayResponse = (
                await b.agent.get(`${base}/today`).expect(200)
            ).body;
        for (const [kind, expectedDate] of [
            ['ATTENTION', '2025-09-18'],
            ['TODAY', '2026-10-18'],
            ['UPCOMING', '2026-11-18'],
        ] as const) {
            const value = block(result, kind);
            expect(value.totalCount).toBe(1);
            expect(value.items[0]).toMatchObject({
                type: 'FINANCIAL_COMMITMENT',
                reference: {
                    type: 'FINANCIAL_COMMITMENT',
                    commitmentId: root.id,
                    modality: 'RECURRING',
                    expectedDate,
                },
            });
        }
        expect(
            (await db.query('SELECT * FROM financial_occurrences')).length,
        ).toBe(0);
        expect(await snapshot()).toEqual(before);
    });

    it('uses adjusted and reversed financial balances alongside incomes and installment occurrences', async () => {
        const { b, base } = await personal(),
            expense = (
                await b
                    .post(`${base}/planned-expenses`, {
                        scope: 'PERSONAL',
                        description: 'Corrigida',
                        amountInCents: 1000,
                        expectedPaymentDate: '2026-10-18',
                    })
                    .expect(201)
            ).body.commitment,
            path = `${base}/financial-commitments/${expense.id}`;
        await b
            .post(`${path}/adjustments`, {
                expectedCommitmentVersion: 1,
                direction: 'INCREASE',
                amountInCents: 250,
                reason: 'Ajuste acordado',
                factDate: '2026-10-18',
            })
            .expect(201);
        const paid = (
                await b
                    .post(`${path}/disbursements`, {
                        expectedCommitmentVersion: 2,
                        amountInCents: 400,
                        method: 'PIX',
                        factDate: '2026-10-18',
                    })
                    .expect(201)
            ).body,
            [fact] = await db.query(
                'SELECT id FROM financial_disbursements WHERE commitment_id=$1',
                [expense.id],
            );
        await b
            .post(`${path}/reversals`, {
                expectedCommitmentVersion: paid.commitment.version,
                originalKind: 'DISBURSEMENT',
                originalId: fact.id,
                amountInCents: 100,
                reason: 'Parte devolvida',
                factDate: '2026-10-18',
            })
            .expect(201);
        const income = (
                await b
                    .post(`${base}/incomes`, {
                        description: 'Receita do dia',
                        amountInCents: 2000,
                        expectedReceiptDate: '2026-10-18',
                        receipt: null,
                    })
                    .expect(201)
            ).body.commitment,
            installments = (
                await b
                    .post(`${base}/installment-commitments`, {
                        scope: 'PERSONAL',
                        description: 'Parcelada',
                        count: 3,
                        firstDueDate: '2026-10-18',
                        cadence: 'MONTHLY',
                        totalAmountInCents: 3000,
                    })
                    .expect(201)
            ).body.commitment,
            before = await snapshot(),
            result: TodayResponse = (
                await b.agent.get(`${base}/today`).expect(200)
            ).body,
            today = block(result, 'TODAY');
        expect(today.totalCount).toBe(3);
        expect(today.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: 'FINANCIAL_COMMITMENT',
                    reference: expect.objectContaining({
                        commitmentId: expense.id,
                    }),
                    details: expect.objectContaining({
                        amountInCents: 1250,
                        fulfilledAmountInCents: 300,
                        remainingAmountInCents: 950,
                    }),
                }),
                expect.objectContaining({
                    reference: expect.objectContaining({
                        commitmentId: income.id,
                    }),
                    details: expect.objectContaining({
                        kind: 'INCOME',
                        remainingAmountInCents: 2000,
                    }),
                }),
                expect.objectContaining({
                    reference: expect.objectContaining({
                        commitmentId: installments.id,
                        modality: 'INSTALLMENT',
                        expectedDate: '2026-10-18',
                    }),
                }),
            ]),
        );
        expect(block(result, 'UPCOMING').items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    reference: expect.objectContaining({
                        commitmentId: installments.id,
                        expectedDate: '2026-11-18',
                    }),
                }),
            ]),
        );
        expect(await snapshot()).toEqual(before);
    });

    it.each([
        { previouslyPaid: 0, anticipatedPaid: 8000 },
        { previouslyPaid: 2000, anticipatedPaid: 6000 },
        { previouslyPaid: 0, anticipatedPaid: 12000 },
    ])(
        'keeps anticipated installments out of Today until a reversal reopens their effective balance ($previouslyPaid paid before $anticipatedPaid anticipated)',
        async ({ previouslyPaid, anticipatedPaid }) => {
            instant = '2026-10-19T14:00:00Z';
            vi.mocked(
                app.get<FinancesClock>(FINANCES_CLOCK).today,
            ).mockImplementation(() => instant.slice(0, 10));
            const { b, base } = await personal(),
                plans = `${base}/installment-commitments`,
                root = (
                    await b
                        .post(plans, {
                            scope: 'PERSONAL',
                            description: 'Parcela antecipada',
                            count: 1,
                            firstDueDate: '2026-11-20',
                            cadence: 'MONTHLY',
                            totalAmountInCents: 10000,
                        })
                        .expect(201)
                ).body.commitment,
                installment = root.plan.installments[0],
                planPath = `${plans}/${root.id}`,
                effectiveAmountInCents = previouslyPaid + anticipatedPaid;
            if (previouslyPaid > 0)
                await b
                    .post(
                        `${planPath}/installments/${installment.id}/disbursements`,
                        {
                            expectedCommitmentVersion: 1,
                            expectedInstallmentVersion: 1,
                            amountInCents: previouslyPaid,
                            factDate: '2026-10-19',
                            method: 'PIX',
                        },
                    )
                    .expect(201);
            const anticipated = (
                await b
                    .post(`${planPath}/anticipations`, {
                        selection: {
                            mode: 'IDS',
                            installmentIds: [installment.id],
                        },
                        factDate: '2026-10-19',
                        method: 'PIX',
                        expectedCommitmentVersion: previouslyPaid > 0 ? 2 : 1,
                        values: [
                            {
                                installmentId: installment.id,
                                expectedInstallmentVersion:
                                    previouslyPaid > 0 ? 2 : 1,
                                paidAmountInCents: anticipatedPaid,
                            },
                        ],
                    })
                    .expect(201)
            ).body;
            expect(anticipated.commitment.plan).toMatchObject({
                status: 'COMPLETED',
                fulfilledAmountInCents: effectiveAmountInCents,
                remainingAmountInCents: 0,
            });
            const before = await snapshot();
            for (const date of ['2026-10-19', '2026-11-20', '2026-11-21']) {
                instant = `${date}T14:00:00Z`;
                const details = (
                        await b.agent
                            .get(`${planPath}/installments`)
                            .expect(200)
                    ).body,
                    result: TodayResponse = (
                        await b.agent.get(`${base}/today`).expect(200)
                    ).body;
                expect(details.items[0]).toMatchObject({
                    id: installment.id,
                    amountInCents: 10000,
                    effectiveAmountInCents,
                    fulfilledAmountInCents: effectiveAmountInCents,
                    remainingAmountInCents: 0,
                    status: 'FULFILLED',
                });
                expect(result).toMatchObject({
                    referenceDate: date,
                    finance: {
                        status: 'AVAILABLE',
                        data: {
                            upcomingCommitments: { items: [], totalCount: 0 },
                        },
                    },
                });
                for (const kind of ['ATTENTION', 'TODAY', 'UPCOMING'] as const)
                    expect(block(result, kind)).toMatchObject({
                        status: 'AVAILABLE',
                        items: [],
                        totalCount: 0,
                        knownTotalCount: 0,
                        hasMore: false,
                    });
            }
            expect(await snapshot()).toEqual(before);

            instant = '2026-10-19T14:00:00Z';
            await b
                .post(`${base}/financial-commitments/${root.id}/reversals`, {
                    originalKind: 'DISBURSEMENT',
                    originalId: anticipated.items[0].fact.id,
                    amountInCents: 3000,
                    expectedCommitmentVersion: anticipated.commitment.version,
                    expectedOccurrenceVersion:
                        anticipated.commitment.plan.installments[0]
                            .stateVersion,
                    installmentId: installment.id,
                    reason: 'Estorno parcial da antecipação',
                    factDate: '2026-10-19',
                })
                .expect(201);
            const afterReversal = await snapshot();
            for (const [date, bucket] of [
                ['2026-10-19', 'UPCOMING'],
                ['2026-11-20', 'TODAY'],
                ['2026-11-21', 'ATTENTION'],
            ] as const) {
                instant = `${date}T14:00:00Z`;
                const result: TodayResponse = (
                    await b.agent.get(`${base}/today`).expect(200)
                ).body;
                expect(block(result, bucket)).toMatchObject({
                    status: 'AVAILABLE',
                    totalCount: 1,
                    knownTotalCount: 1,
                    hasMore: false,
                    items: [
                        {
                            type: 'FINANCIAL_COMMITMENT',
                            reference: {
                                commitmentId: root.id,
                                occurrenceId: installment.id,
                                modality: 'INSTALLMENT',
                                expectedDate: '2026-11-20',
                            },
                            details: {
                                amountInCents: effectiveAmountInCents,
                                expectedAmountInCents: 10000,
                                fulfilledAmountInCents:
                                    effectiveAmountInCents - 3000,
                                remainingAmountInCents: 3000,
                            },
                        },
                    ],
                });
                for (const kind of ['ATTENTION', 'TODAY', 'UPCOMING'] as const)
                    if (kind !== bucket)
                        expect(block(result, kind).totalCount).toBe(0);
            }
            expect(await snapshot()).toEqual(afterReversal);
        },
    );

    it('exposes navigable virtual routine occurrences without creating instances on GET', async () => {
        const { b, base } = await personal(),
            recurrence = (
                await b
                    .post(`${base}/task-recurrences`, {
                        description: 'Rotina do dia',
                        rule: { frequency: 'DAILY' },
                        startsOn: '2026-10-18',
                        endsOn: '2026-10-18',
                        deadline: { time: '10:00' },
                        urgency: 'URGENT',
                    })
                    .expect(201)
            ).body,
            before = await snapshot(),
            result: TodayResponse = (
                await b.agent.get(`${base}/today`).expect(200)
            ).body;
        expect(block(result, 'TODAY').items[0]).toMatchObject({
            type: 'TASK',
            reference: {
                type: 'TASK',
                kind: 'OCCURRENCE',
                recurrenceId: recurrence.id,
                scheduledDate: '2026-10-18',
            },
        });
        expect(block(result, 'ATTENTION').totalCount).toBe(1);
        expect(
            (await db.query('SELECT * FROM routine_task_occurrences')).length,
        ).toBe(0);
        expect(await snapshot()).toEqual(before);
    });

    it('includes only pending change proposals addressed to the current member', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}`,
            distribution = {
                mode: 'PERCENTAGES',
                shares: [
                    { memberId: f.ma, basisPoints: 5000 },
                    { memberId: f.mb, basisPoints: 5000 },
                ],
            };
        async function propose(author: typeof f.a, memberId: string) {
            const root = (
                await author
                    .post(`${base}/recurring-commitments`, {
                        scope: 'SHARED',
                        kind: 'EXPENSE',
                        description: 'Reajuste futuro',
                        amountInCents: 1000,
                        recurrence: { frequency: 'MONTHLY', dayOfMonth: 20 },
                        startsOn: '2026-11-01',
                        expectedSpaceVersion: f.context.version,
                        expectedMemberId: memberId,
                        distribution,
                    })
                    .expect(201)
            ).body.commitment;
            const proposal = (
                await author
                    .post(
                        `${base}/financial-commitments/${root.id}/change-proposals`,
                        {
                            scope: 'SHARED',
                            kind: 'EXPENSE',
                            valueMode: 'FIXED',
                            description: 'Reajuste futuro',
                            amountInCents: 2000,
                            recurrence: {
                                frequency: 'MONTHLY',
                                dayOfMonth: 20,
                            },
                            effectiveFrom: '2026-12-01',
                            expectedCommitmentVersion: 1,
                            expectedSpaceVersion: f.context.version,
                            expectedMemberId: memberId,
                            distribution,
                        },
                    )
                    .expect(201)
            ).body.proposal;
            return { root, proposal };
        }
        const mine = await propose(f.b, f.mb),
            other = await propose(f.a, f.ma),
            decided = await propose(f.b, f.mb);
        await f.a
            .post(
                `${base}/financial-commitments/${decided.root.id}/change-proposals/${decided.proposal.id}/rejection`,
                {
                    expectedProposalVersion: 1,
                    expectedCommitmentVersion: 1,
                    expectedSpaceVersion: f.context.version,
                },
            )
            .expect(201);
        const before = await snapshot(),
            result: TodayResponse = (
                await f.a.agent.get(`${base}/today`).expect(200)
            ).body,
            attention = block(result, 'ATTENTION');
        expect(attention.totalCount).toBe(1);
        expect(attention.items).toMatchObject([
            {
                type: 'CHANGE_PROPOSAL',
                reference: {
                    type: 'CHANGE_PROPOSAL',
                    proposalId: mine.proposal.id,
                    commitmentId: mine.root.id,
                },
            },
        ]);
        expect(JSON.stringify(attention)).not.toContain(other.proposal.id);
        expect(JSON.stringify(attention)).not.toContain(decided.proposal.id);
        expect(await snapshot()).toEqual(before);
    });

    it('links the next shared settlement cycle through its public summary', async () => {
        const f = await sharedFinance(app),
            created = await recordSharedObligation(f, 1000, '2026-10-20'),
            before = await snapshot(),
            result: TodayResponse = (
                await f.a.agent.get(`/v2/spaces/${f.space}/today`).expect(200)
            ).body;
        expect(block(result, 'NEXT_SETTLEMENT')).toMatchObject({
            status: 'AVAILABLE',
            totalCount: 1,
            knownTotalCount: 1,
            hasMore: false,
            items: [
                {
                    type: 'SETTLEMENT_CYCLE',
                    reference: {
                        type: 'SETTLEMENT_CYCLE',
                        cycleId: created.settlementCycle.id,
                    },
                    date: '2026-10-20',
                },
            ],
        });
        expect(await snapshot()).toEqual(before);
    });

    it('previews partial shopping needs with real counts and excludes empty, completed and archived lists', async () => {
        const { b, base } = await personal(),
            first = (
                await b
                    .post(`${base}/shopping-lists`, { name: 'Parciais' })
                    .expect(201)
            ).body;
        let partialId = '';
        for (let i = 0; i < 5; i++)
            partialId = (
                await b
                    .post(`${base}/shopping-lists/${first.id}/items`, {
                        expectedVersion: i + 1,
                        description: `Item ${i}`,
                        desiredQuantity: '4',
                        unit: i === 4 ? 'kg' : 'un',
                    })
                    .expect(201)
            ).body.item.id;
        await b
            .post(
                `${base}/shopping-lists/${first.id}/items/${partialId}/purchases`,
                { expectedVersion: 6, quantity: '1.25' },
            )
            .expect(201);
        instant = '2026-10-18T14:01:00Z';
        async function listWithItem(name: string) {
            const list = (
                    await b.post(`${base}/shopping-lists`, { name }).expect(201)
                ).body,
                path = `${base}/shopping-lists/${list.id}`,
                item = (
                    await b
                        .post(`${path}/items`, {
                            expectedVersion: 1,
                            description: name,
                            desiredQuantity: '1',
                        })
                        .expect(201)
                ).body.item;
            return { list, path, item };
        }
        for (let i = 0; i < 5; i++) await listWithItem(`Pendente ${i}`);
        const complete = await listWithItem('Completa');
        await b
            .post(`${complete.path}/items/${complete.item.id}/purchases`, {
                expectedVersion: 2,
                quantity: '1',
            })
            .expect(201);
        await b.post(`${base}/shopping-lists`, { name: 'Vazia' }).expect(201);
        const archived = await listWithItem('Arquivada');
        await b
            .post(`${archived.path}/archival`, { expectedVersion: 2 })
            .expect(200);
        const before = await snapshot(),
            result: TodayResponse = (
                await b.agent.get(`${base}/today`).expect(200)
            ).body,
            shopping = block(result, 'SHOPPING');
        expect(shopping).toMatchObject({
            status: 'AVAILABLE',
            totalCount: 6,
            knownTotalCount: 6,
            hasMore: true,
        });
        expect(shopping.items).toHaveLength(4);
        expect(result.shopping).toMatchObject({
            status: 'AVAILABLE',
            data: { activeListCount: 8, totalCount: 6 },
        });
        expect(shopping.items[0]).toMatchObject({
            reference: { type: 'SHOPPING_LIST', listId: first.id },
            details: {
                summary: { activeItemCount: 5, actionableItemCount: 5 },
                pendingItems: {
                    totalCount: 5,
                    hasMore: true,
                    items: [
                        {
                            id: partialId,
                            status: 'PARTIALLY_PURCHASED',
                            desiredQuantity: '4',
                            purchasedQuantity: '1.25',
                            remainingQuantity: '2.75',
                            unit: 'kg',
                        },
                        {},
                        {},
                        {},
                    ],
                },
            },
        });
        expect(JSON.stringify(shopping)).not.toContain(archived.list.id);
        expect(JSON.stringify(shopping)).not.toContain(complete.list.id);
        expect(await snapshot()).toEqual(before);
    });

    it.each(['finance', 'routine', 'shopping', 'all'] as const)(
        'isolates %s legacy source failures while preserving closure availability',
        async (failed) => {
            const f = await sharedFinance(app),
                base = `/v2/spaces/${f.space}`;
            await f.a
                .post(`${base}/tasks`, {
                    description: 'Urgente',
                    urgency: 'URGENT',
                    deadline: { date: '2026-10-18', time: '10:00' },
                })
                .expect(201);
            if (failed === 'finance' || failed === 'all')
                vi.spyOn(
                    app.get<FinanceTodayCompositionQueryPort>(
                        FINANCE_TODAY_COMPOSITION_QUERY_PORT,
                    ),
                    'read',
                ).mockRejectedValue(new FinanceTodayUnavailableError());
            if (failed === 'routine' || failed === 'all')
                vi.spyOn(
                    app.get<RoutineTodayQueryPort>(ROUTINE_TODAY_QUERY_PORT),
                    'read',
                ).mockRejectedValue(new RoutineAttentionUnavailableError());
            if (failed === 'shopping' || failed === 'all')
                vi.spyOn(
                    app.get<ShoppingAttentionQueryPort>(
                        SHOPPING_ATTENTION_QUERY_PORT,
                    ),
                    'read',
                ).mockRejectedValue(new ShoppingAttentionUnavailableError());
            const before = await snapshot(),
                result: TodayResponse = (
                    await f.a.agent.get(`${base}/today`).expect(200)
                ).body;
            if (failed === 'all')
                expect(
                    result.blocks.every(
                        (value) =>
                            value.status ===
                                (value.kind === 'ATTENTION'
                                    ? 'PARTIAL'
                                    : 'UNAVAILABLE') &&
                            value.totalCount === null &&
                            value.knownTotalCount === 0 &&
                            value.hasMore === null,
                    ),
                ).toBe(true);
            else if (failed === 'shopping') {
                expect(block(result, 'SHOPPING').status).toBe('UNAVAILABLE');
                expect(block(result, 'ATTENTION')).toMatchObject({
                    status: 'AVAILABLE',
                    totalCount: 1,
                });
                expect(result.finance.status).toBe('AVAILABLE');
            } else {
                expect(block(result, 'ATTENTION')).toMatchObject({
                    status: 'PARTIAL',
                    totalCount: null,
                    knownTotalCount: failed === 'finance' ? 1 : 0,
                    hasMore: null,
                });
                expect(block(result, 'TODAY').status).toBe('PARTIAL');
                expect(result.shopping.status).toBe('AVAILABLE');
            }
            expect(await snapshot()).toEqual(before);
        },
    );

    it('keeps shopping counts and fractional item previews coherent while another connection completes a purchase', async () => {
        const { b, base } = await personal(),
            list = (await b.post(`${base}/shopping-lists`, {}).expect(201))
                .body,
            path = `${base}/shopping-lists/${list.id}/items`,
            item = (
                await b
                    .post(path, {
                        expectedVersion: 1,
                        description: 'Arroz',
                        desiredQuantity: '4',
                    })
                    .expect(201)
            ).body.item;
        await b
            .post(`${path}/${item.id}/purchases`, {
                expectedVersion: 2,
                quantity: '1.25',
            })
            .expect(201);
        const original = EntityManager.prototype.query;
        let armed = true;
        vi.spyOn(EntityManager.prototype, 'query').mockImplementation(
            async function (this: EntityManager, sql, params) {
                const rows = await original.call(this, sql, params);
                if (armed && sql.includes('active_lists AS MATERIALIZED (')) {
                    armed = false;
                    const [mode] = await this.query<
                        { transaction_read_only: string }[]
                    >('SHOW transaction_read_only');
                    expect(mode.transaction_read_only).toBe('on');
                    await db.transaction(async (writer) => {
                        await writer.query(
                            'UPDATE shopping_lists SET version=version+1 WHERE id=$1',
                            [list.id],
                        );
                        await writer.query(
                            'INSERT INTO shopping_purchase_records(id,space_id,list_id,item_id,quantity,unit,registered_by_person_id,registered_by_member_id,registered_by_display_name,registered_at) SELECT gen_random_uuid(),space_id,list_id,id,2.75,unit,creator_person_id,creator_member_id,creator_display_name,now() FROM shopping_items WHERE id=$1',
                            [item.id],
                        );
                    });
                }
                return rows;
            },
        );
        const first: TodayResponse = (
            await b.agent.get(`${base}/today`).expect(200)
        ).body;
        expect(armed).toBe(false);
        expect(block(first, 'SHOPPING')).toMatchObject({
            totalCount: 1,
            items: [
                {
                    details: {
                        summary: { actionableItemCount: 1 },
                        pendingItems: {
                            items: [
                                {
                                    purchasedQuantity: '1.25',
                                    remainingQuantity: '2.75',
                                },
                            ],
                            totalCount: 1,
                        },
                    },
                },
            ],
        });
        vi.restoreAllMocks();
        const second: TodayResponse = (
            await b.agent.get(`${base}/today`).expect(200)
        ).body;
        expect(block(second, 'SHOPPING')).toMatchObject({
            totalCount: 0,
            items: [],
        });
    });

    it('rejects outsider reads and revocation during an otherwise successful source read', async () => {
        const f = await sharedFinance(app),
            outsider = await financeBrowser(app),
            path = `/v2/spaces/${f.space}/today`,
            shopping = app.get<ShoppingAttentionQueryPort>(
                SHOPPING_ATTENTION_QUERY_PORT,
            ),
            read = shopping.read.bind(shopping);
        await outsider.agent.get(path).expect(404);
        try {
            vi.spyOn(shopping, 'read').mockImplementationOnce(
                async (...args) => {
                    const result = await read(...args);
                    await db.query(
                        'UPDATE space_members SET person_id=$2 WHERE id=$1',
                        [f.ma, outsider.context.person.id],
                    );
                    return result;
                },
            );
            await f.a.agent.get(path).expect(404);
        } finally {
            await db.query(
                'UPDATE space_members SET person_id=$2 WHERE id=$1',
                [f.ma, f.a.context.person.id],
            );
        }
    });
});
