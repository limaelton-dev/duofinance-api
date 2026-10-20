import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Logger, type INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { financeSnapshot, sharedFinance } from './settlement-fixture.js';
import { prepareShoppingDatabase } from './shopping-fixture.js';
import {
    closurePath,
    closureApp,
    closureSnapshot,
    formingSharedSpace,
} from './closure-fixture.js';
import {
    CLOSURE_CLOCK,
    type ClosureClock,
} from '../dist/composition/space-closure/closure.clock.js';
import { createApiOpenApiDocument } from '../dist/composition/http/create-api-openapi-document.js';
import {
    FINANCIAL_CLOSURE_DESTINATIONS_PORT,
    type FinancialClosureDestinationsPort,
} from '../dist/modules/finances/application/ports/public/financial-closure-destinations.port.js';
import {
    SPACE_CLOSURE_PORT,
    type SpaceClosurePort,
} from '../dist/modules/spaces/application/ports/public/space-closure.port.js';

type PlanVersion = { spaceVersion: number; planRevision: number };

describe('future financial destinations HTTP/PostgreSQL', () => {
    let app: INestApplication<Server>, db: DataSource, closureDay: string;
    beforeAll(prepareShoppingDatabase);
    beforeEach(async () => {
        ({ app, db, day: closureDay } = await closureApp());
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        await app?.close();
    });
    const snapshot = () =>
        Promise.all([closureSnapshot(db), financeSnapshot(db)]);
    const versionInput = (plan: PlanVersion) => ({
        expectedSpaceVersion: plan.spaceVersion,
        expectedPlanRevision: plan.planRevision,
    });
    function futureDate(months = 1, day = 20) {
        const value = new Date(`${closureDay.slice(0, 7)}-01T12:00:00Z`);
        value.setUTCMonth(value.getUTCMonth() + months);
        const last = new Date(
            Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0),
        ).getUTCDate();
        value.setUTCDate(Math.min(day, last));
        return value.toISOString().slice(0, 10);
    }
    async function fixture(mode: 'solo' | 'bilateral' = 'bilateral') {
        if (mode === 'solo') {
            const f = await formingSharedSpace(app);
            return {
                a: f.a,
                other: null,
                space: f.space,
                memberIds: [f.memberId],
                context: f.context,
                path: f.path,
            };
        }
        const f = await sharedFinance(app);
        return {
            a: f.a,
            other: f.b,
            space: f.space,
            memberIds: [f.ma, f.mb],
            context: f.context,
            path: closurePath(f.space),
        };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    async function recurring(
        f: Fixture,
        kind: 'EXPENSE' | 'INCOME' = 'EXPENSE',
        variable = false,
        startsOn = futureDate(1, 1),
    ) {
        return (
            await f.a
                .post(`/v2/spaces/${f.space}/recurring-commitments`, {
                    scope: 'SHARED',
                    kind,
                    description: 'Compromisso futuro compartilhado',
                    ...(variable
                        ? { valueMode: 'VARIABLE', expectedAmountInCents: 3000 }
                        : { amountInCents: 3000 }),
                    recurrence: { frequency: 'MONTHLY', dayOfMonth: 20 },
                    startsOn,
                    expectedSpaceVersion: f.context.version,
                    expectedMemberId: f.memberIds[0],
                    distribution: {
                        mode: 'PERCENTAGES',
                        shares: f.memberIds.map((memberId) => ({
                            memberId,
                            basisPoints: 10000 / f.memberIds.length,
                        })),
                    },
                })
                .expect(201)
        ).body.commitment;
    }
    async function installments(f: Fixture) {
        return (
            await f.a
                .post(`/v2/spaces/${f.space}/installment-commitments`, {
                    scope: 'SHARED',
                    description: 'Parcelamento compartilhado',
                    count: 3,
                    firstDueDate: futureDate(),
                    cadence: 'MONTHLY',
                    totalAmountInCents: 3000,
                    expectedSpaceVersion: f.context.version,
                    expectedRuleVersion: 0,
                    expectedMemberId: f.memberIds[0],
                    distribution: {
                        mode: 'PERCENTAGES',
                        shares: f.memberIds.map((memberId) => ({
                            memberId,
                            basisPoints: 10000 / f.memberIds.length,
                        })),
                    },
                })
                .expect(201)
        ).body.commitment;
    }
    const begin = async (f: Fixture) =>
        (
            await f.a
                .post(f.path, { expectedSpaceVersion: f.context.version })
                .expect(201)
        ).body;
    const apply = (f: Fixture, processId: string) =>
        app
            .get<FinancialClosureDestinationsPort>(
                FINANCIAL_CLOSURE_DESTINATIONS_PORT,
            )
            .applyApproved(
                f.a.context.person.id,
                f.space,
                processId,
                app.get<ClosureClock>(CLOSURE_CLOCK).now(),
            );
    function approvedApplicationPort() {
        const port = app.get<SpaceClosurePort>(SPACE_CLOSURE_PORT),
            lock = port.lockForProcess.bind(port);
        vi.spyOn(port, 'lockForProcess').mockImplementation(async (...args) => {
            const plan = await lock(...args);
            return plan
                ? {
                      ...plan,
                      planStatus: 'APPROVED' as const,
                      approvals: plan.requiredMemberIds.map((memberId) => ({
                          memberId,
                          planRevision: plan.planRevision,
                          recordedAt: app
                              .get<ClosureClock>(CLOSURE_CLOCK)
                              .now()
                              .toISOString(),
                      })),
                  }
                : null;
        });
    }
    const command = (
        plan: PlanVersion,
        originType: 'RECURRING' | 'INSTALLMENT',
        originId: string,
        destination: string,
        extra: object = {},
    ) => ({
        ...versionInput(plan),
        originType,
        originId,
        expectedOriginVersion: 1,
        destination,
        ...extra,
    });

    it.each(['solo', 'bilateral'] as const)(
        'plans personal continuity in a %s space without financial effects or fictitious consent',
        async (mode) => {
            const f = await fixture(mode),
                root = await recurring(f),
                plan = await begin(f),
                before = await financeSnapshot(db),
                result = await f.a
                    .post(
                        `${f.path}/future-destinations`,
                        command(
                            plan,
                            'RECURRING',
                            root.id,
                            'PERSONAL_SUCCESSOR',
                            { assigneeMemberId: f.memberIds[0] },
                        ),
                    )
                    .expect(200);
            expect(result.headers['cache-control']).toBe('no-store');
            expect(result.body).toMatchObject({
                planStatus: 'DRAFT',
                planRevision: 2,
                spaceVersion: plan.spaceVersion + 1,
                requiredMemberIds: f.memberIds,
                approvals: [],
                confirmations: [],
            });
            expect(result.body.futureDestinations).toHaveLength(1);
            expect(result.body.futureDestinations[0]).toMatchObject({
                originType: 'RECURRING',
                originId: root.id,
                expectedOriginVersion: 1,
                destination: 'PERSONAL_SUCCESSOR',
                assigneeMemberId: f.memberIds[0],
                amountInCents: null,
                cutoffDate: closureDay,
                originSnapshot: {
                    version: 1,
                    kind: 'EXPENSE',
                    fingerprint: expect.any(String),
                    recurringImpacts: [
                        expect.objectContaining({
                            basis: 'PER_OCCURRENCE',
                            valueMode: 'FIXED',
                            amountInCents: 3000,
                            impactByMember: expect.arrayContaining([
                                expect.objectContaining({
                                    memberId: f.memberIds[0],
                                    beforeInCents: String(
                                        3000 / f.memberIds.length,
                                    ),
                                    afterInCents: '3000',
                                    beforeBasisPoints:
                                        10000 / f.memberIds.length,
                                    afterBasisPoints: 10000,
                                }),
                            ]),
                        }),
                    ],
                },
            });
            expect(await financeSnapshot(db)).toEqual(before);
        },
    );

    it.each([
        ['EXPENSE', false],
        ['INCOME', false],
        ['EXPENSE', true],
        ['INCOME', true],
    ] as const)(
        'previews a %s recurrence with variable=%s and virtual future without materializing occurrences',
        async (kind, variable) => {
            const f = await fixture(),
                root = await recurring(f, kind, variable),
                plan = await begin(f),
                before = await financeSnapshot(db),
                result = (
                    await f.a
                        .post(
                            `${f.path}/future-destinations`,
                            command(plan, 'RECURRING', root.id, 'TERMINATE'),
                        )
                        .expect(200)
                ).body,
                destination = result.futureDestinations[0];
            expect(destination.originSnapshot).toMatchObject({
                kind,
                version: 1,
                futureItems: expect.any(Array),
            });
            expect(
                destination.originSnapshot.futureItems.length,
            ).toBeGreaterThan(0);
            expect(destination.originSnapshot.futureItems[0]).toMatchObject({
                originItemId: null,
                referenceDate: futureDate(),
                remainingInCents: variable ? null : 3000,
            });
            expect(
                await db.query(
                    'SELECT id FROM financial_occurrences WHERE commitment_id=$1',
                    [root.id],
                ),
            ).toEqual([]);
            expect(await financeSnapshot(db)).toEqual(before);
        },
    );

    it('shows the increased responsibility and required acceptance when one member indicates the other', async () => {
        const f = await fixture(),
            root = await installments(f),
            plan = await begin(f),
            before = await financeSnapshot(db),
            result = (
                await f.a
                    .post(
                        `${f.path}/future-destinations`,
                        command(
                            plan,
                            'INSTALLMENT',
                            root.id,
                            'PERSONAL_SUCCESSOR',
                            { assigneeMemberId: f.memberIds[1] },
                        ),
                    )
                    .expect(200)
            ).body;
        expect(result.futureDestinations[0].impactByMember).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    memberId: f.memberIds[1],
                    beforeInCents: '1500',
                    afterInCents: '3000',
                    requiresAcceptance: true,
                }),
                expect.objectContaining({
                    memberId: f.memberIds[0],
                    afterInCents: '0',
                }),
            ]),
        );
        expect(result.approvals).toEqual([]);
        expect(JSON.stringify(result)).not.toContain(
            f.other!.context.personalSpace.id,
        );
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('records the manually agreed resolution amount without payments, transfers or obligations', async () => {
        const f = await fixture(),
            root = await recurring(f),
            plan = await begin(f),
            before = await financeSnapshot(db),
            result = (
                await f.a
                    .post(
                        `${f.path}/future-destinations`,
                        command(
                            plan,
                            'RECURRING',
                            root.id,
                            'SETTLE_BEFORE_CLOSURE',
                            {
                                amountInCents: 2500,
                                assigneeMemberId: f.memberIds[0],
                            },
                        ),
                    )
                    .expect(200)
            ).body;
        expect(result.futureDestinations[0]).toMatchObject({
            originId: root.id,
            destination: 'SETTLE_BEFORE_CLOSURE',
            amountInCents: 2500,
        });
        expect(await financeSnapshot(db)).toEqual(before);
        expect(
            await db.query(
                'SELECT id FROM inter_member_obligations WHERE space_id=$1',
                [f.space],
            ),
        ).toEqual([]);
    });

    it('rejects a fictitious inter-member agreement while the creator remains the only historical participant', async () => {
        const f = await fixture('solo'),
            root = await recurring(f),
            plan = await begin(f),
            before = await snapshot(),
            result = await f.a
                .post(
                    `${f.path}/future-destinations`,
                    command(
                        plan,
                        'RECURRING',
                        root.id,
                        'SETTLE_BEFORE_CLOSURE',
                        {
                            amountInCents: 2500,
                            assigneeMemberId: f.memberIds[0],
                        },
                    ),
                )
                .expect(409);
        expect(result.body.code).toBe(
            'FINANCIAL_CLOSURE_AGREEMENT_REQUIRES_TWO',
        );
        expect(await snapshot()).toEqual(before);
    });

    it('previews only actual installment remainders after partial payment, anticipation and cancellation', async () => {
        const f = await fixture(),
            root = await installments(f),
            [partial, cancelled, anticipated] = root.plan.installments,
            base = `/v2/spaces/${f.space}/installment-commitments/${root.id}`,
            payment = (
                await f.a
                    .post(`${base}/installments/${partial.id}/disbursements`, {
                        expectedCommitmentVersion: 1,
                        expectedInstallmentVersion: 1,
                        expectedSpaceVersion: f.context.version,
                        amountInCents: 300,
                        factDate: closureDay,
                        method: 'PIX',
                        payerMemberId: f.memberIds[0],
                        settlement: { mode: 'NONE' },
                    })
                    .expect(201)
            ).body,
            anticipation = (
                await f.a
                    .post(`${base}/anticipations`, {
                        selection: {
                            mode: 'IDS',
                            installmentIds: [anticipated.id],
                        },
                        values: [
                            {
                                installmentId: anticipated.id,
                                expectedInstallmentVersion: 1,
                                paidAmountInCents: 1000,
                            },
                        ],
                        expectedCommitmentVersion: payment.commitment.version,
                        expectedSpaceVersion: f.context.version,
                        factDate: closureDay,
                        method: 'PIX',
                        payerMemberId: f.memberIds[0],
                        settlement: { mode: 'NONE' },
                    })
                    .expect(201)
            ).body,
            cancellation = (
                await f.a
                    .post(`${base}/future-installment-cancellations`, {
                        installments: [
                            {
                                installmentId: cancelled.id,
                                expectedInstallmentVersion: 1,
                            },
                        ],
                        expectedCommitmentVersion:
                            anticipation.commitment.version,
                        expectedSpaceVersion: f.context.version,
                        factDate: closureDay,
                        reason: 'Parte extinta do contrato',
                    })
                    .expect(201)
            ).body,
            plan = await begin(f),
            before = await financeSnapshot(db),
            result = (
                await f.a
                    .post(
                        `${f.path}/future-destinations`,
                        command(
                            plan,
                            'INSTALLMENT',
                            root.id,
                            'PERSONAL_SUCCESSOR',
                            {
                                expectedOriginVersion:
                                    cancellation.commitment.version,
                                assigneeMemberId: f.memberIds[0],
                            },
                        ),
                    )
                    .expect(200)
            ).body,
            impact = result.futureDestinations[0].originSnapshot;
        expect(impact.eligibleRemainingInCents).toBe('700');
        expect(impact.futureItems).toHaveLength(1);
        expect(impact.futureItems[0]).toMatchObject({
            originItemId: partial.id,
            remainingInCents: 700,
        });
        expect(JSON.stringify(impact.futureItems)).not.toContain(cancelled.id);
        expect(JSON.stringify(impact.futureItems)).not.toContain(
            anticipated.id,
        );
        expect(await financeSnapshot(db)).toEqual(before);
        const facts = await db.query(
            'SELECT * FROM financial_disbursements WHERE commitment_id=$1 ORDER BY id',
            [root.id],
        );
        approvedApplicationPort();
        const effects = await apply(f, plan.processId),
            successorId = effects[0]!.successorCommitmentId;
        expect(successorId).toEqual(expect.any(String));
        expect(
            await db.query(
                'SELECT amount_in_cents::text AS amount,due_date::text FROM financial_installments WHERE commitment_id=$1 ORDER BY position',
                [successorId],
            ),
        ).toEqual([{ amount: '700', due_date: partial.dueDate }]);
        expect(
            await db.query(
                'SELECT * FROM financial_disbursements WHERE commitment_id=$1 ORDER BY id',
                [root.id],
            ),
        ).toEqual(facts);
        expect(
            await db.query(
                'SELECT id FROM financial_disbursements WHERE commitment_id=$1',
                [successorId],
            ),
        ).toEqual([]);
    });

    it('refuses financial application of a draft even after all destinations have been selected', async () => {
        const f = await fixture('solo'),
            root = await recurring(f),
            plan = await begin(f);
        await f.a
            .post(
                `${f.path}/future-destinations`,
                command(plan, 'RECURRING', root.id, 'PERSONAL_SUCCESSOR', {
                    assigneeMemberId: f.memberIds[0],
                }),
            )
            .expect(200);
        const before = await snapshot();
        await expect(apply(f, plan.processId)).rejects.toMatchObject({
            code: 'FINANCIAL_CLOSURE_PLAN_NOT_APPROVED',
        });
        expect(await snapshot()).toEqual(before);
    });

    it('applies an authorized personal successor once, preserving ownership, authorship and calendar boundaries', async () => {
        const f = await fixture(),
            root = await recurring(f),
            plan = await begin(f);
        await f.a
            .post(
                `${f.path}/future-destinations`,
                command(plan, 'RECURRING', root.id, 'PERSONAL_SUCCESSOR', {
                    assigneeMemberId: f.memberIds[1],
                }),
            )
            .expect(200);
        approvedApplicationPort();
        const effects = await apply(f, plan.processId),
            successorId = effects[0]!.successorCommitmentId,
            previous = new Date(`${closureDay}T12:00:00Z`);
        previous.setUTCDate(previous.getUTCDate() - 1);
        expect(effects).toHaveLength(1);
        expect(effects[0]).toMatchObject({
            originId: root.id,
            successorCommitmentId: expect.any(String),
            agreementObligationId: null,
        });
        expect(
            await db.query(
                'SELECT space_id,created_by,personal_owner_person_id,modality FROM financial_commitments WHERE id=$1',
                [successorId],
            ),
        ).toEqual([
            {
                space_id: f.other!.context.personalSpace.id,
                created_by: f.a.context.person.id,
                personal_owner_person_id: f.other!.context.person.id,
                modality: 'RECURRING',
            },
        ]);
        expect(
            await db.query(
                'SELECT ends_on::text FROM financial_recurrence_terminations WHERE commitment_id=$1',
                [root.id],
            ),
        ).toEqual([{ ends_on: previous.toISOString().slice(0, 10) }]);
        expect(
            await db.query(
                'SELECT frequency,day_of_month,value_mode,amount_in_cents::text AS amount FROM financial_recurrence_versions WHERE commitment_id=$1',
                [successorId],
            ),
        ).toEqual([
            {
                frequency: 'MONTHLY',
                day_of_month: 20,
                value_mode: 'FIXED',
                amount: '3000',
            },
        ]);
        await f
            .other!.agent.get(
                `/v2/spaces/${f.other!.context.personalSpace.id}/recurring-commitments/${successorId}`,
            )
            .expect(200);
        await f.a.agent
            .get(
                `/v2/spaces/${f.other!.context.personalSpace.id}/recurring-commitments/${successorId}`,
            )
            .expect(404);
        const thisMonth = (
                await f
                    .other!.agent.get(
                        `/v2/spaces/${f.other!.context.personalSpace.id}/recurring-commitments/${successorId}/occurrences?month=${closureDay.slice(0, 7)}`,
                    )
                    .expect(200)
            ).body,
            nextMonth = (
                await f
                    .other!.agent.get(
                        `/v2/spaces/${f.other!.context.personalSpace.id}/recurring-commitments/${successorId}/occurrences?month=${futureDate().slice(0, 7)}`,
                    )
                    .expect(200)
            ).body;
        expect(thisMonth.items).toEqual([]);
        expect(
            nextMonth.items.map(
                (item: { referenceDate: string }) => item.referenceDate,
            ),
        ).toEqual([futureDate()]);
        const before = await snapshot();
        expect(await apply(f, plan.processId)).toEqual(effects);
        expect(await snapshot()).toEqual(before);
    });

    it('retains an unknown variable occurrence amount in the personal successor', async () => {
        const f = await fixture(),
            root = await recurring(f, 'EXPENSE', true),
            plan = await begin(f);
        const planned = (
            await f.a
                .post(
                    `${f.path}/future-destinations`,
                    command(plan, 'RECURRING', root.id, 'PERSONAL_SUCCESSOR', {
                        assigneeMemberId: f.memberIds[0],
                    }),
                )
                .expect(200)
        ).body;
        expect(
            planned.futureDestinations[0].originSnapshot.recurringImpacts,
        ).toEqual([
            expect.objectContaining({
                basis: 'PER_OCCURRENCE',
                valueMode: 'VARIABLE',
                amountInCents: null,
                impactByMember: expect.arrayContaining([
                    expect.objectContaining({
                        memberId: f.memberIds[0],
                        beforeInCents: null,
                        afterInCents: null,
                        beforeBasisPoints: 5000,
                        afterBasisPoints: 10000,
                    }),
                    expect.objectContaining({
                        memberId: f.memberIds[1],
                        beforeInCents: null,
                        afterInCents: '0',
                        beforeBasisPoints: 5000,
                        afterBasisPoints: 0,
                    }),
                ]),
            }),
        ]);
        approvedApplicationPort();
        const effects = await apply(f, plan.processId),
            successorId = effects[0]!.successorCommitmentId,
            projections = (
                await f.a.agent
                    .get(
                        `/v2/spaces/${f.a.context.personalSpace.id}/recurring-commitments/${successorId}/occurrences?month=${futureDate().slice(0, 7)}`,
                    )
                    .expect(200)
            ).body;
        expect(projections.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    referenceDate: futureDate(),
                    amountInCents: null,
                    valuePending: true,
                }),
            ]),
        );
        expect(
            await db.query(
                'SELECT id FROM financial_occurrences WHERE commitment_id=$1',
                [successorId],
            ),
        ).toEqual([]);
    });

    it('preserves each already agreed future calendar and amount version in the personal successor', async () => {
        const f = await fixture('solo'),
            root = await recurring(f),
            changed = (
                await f.a
                    .post(
                        `/v2/spaces/${f.space}/recurring-commitments/${root.id}/versions`,
                        {
                            scope: 'SHARED',
                            kind: 'EXPENSE',
                            valueMode: 'FIXED',
                            description:
                                'Compromisso com calendário futuro reajustado',
                            amountInCents: 4500,
                            recurrence: {
                                frequency: 'MONTHLY',
                                dayOfMonth: 25,
                            },
                            effectiveFrom: futureDate(2, 1),
                            expectedCommitmentVersion: 1,
                            expectedSpaceVersion: f.context.version,
                            expectedMemberId: f.memberIds[0],
                            distribution: {
                                mode: 'PERCENTAGES',
                                shares: [
                                    {
                                        memberId: f.memberIds[0],
                                        basisPoints: 10000,
                                    },
                                ],
                            },
                        },
                    )
                    .expect(201)
            ).body,
            plan = await begin(f);
        await f.a
            .post(
                `${f.path}/future-destinations`,
                command(plan, 'RECURRING', root.id, 'PERSONAL_SUCCESSOR', {
                    expectedOriginVersion: changed.commitment.version,
                    assigneeMemberId: f.memberIds[0],
                }),
            )
            .expect(200);
        approvedApplicationPort();
        const effects = await apply(f, plan.processId),
            successorId = effects[0]!.successorCommitmentId,
            firstMonth = (
                await f.a.agent
                    .get(
                        `/v2/spaces/${f.a.context.personalSpace.id}/recurring-commitments/${successorId}/occurrences?month=${futureDate().slice(0, 7)}`,
                    )
                    .expect(200)
            ).body,
            changedMonth = (
                await f.a.agent
                    .get(
                        `/v2/spaces/${f.a.context.personalSpace.id}/recurring-commitments/${successorId}/occurrences?month=${futureDate(2).slice(0, 7)}`,
                    )
                    .expect(200)
            ).body;
        expect(firstMonth.items).toMatchObject([
            { referenceDate: futureDate(), amountInCents: 3000 },
        ]);
        expect(changedMonth.items).toMatchObject([
            { referenceDate: futureDate(2, 25), amountInCents: 4500 },
        ]);
        expect(firstMonth.items).toHaveLength(1);
        expect(changedMonth.items).toHaveLength(1);
    });

    it('keeps a previously agreed recurrence termination in the personal successor instead of recreating an endless rule', async () => {
        const f = await fixture('solo'),
            root = await recurring(f),
            terminated = (
                await f.a
                    .post(
                        `/v2/spaces/${f.space}/recurring-commitments/${root.id}/termination`,
                        {
                            expectedCommitmentVersion: 1,
                            expectedSpaceVersion: f.context.version,
                            endsOn: futureDate(2),
                        },
                    )
                    .expect(201)
            ).body,
            plan = await begin(f);
        await f.a
            .post(
                `${f.path}/future-destinations`,
                command(plan, 'RECURRING', root.id, 'PERSONAL_SUCCESSOR', {
                    expectedOriginVersion: terminated.commitment.version,
                    assigneeMemberId: f.memberIds[0],
                }),
            )
            .expect(200);
        approvedApplicationPort();
        const effects = await apply(f, plan.processId),
            successorId = effects[0]!.successorCommitmentId;
        expect(
            await db.query(
                'SELECT ends_on::text FROM financial_recurrence_versions WHERE commitment_id=$1 ORDER BY version',
                [successorId],
            ),
        ).toEqual([{ ends_on: futureDate(2) }]);
        const lastMonth = (
                await f.a.agent
                    .get(
                        `/v2/spaces/${f.a.context.personalSpace.id}/recurring-commitments/${successorId}/occurrences?month=${futureDate(2).slice(0, 7)}`,
                    )
                    .expect(200)
            ).body,
            afterTermination = (
                await f.a.agent
                    .get(
                        `/v2/spaces/${f.a.context.personalSpace.id}/recurring-commitments/${successorId}/occurrences?month=${futureDate(3).slice(0, 7)}`,
                    )
                    .expect(200)
            ).body;
        expect(lastMonth.items).toMatchObject([
            { referenceDate: futureDate(2) },
        ]);
        expect(afterTermination.items).toEqual([]);
    });

    it('applies an approved manual agreement as a traceable obligation without recording any payment or receipt', async () => {
        const f = await fixture(),
            root = await recurring(f),
            plan = await begin(f);
        await f.a
            .post(
                `${f.path}/future-destinations`,
                command(plan, 'RECURRING', root.id, 'SETTLE_BEFORE_CLOSURE', {
                    assigneeMemberId: f.memberIds[0],
                    amountInCents: 2500,
                }),
            )
            .expect(200);
        approvedApplicationPort();
        const effects = await apply(f, plan.processId);
        expect(effects[0]).toMatchObject({
            originId: root.id,
            successorCommitmentId: expect.any(String),
            agreementObligationId: expect.any(String),
        });
        expect(
            await db.query(
                'SELECT debtor_member_id,creditor_member_id,original_amount_in_cents::text AS amount,closure_agreement_id FROM inter_member_obligations WHERE id=$1',
                [effects[0]!.agreementObligationId],
            ),
        ).toEqual([
            {
                debtor_member_id: f.memberIds[1],
                creditor_member_id: f.memberIds[0],
                amount: '2500',
                closure_agreement_id: effects[0]!.effectId,
            },
        ]);
        expect(
            await db.query(
                'SELECT (SELECT count(*) FROM financial_disbursements)::int AS disbursements,(SELECT count(*) FROM financial_receipts)::int AS receipts,(SELECT count(*) FROM settlement_transfers)::int AS transfers',
            ),
        ).toEqual([{ disbursements: 0, receipts: 0, transfers: 0 }]);
        const before = await snapshot();
        expect(await apply(f, plan.processId)).toEqual(effects);
        expect(await snapshot()).toEqual(before);
    });

    it('rejects an approved snapshot when its financial origin changes before application', async () => {
        const f = await fixture('solo'),
            root = await recurring(f, 'EXPENSE', false, futureDate(-1, 1)),
            plan = await begin(f),
            planned = (
                await f.a
                    .post(
                        `${f.path}/future-destinations`,
                        command(plan, 'RECURRING', root.id, 'TERMINATE'),
                    )
                    .expect(200)
            ).body;
        await f.a
            .post(
                `/v2/spaces/${f.space}/financial-commitments/${root.id}/adjustments`,
                {
                    expectedCommitmentVersion: 1,
                    expectedOccurrenceVersion: 1,
                    expectedSpaceVersion: planned.spaceVersion,
                    referenceDate: futureDate(-1),
                    direction: 'DECREASE',
                    amountInCents: 100,
                    reason: 'Correção histórica anterior ao corte',
                    factDate: closureDay,
                },
            )
            .expect(201);
        approvedApplicationPort();
        const before = await snapshot();
        await expect(apply(f, plan.processId)).rejects.toMatchObject({
            code: 'FINANCIAL_CLOSURE_ORIGIN_CHANGED',
        });
        expect(await snapshot()).toEqual(before);
    });

    it('rolls back the origin, successor, effect and audit if creating the personal recurrence fails', async () => {
        const f = await fixture(),
            root = await recurring(f),
            plan = await begin(f);
        await f.a
            .post(
                `${f.path}/future-destinations`,
                command(plan, 'RECURRING', root.id, 'PERSONAL_SUCCESSOR', {
                    assigneeMemberId: f.memberIds[1],
                }),
            )
            .expect(200);
        approvedApplicationPort();
        const before = await snapshot();
        await db.query(
            'ALTER TABLE financial_recurrence_versions ADD CONSTRAINT test_reject_successor CHECK (false) NOT VALID',
        );
        try {
            await expect(apply(f, plan.processId)).rejects.toThrow();
            expect(await snapshot()).toEqual(before);
        } finally {
            await db.query(
                'ALTER TABLE financial_recurrence_versions DROP CONSTRAINT test_reject_successor',
            );
        }
    });

    it('rolls back the already prepared successor and origin transition if financial auditing fails', async () => {
        const f = await fixture(),
            root = await recurring(f),
            plan = await begin(f);
        await f.a
            .post(
                `${f.path}/future-destinations`,
                command(plan, 'RECURRING', root.id, 'PERSONAL_SUCCESSOR', {
                    assigneeMemberId: f.memberIds[1],
                }),
            )
            .expect(200);
        approvedApplicationPort();
        const before = await snapshot();
        await db.query(
            'ALTER TABLE financial_command_audit ADD CONSTRAINT test_reject_closure_audit CHECK (false) NOT VALID',
        );
        try {
            await expect(apply(f, plan.processId)).rejects.toThrow();
            expect(await snapshot()).toEqual(before);
        } finally {
            await db.query(
                'ALTER TABLE financial_command_audit DROP CONSTRAINT test_reject_closure_audit',
            );
        }
    });

    it('continues only the remaining value of a previously materialized future recurrence while preserving its original facts', async () => {
        const f = await fixture(),
            root = await recurring(f),
            futurePath = `/v2/spaces/${f.space}/recurring-commitments/${root.id}/occurrences/${futureDate()}`;
        await f.a
            .post(`${futurePath}/disbursements`, {
                expectedCommitmentVersion: 1,
                expectedOccurrenceVersion: 1,
                expectedSpaceVersion: f.context.version,
                amountInCents: 300,
                factDate: closureDay,
                method: 'PIX',
                payerMemberId: f.memberIds[0],
                settlement: { mode: 'NONE' },
            })
            .expect(201);
        const plan = await begin(f),
            originalFacts = await db.query(
                'SELECT * FROM financial_disbursements WHERE commitment_id=$1 ORDER BY id',
                [root.id],
            ),
            planned = (
                await f.a
                    .post(
                        `${f.path}/future-destinations`,
                        command(
                            plan,
                            'RECURRING',
                            root.id,
                            'PERSONAL_SUCCESSOR',
                            { assigneeMemberId: f.memberIds[0] },
                        ),
                    )
                    .expect(200)
            ).body;
        expect(
            planned.futureDestinations[0].originSnapshot.futureItems,
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    referenceDate: futureDate(),
                    remainingInCents: 2700,
                    originItemId: expect.any(String),
                }),
            ]),
        );
        approvedApplicationPort();
        const effects = await apply(f, plan.processId),
            successorId = effects[0]!.successorCommitmentId;
        expect(
            await db.query(
                'SELECT amount_in_cents::text AS amount,status,reference_date::text FROM financial_occurrences WHERE commitment_id=$1',
                [successorId],
            ),
        ).toEqual([
            { amount: '2700', status: 'PENDING', reference_date: futureDate() },
        ]);
        expect(
            await db.query(
                'SELECT * FROM financial_disbursements WHERE commitment_id=$1 ORDER BY id',
                [root.id],
            ),
        ).toEqual(originalFacts);
        expect(
            await db.query(
                'SELECT id FROM financial_disbursements WHERE commitment_id=$1',
                [successorId],
            ),
        ).toEqual([]);
        const before = await snapshot();
        await f.a
            .post(`${futurePath}/disbursements`, {
                expectedCommitmentVersion: 2,
                expectedOccurrenceVersion: 2,
                expectedSpaceVersion: planned.spaceVersion,
                amountInCents: 2700,
                factDate: closureDay,
                method: 'PIX',
                payerMemberId: f.memberIds[0],
                settlement: { mode: 'NONE' },
            })
            .expect(409);
        expect(await snapshot()).toEqual(before);
        await f.a
            .post(
                `/v2/spaces/${f.space}/financial-commitments/${root.id}/reversals`,
                {
                    expectedCommitmentVersion: 2,
                    expectedOccurrenceVersion: 2,
                    expectedSpaceVersion: planned.spaceVersion,
                    referenceDate: futureDate(),
                    originalKind: 'DISBURSEMENT',
                    originalId: originalFacts[0].id,
                    amountInCents: 100,
                    factDate: closureDay,
                    reason: 'Revisão material após aplicação do destino',
                    settlement: { mode: 'NONE' },
                },
            )
            .expect(409);
        expect(await snapshot()).toEqual(before);
    });

    it('keeps an existing external liability and its internal obligations after terminating the recurrence future', async () => {
        const f = await fixture(),
            root = await recurring(f),
            futurePath = `/v2/spaces/${f.space}/recurring-commitments/${root.id}/occurrences/${futureDate()}`;
        await f.a
            .post(`${futurePath}/external-liabilities`, {
                expectedCommitmentVersion: 1,
                expectedOccurrenceVersion: 1,
                expectedSpaceVersion: f.context.version,
                amountInCents: 3000,
                factDate: closureDay,
                holderMemberId: f.memberIds[0],
                settlement: { mode: 'NONE' },
            })
            .expect(201);
        const plan = await begin(f),
            originalLiabilities = await db.query(
                'SELECT * FROM financial_external_liabilities WHERE commitment_id=$1 ORDER BY id',
                [root.id],
            ),
            originalObligations = await db.query(
                'SELECT * FROM inter_member_obligations WHERE commitment_id=$1 ORDER BY id',
                [root.id],
            );
        await f.a
            .post(
                `${f.path}/future-destinations`,
                command(plan, 'RECURRING', root.id, 'TERMINATE'),
            )
            .expect(200);
        approvedApplicationPort();
        await apply(f, plan.processId);
        expect(
            await db.query(
                'SELECT * FROM financial_external_liabilities WHERE commitment_id=$1 ORDER BY id',
                [root.id],
            ),
        ).toEqual(originalLiabilities);
        expect(
            await db.query(
                'SELECT * FROM inter_member_obligations WHERE commitment_id=$1 ORDER BY id',
                [root.id],
            ),
        ).toEqual(originalObligations);
        const diagnostic = (
            await f.a.agent.get(`${f.path}/diagnostic`).expect(200)
        ).body;
        expect(diagnostic.finance).toMatchObject({
            financiallyReady: false,
            counts: { OPEN_EXTERNAL_LIABILITY: 1 },
        });
    });

    it('revises one origin in place while retaining both versions in history and replaying the historical result', async () => {
        const f = await fixture(),
            root = await recurring(f),
            plan = await begin(f),
            key = randomUUID(),
            input = command(plan, 'RECURRING', root.id, 'TERMINATE'),
            first = (
                await f.a
                    .post(`${f.path}/future-destinations`, input, key)
                    .expect(200)
            ).body,
            changed = (
                await f
                    .other!.post(
                        `${f.path}/future-destinations`,
                        command(
                            first,
                            'RECURRING',
                            root.id,
                            'PERSONAL_SUCCESSOR',
                            { assigneeMemberId: f.memberIds[1] },
                        ),
                    )
                    .expect(200)
            ).body;
        expect(changed).toMatchObject({
            planRevision: 3,
            approvals: [],
            confirmations: [],
        });
        expect(changed.futureDestinations).toHaveLength(1);
        expect(changed.futureDestinations[0].destination).toBe(
            'PERSONAL_SUCCESSOR',
        );
        const before = await snapshot();
        expect(
            (
                await f.a
                    .post(`${f.path}/future-destinations`, input, key)
                    .expect(200)
            ).body,
        ).toEqual(first);
        await f.a
            .post(
                `${f.path}/future-destinations`,
                {
                    ...input,
                    destination: 'PERSONAL_SUCCESSOR',
                    assigneeMemberId: f.memberIds[0],
                },
                key,
            )
            .expect(409);
        expect(await snapshot()).toEqual(before);
        const history = (
            await f.a.agent.get(`${f.path}/history`).expect(200)
        ).body.items.filter(
            (item: { action: string }) =>
                item.action === 'UPSERT_CLOSURE_DESTINATION',
        );
        expect(history).toHaveLength(2);
        expect(
            history
                .map((item: { planRevision: number }) => item.planRevision)
                .sort(),
        ).toEqual([2, 3]);
        expect(
            history.find(
                (item: { planRevision: number }) => item.planRevision === 2,
            ).snapshot.futureDestinations[0].destination,
        ).toBe('TERMINATE');
    });

    it('rejects stale plan, space and origin versions and does not duplicate an unchanged destination', async () => {
        const f = await fixture(),
            root = await recurring(f),
            plan = await begin(f),
            input = command(plan, 'RECURRING', root.id, 'TERMINATE'),
            before = await snapshot();
        for (const field of [
            'expectedSpaceVersion',
            'expectedPlanRevision',
            'expectedOriginVersion',
        ] as const)
            await f.a
                .post(`${f.path}/future-destinations`, {
                    ...input,
                    [field]: input[field] + 1,
                })
                .expect(409);
        expect(await snapshot()).toEqual(before);
        const first = (
                await f.a
                    .post(`${f.path}/future-destinations`, input)
                    .expect(200)
            ).body,
            after = await snapshot();
        await f.a
            .post(`${f.path}/future-destinations`, {
                ...input,
                ...versionInput(first),
            })
            .expect(409);
        expect(await snapshot()).toEqual(after);
    });

    it('rejects nonexistent and foreign origins, nonexistent assignees and arbitrary personal-space targeting', async () => {
        const f = await fixture('solo'),
            foreign = await fixture('solo'),
            root = await recurring(f),
            foreignRoot = await recurring(foreign),
            plan = await begin(f),
            before = await snapshot(),
            input = command(plan, 'RECURRING', root.id, 'TERMINATE');
        for (const originId of [randomUUID(), foreignRoot.id])
            await f.a
                .post(`${f.path}/future-destinations`, { ...input, originId })
                .expect(404);
        await f.a
            .post(`${f.path}/future-destinations`, {
                ...input,
                originType: 'INSTALLMENT',
            })
            .expect(404);
        await f.a
            .post(`${f.path}/future-destinations`, {
                ...input,
                destination: 'PERSONAL_SUCCESSOR',
                assigneeMemberId: foreign.memberIds[0],
            })
            .expect(400);
        await f.a
            .post(`${f.path}/future-destinations`, {
                ...input,
                destination: 'PERSONAL_SUCCESSOR',
                assigneeMemberId: f.memberIds[0],
                personalSpaceId: foreign.a.context.personalSpace.id,
            })
            .expect(400);
        await foreign.a
            .post(`${f.path}/future-destinations`, input)
            .expect(404);
        expect(await snapshot()).toEqual(before);
    });

    it('requires an open closure and validates destination-specific fields atomically', async () => {
        const f = await fixture(),
            root = await recurring(f),
            raw = command(
                { spaceVersion: f.context.version, planRevision: 1 },
                'RECURRING',
                root.id,
                'TERMINATE',
            );
        await f.a.post(`${f.path}/future-destinations`, raw).expect(409);
        const plan = await begin(f),
            input = { ...raw, ...versionInput(plan) },
            before = await snapshot();
        for (const patch of [
            { destination: 'PERSONAL_SUCCESSOR' },
            { destination: 'SETTLE_BEFORE_CLOSURE' },
            { destination: 'SETTLE_BEFORE_CLOSURE', amountInCents: 0 },
            {
                destination: 'PERSONAL_SUCCESSOR',
                assigneeMemberId: randomUUID(),
            },
            { destination: 'UNKNOWN' },
            { expectedOriginVersion: 0 },
            { originType: 'ONE_TIME' },
        ])
            await f.a
                .post(`${f.path}/future-destinations`, { ...input, ...patch })
                .expect(400);
        expect(await snapshot()).toEqual(before);
    });

    it.each(['space_closure_history', 'space_closure_audit'])(
        'rolls back a destination revision and receipt when %s fails',
        async (table) => {
            const f = await fixture(),
                root = await recurring(f),
                plan = await begin(f),
                before = await snapshot();
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            await db.query(
                `ALTER TABLE ${table} ADD CONSTRAINT test_reject_destination CHECK (false) NOT VALID`,
            );
            try {
                await f.a
                    .post(
                        `${f.path}/future-destinations`,
                        command(plan, 'RECURRING', root.id, 'TERMINATE'),
                    )
                    .expect(500);
                expect(await snapshot()).toEqual(before);
            } finally {
                await db.query(
                    `ALTER TABLE ${table} DROP CONSTRAINT test_reject_destination`,
                );
            }
        },
    );

    it('registers future destination planning in executable OpenAPI', () => {
        expect(
            createApiOpenApiDocument(false).paths[
                '/v2/spaces/{spaceId}/closure/future-destinations'
            ]?.post,
        ).toBeDefined();
    });
});
