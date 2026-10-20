import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Logger, type INestApplication } from '@nestjs/common';
import request from 'supertest';
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
import { financeBrowser, financeSnapshot } from './settlement-fixture.js';
import {
    prepareShoppingDatabase,
    shoppingSnapshot,
} from './shopping-fixture.js';
import { routineSnapshot } from './routine-fixture.js';
import {
    closureFinance,
    closureApp,
    closureSnapshot,
    competingClosureCommands,
    futureClosureRecurrence,
} from './closure-fixture.js';
import {
    FINANCIAL_CLOSURE_DESTINATIONS_PORT,
    type FinancialClosureDestinationsPort,
} from '../dist/modules/finances/application/ports/public/financial-closure-destinations.port.js';
import { createApiOpenApiDocument } from '../dist/composition/http/create-api-openapi-document.js';

type Version = {
    spaceVersion: number;
    planRevision: number;
    processId: string;
};
type Fixture = Awaited<ReturnType<typeof closureFinance>>;

describe('closure financial resolution and validation HTTP/PostgreSQL', () => {
    let app: INestApplication<Server>, db: DataSource, day: string;
    beforeAll(prepareShoppingDatabase);
    beforeEach(async () => {
        ({ app, db, day } = await closureApp());
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        await app?.close();
    });
    const snapshot = () =>
        Promise.all([
            closureSnapshot(db),
            financeSnapshot(db),
            routineSnapshot(db),
            shoppingSnapshot(db),
        ]);
    const versions = (view: Version) => ({
        expectedSpaceVersion: view.spaceVersion,
        expectedPlanRevision: view.planRevision,
    });
    function monthDate(months: number, date = 1) {
        const value = new Date(`${day.slice(0, 7)}-01T12:00:00Z`);
        value.setUTCMonth(value.getUTCMonth() + months);
        value.setUTCDate(date);
        return value.toISOString().slice(0, 10);
    }
    const validation = async (f: Fixture) =>
        (await f.a.agent.get(`${f.path}/financial-validation`).expect(200))
            .body;
    const begin = async (f: Fixture) =>
        (
            await f.a
                .post(f.path, { expectedSpaceVersion: f.context.version })
                .expect(201)
        ).body;
    async function approve(f: Fixture, view: Version) {
        const reviewed = (
                await f.a.agent.get(`${f.path}/plan-review`).expect(200)
            ).body,
            proposed = (
                await f.a
                    .post(`${f.path}/proposal`, {
                        ...versions(view),
                        expectedFinancialFingerprint:
                            reviewed.finance.fingerprint,
                    })
                    .expect(200)
            ).body;
        return f.b
            ? (
                  await f.b
                      .post(`${f.path}/approval`, {
                          ...versions(proposed),
                          expectedFinancialFingerprint:
                              proposed.proposalSnapshot.financialFingerprint,
                      })
                      .expect(200)
              ).body
            : proposed;
    }
    async function debt(
        f: Fixture,
        amount = 1000,
        payer = f.ma,
        targetDate: string | null = null,
    ) {
        const debtor = payer === f.ma ? f.mb! : f.ma;
        return (
            await f.a
                .post(`/v2/spaces/${f.space}/shared-cash-expenses`, {
                    expectedSpaceVersion: f.context.version,
                    description: 'Despesa anterior ao encerramento',
                    amountInCents: amount,
                    factDate: day,
                    expectedPayerMemberId: payer,
                    responsibilitySplit: {
                        mode: 'AMOUNTS',
                        shares: [
                            {
                                memberId: f.ma,
                                amountInCents: debtor === f.ma ? amount : 0,
                            },
                            {
                                memberId: f.mb,
                                amountInCents: debtor === f.mb ? amount : 0,
                            },
                        ],
                    },
                    disbursement: {
                        method: 'PIX',
                        payerMemberId: payer,
                        amountInCents: amount,
                    },
                    settlement: targetDate
                        ? { mode: 'DATE', targetDate }
                        : { mode: 'NONE' },
                })
                .expect(201)
        ).body;
    }
    async function transferInput(
        f: Fixture,
        plan: Version,
        obligationId: string,
        amount: number,
    ) {
        const [obligation] = await db.query(
            'SELECT version,debtor_member_id,creditor_member_id FROM inter_member_obligations WHERE id=$1',
            [obligationId],
        );
        return {
            expectedSpaceVersion: plan.spaceVersion,
            payerMemberId: obligation.debtor_member_id,
            recipientMemberId: obligation.creditor_member_id,
            amountInCents: amount,
            factDate: day,
            allocations: [
                {
                    obligationId,
                    expectedObligationVersion: obligation.version,
                    amountInCents: amount,
                },
            ],
        };
    }
    const transfer = async (
        f: Fixture,
        plan: Version,
        id: string,
        amount: number,
    ) =>
        (
            await f.a
                .post(
                    `/v2/spaces/${f.space}/settlement-transfers`,
                    await transferInput(f, plan, id, amount),
                )
                .expect(201)
        ).body;

    it('separates financial readiness from plan approval and final completion', async () => {
        const f = await closureFinance(app, 'solo'),
            started = await begin(f),
            before = await snapshot(),
            result = await validation(f);
        expect(result).toMatchObject({
            spaceId: f.space,
            processId: started.processId,
            planRevision: started.planRevision,
            spaceVersion: started.spaceVersion,
            planApproved: false,
            financiallyReady: true,
            canConfirm: false,
            blockers: [],
            totalCount: 0,
            financialFingerprint: expect.any(String),
        });
        expect(await snapshot()).toEqual(before);
        const approved = await approve(f, started),
            ready = await validation(f);
        expect(ready).toMatchObject({
            planApproved: true,
            financiallyReady: true,
            canConfirm: true,
            planRevision: approved.planRevision,
            spaceVersion: approved.spaceVersion,
        });
        expect(
            (await f.a.agent.get(`${f.path}/diagnostic`).expect(200)).body
                .closure,
        ).toMatchObject({
            spaceStatus: 'CLOSING',
            confirmations: [],
        });
    });

    it('uses partial and full allocated transfers, traces their closure context and replays without duplication', async () => {
        const f = await closureFinance(app),
            origin = await debt(f),
            plan = await approve(f, await begin(f)),
            input = await transferInput(f, plan, origin.obligation.id, 300),
            key = randomUUID(),
            first = (
                await f.a
                    .post(
                        `/v2/spaces/${f.space}/settlement-transfers`,
                        input,
                        key,
                    )
                    .expect(201)
            ).body,
            partial = await validation(f);
        expect(partial).toMatchObject({
            financiallyReady: false,
            canConfirm: false,
            counts: { INTER_MEMBER_OBLIGATION: 1 },
        });
        expect(partial.resolutions).toEqual(
            expect.arrayContaining([
                {
                    kind: 'TRANSFER',
                    id: first.transfer.id,
                    planRevision: plan.planRevision,
                    obligationIds: [origin.obligation.id],
                },
            ]),
        );
        expect(partial.outstandingAmounts).toEqual([
            {
                debtorMemberId: f.mb,
                creditorMemberId: f.ma,
                amountInCents: '700',
            },
        ]);
        const [audit] = await db.query(
            'SELECT payload FROM financial_settlement_audit WHERE transfer_id=$1',
            [first.transfer.id],
        );
        expect(audit.payload).toMatchObject({
            closure: {
                processId: plan.processId,
                planRevision: plan.planRevision,
            },
            obligationIds: [origin.obligation.id],
        });
        await transfer(f, plan, origin.obligation.id, 700);
        expect(await validation(f)).toMatchObject({
            financiallyReady: true,
            canConfirm: true,
            totalCount: 0,
        });
        const before = await snapshot(),
            replay = (
                await f.a
                    .post(
                        `/v2/spaces/${f.space}/settlement-transfers`,
                        input,
                        key,
                    )
                    .expect(200)
            ).body;
        expect(replay.transfer.id).toBe(first.transfer.id);
        expect(await snapshot()).toEqual(before);
    });

    it('does not treat reciprocal gross debt as resolved merely because its net balance is zero', async () => {
        const f = await closureFinance(app),
            first = await debt(f, 1000, f.ma),
            second = await debt(f, 1000, f.mb!),
            plan = await approve(f, await begin(f)),
            blocked = await validation(f);
        expect(blocked).toMatchObject({
            financiallyReady: false,
            canConfirm: false,
            counts: { INTER_MEMBER_OBLIGATION: 2 },
        });
        expect(blocked.outstandingAmounts).toEqual(
            expect.arrayContaining([
                {
                    debtorMemberId: f.mb,
                    creditorMemberId: f.ma,
                    amountInCents: '1000',
                },
                {
                    debtorMemberId: f.ma,
                    creditorMemberId: f.mb,
                    amountInCents: '1000',
                },
            ]),
        );
        const offset = (
            await f.a
                .post(`/v2/spaces/${f.space}/settlement-offsets`, {
                    expectedSpaceVersion: plan.spaceVersion,
                    factDate: day,
                    scope: {
                        cycleIds: [],
                        obligationIds: [
                            first.obligation.id,
                            second.obligation.id,
                        ],
                    },
                    expectedCycleVersions: [],
                    allocations: [first, second].map((origin) => ({
                        obligationId: origin.obligation.id,
                        expectedObligationVersion: 1,
                        amountInCents: 1000,
                    })),
                })
                .expect(201)
        ).body;
        expect(await validation(f)).toMatchObject({
            financiallyReady: true,
            canConfirm: true,
        });
        const [audit] = await db.query(
            'SELECT payload FROM settlement_offset_audit WHERE offset_id=$1',
            [offset.offset.id],
        );
        expect((await validation(f)).resolutions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'OFFSET',
                    id: offset.offset.id,
                    planRevision: plan.planRevision,
                }),
            ]),
        );
        expect(audit.payload).toMatchObject({
            closure: {
                processId: plan.processId,
                planRevision: plan.planRevision,
            },
        });
        expect(await db.query('SELECT id FROM settlement_transfers')).toEqual(
            [],
        );
    });

    it('allows only the creditor to waive part or all of an obligation during closure', async () => {
        const f = await closureFinance(app),
            origin = await debt(f),
            plan = await approve(f, await begin(f)),
            path = `/v2/spaces/${f.space}/inter-member-obligations/${origin.obligation.id}/waivers`,
            body = {
                expectedSpaceVersion: plan.spaceVersion,
                expectedObligationVersion: 1,
                amountInCents: 300,
                factDate: day,
            },
            before = await snapshot();
        await f.b!.post(path, body).expect(403);
        expect(await snapshot()).toEqual(before);
        await f.a.post(path, body).expect(201);
        expect((await validation(f)).outstandingAmounts).toEqual([
            {
                debtorMemberId: f.mb,
                creditorMemberId: f.ma,
                amountInCents: '700',
            },
        ]);
        await f.a
            .post(path, {
                ...body,
                expectedObligationVersion: 2,
                amountInCents: 700,
            })
            .expect(201);
        expect(await validation(f)).toMatchObject({
            financiallyReady: true,
            canConfirm: true,
        });
        const audit = await db.query(
            "SELECT payload FROM financial_settlement_adjustment_audit WHERE target_id=$1 AND action='WAIVE_INTER_MEMBER_OBLIGATION' ORDER BY registered_at,id",
            [origin.obligation.id],
        );
        expect(audit).toHaveLength(2);
        expect(
            (await validation(f)).resolutions.filter(
                (entry: { kind: string }) => entry.kind === 'WAIVER',
            ),
        ).toHaveLength(2);
        for (const entry of audit)
            expect(entry.payload).toMatchObject({
                closure: {
                    processId: plan.processId,
                    planRevision: plan.planRevision,
                },
            });
        expect(await db.query('SELECT id FROM settlement_transfers')).toEqual(
            [],
        );
    });

    it('still requires explicit cycle finalization after all its obligations have been resolved', async () => {
        const f = await closureFinance(app),
            origin = await debt(f, 1000, f.ma, day),
            plan = await approve(f, await begin(f));
        await transfer(f, plan, origin.obligation.id, 1000);
        expect(await validation(f)).toMatchObject({
            financiallyReady: false,
            counts: { INTER_MEMBER_OBLIGATION: 0, OPEN_SETTLEMENT_CYCLE: 1 },
        });
        const [cycle] = await db.query(
            'SELECT version FROM settlement_cycles WHERE id=$1',
            [origin.settlementCycle.id],
        );
        await f.a
            .post(
                `/v2/spaces/${f.space}/settlement-cycles/${origin.settlementCycle.id}/finalize`,
                {
                    expectedSpaceVersion: plan.spaceVersion,
                    expectedCycleVersion: cycle.version,
                },
            )
            .expect(200);
        expect(await validation(f)).toMatchObject({
            financiallyReady: true,
            canConfirm: true,
        });
    });

    it('keeps a solo external liability blocking even with no inter-member debt and becomes ready only after its actual settlement', async () => {
        const f = await closureFinance(app, 'solo'),
            origin = (
                await f.a
                    .post(`/v2/spaces/${f.space}/credit-card-purchases`, {
                        expectedSpaceVersion: f.context.version,
                        description: 'Responsabilidade externa real',
                        amountInCents: 1000,
                        factDate: day,
                        responsibilitySplit: {
                            mode: 'AMOUNTS',
                            shares: [{ memberId: f.ma, amountInCents: 1000 }],
                        },
                        externalLiability: {
                            holderMemberId: f.ma,
                            amountInCents: 1000,
                        },
                        settlement: { mode: 'NONE' },
                    })
                    .expect(201)
            ).body,
            plan = await approve(f, await begin(f));
        expect(await validation(f)).toMatchObject({
            financiallyReady: false,
            canConfirm: false,
            outstandingAmounts: [],
            counts: { INTER_MEMBER_OBLIGATION: 0, OPEN_EXTERNAL_LIABILITY: 1 },
        });
        await f.a
            .post(
                `/v2/spaces/${f.space}/financial-commitments/${origin.commitment.id}/external-liabilities/${origin.externalLiability.id}/settlements`,
                {
                    expectedCommitmentVersion: 1,
                    expectedSpaceVersion: plan.spaceVersion,
                    amountInCents: 1000,
                    factDate: day,
                },
            )
            .expect(201);
        expect(await validation(f)).toMatchObject({
            financiallyReady: true,
            canConfirm: true,
        });
    });

    it('resolves an existing one-time commitment through its normal financial fulfillment', async () => {
        const f = await closureFinance(app, 'solo'),
            origin = (
                await f.a
                    .post(`/v2/spaces/${f.space}/planned-expenses`, {
                        scope: 'SHARED',
                        expectedSpaceVersion: f.context.version,
                        description: 'Avulso ainda pendente',
                        amountInCents: 1000,
                        expectedPaymentDate: day,
                        expectedPayerMemberId: f.ma,
                        responsibilitySplit: {
                            mode: 'AMOUNTS',
                            shares: [{ memberId: f.ma, amountInCents: 1000 }],
                        },
                    })
                    .expect(201)
            ).body,
            plan = await approve(f, await begin(f));
        expect(await validation(f)).toMatchObject({
            financiallyReady: false,
            counts: { OPEN_ONE_TIME_COMMITMENT: 1 },
        });
        await f.a
            .post(
                `/v2/spaces/${f.space}/financial-commitments/${origin.commitment.id}/disbursements`,
                {
                    expectedCommitmentVersion: 1,
                    expectedSpaceVersion: plan.spaceVersion,
                    amountInCents: 1000,
                    factDate: day,
                    method: 'PIX',
                    payerMemberId: f.ma,
                    settlement: { mode: 'NONE' },
                },
            )
            .expect(201);
        expect(await validation(f)).toMatchObject({
            financiallyReady: true,
            canConfirm: true,
        });
    });

    it('accepts a financial adjustment proposed before closure using the current space version', async () => {
        const f = await closureFinance(app),
            root = (
                await f.a
                    .post(`/v2/spaces/${f.space}/planned-expenses`, {
                        scope: 'SHARED',
                        expectedSpaceVersion: f.context.version,
                        description: 'Compromisso com correção pendente',
                        amountInCents: 3000,
                        expectedPaymentDate: day,
                        expectedPayerMemberId: f.ma,
                        responsibilitySplit: {
                            mode: 'PERCENTAGES',
                            shares: [
                                { memberId: f.ma, basisPoints: 5000 },
                                { memberId: f.mb, basisPoints: 5000 },
                            ],
                        },
                    })
                    .expect(201)
            ).body.commitment,
            correction = (
                await f.a
                    .post(
                        `/v2/spaces/${f.space}/financial-commitments/${root.id}/adjustments`,
                        {
                            expectedCommitmentVersion: 1,
                            expectedSpaceVersion: f.context.version,
                            direction: 'INCREASE',
                            amountInCents: 1000,
                            factDate: day,
                            reason: 'Ajuste econômico ainda aguardando aceite',
                        },
                    )
                    .expect(201)
            ).body,
            plan = await approve(f, await begin(f));
        expect(await validation(f)).toMatchObject({
            financiallyReady: false,
            counts: { PENDING_FINANCIAL_CHANGE: 1 },
        });
        const accepted = (
            await f
                .b!.post(
                    `/v2/spaces/${f.space}/financial-commitments/${root.id}/change-proposals/${correction.proposal.id}/acceptance`,
                    {
                        expectedProposalVersion: 1,
                        expectedCommitmentVersion: 1,
                        expectedSpaceVersion: plan.spaceVersion,
                    },
                )
                .expect(201)
        ).body;
        expect(accepted.proposal.status).toBe('ACCEPTED');
        expect(await validation(f)).toMatchObject({
            financiallyReady: false,
            counts: {
                PENDING_FINANCIAL_CHANGE: 0,
                OPEN_ONE_TIME_COMMITMENT: 1,
            },
        });
    });

    it('cancels an unrealized historical recurrence occurrence in CLOSING without fabricating financial settlement', async () => {
        const f = await closureFinance(app, 'solo'),
            root = (
                await f.a
                    .post(`/v2/spaces/${f.space}/recurring-commitments`, {
                        scope: 'SHARED',
                        kind: 'EXPENSE',
                        description: 'Ocorrência antiga sem realização',
                        amountInCents: 3000,
                        recurrence: { frequency: 'MONTHLY', dayOfMonth: 20 },
                        startsOn: monthDate(-1),
                        endsOn: monthDate(-1, 20),
                        expectedSpaceVersion: f.context.version,
                        expectedMemberId: f.ma,
                        distribution: {
                            mode: 'PERCENTAGES',
                            shares: [{ memberId: f.ma, basisPoints: 10000 }],
                        },
                    })
                    .expect(201)
            ).body.commitment,
            plan = await approve(f, await begin(f));
        expect(await validation(f)).toMatchObject({
            financiallyReady: false,
            counts: { OPEN_RECURRING_OCCURRENCE: 1, ACTIVE_RECURRENCE: 0 },
        });
        await f.a
            .post(
                `/v2/spaces/${f.space}/recurring-commitments/${root.id}/occurrences/${monthDate(-1, 20)}/cancellation`,
                {
                    expectedCommitmentVersion: 1,
                    expectedOccurrenceVersion: 1,
                    expectedSpaceVersion: plan.spaceVersion,
                },
            )
            .expect(201);
        expect(await validation(f)).toMatchObject({
            financiallyReady: true,
            canConfirm: true,
        });
        expect(
            await db.query('SELECT id FROM financial_disbursements'),
        ).toEqual([]);
        expect(await db.query('SELECT id FROM settlement_transfers')).toEqual(
            [],
        );
    });

    it('uses a real approved manual closure agreement as the origin of its allocated settlement', async () => {
        const f = await closureFinance(app),
            future = new Date(`${day.slice(0, 7)}-01T12:00:00Z`);
        future.setUTCMonth(future.getUTCMonth() + 1);
        const root = await futureClosureRecurrence(
                f,
                future.toISOString().slice(0, 10),
            ),
            started = await begin(f),
            planned = (
                await f.a
                    .post(`${f.path}/future-destinations`, {
                        ...versions(started),
                        originType: 'RECURRING',
                        originId: root.id,
                        expectedOriginVersion: 1,
                        destination: 'SETTLE_BEFORE_CLOSURE',
                        assigneeMemberId: f.ma,
                        amountInCents: 2500,
                    })
                    .expect(200)
            ).body,
            plan = await approve(f, planned),
            [agreement] = await db.query(
                'SELECT id,closure_agreement_id FROM inter_member_obligations WHERE space_id=$1 AND closure_agreement_id IS NOT NULL',
                [f.space],
            );
        expect(await validation(f)).toMatchObject({
            financiallyReady: false,
            counts: { INTER_MEMBER_OBLIGATION: 1 },
        });
        const settled = await transfer(f, plan, agreement.id, 2500);
        expect(await validation(f)).toMatchObject({
            financiallyReady: true,
            canConfirm: true,
        });
        expect(
            await db.query(
                'SELECT obligation_id FROM settlement_allocations WHERE transfer_id=$1',
                [settled.transfer.id],
            ),
        ).toEqual([{ obligation_id: agreement.id }]);
        expect(
            await db.query(
                'SELECT id FROM financial_closure_effects WHERE id=$1',
                [agreement.closure_agreement_id],
            ),
        ).toHaveLength(1);
        expect(
            (
                await db.query(
                    'SELECT count(*)::int AS count FROM financial_disbursements',
                )
            )[0].count,
        ).toBe(0);
    });

    it('reopens an agreement in a correction cycle after reversing a finalized settlement while preserving its cause', async () => {
        const f = await closureFinance(app),
            root = await futureClosureRecurrence(f, monthDate(1)),
            originalCycle = randomUUID(),
            correctionCycle = randomUUID(),
            tomorrow = new Date(`${day}T12:00:00Z`);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        await db.query(
            "INSERT INTO settlement_cycles(id,space_id,target_date,status,version) VALUES($1,$3,$4,'OPEN',1),($2,$3,$5,'OPEN',1)",
            [
                originalCycle,
                correctionCycle,
                f.space,
                day,
                tomorrow.toISOString().slice(0, 10),
            ],
        );
        const started = await begin(f),
            planned = (
                await f.a
                    .post(`${f.path}/future-destinations`, {
                        ...versions(started),
                        originType: 'RECURRING',
                        originId: root.id,
                        expectedOriginVersion: 1,
                        destination: 'SETTLE_BEFORE_CLOSURE',
                        assigneeMemberId: f.ma,
                        amountInCents: 2500,
                    })
                    .expect(200)
            ).body,
            plan = await approve(f, planned),
            [agreement] = await db.query(
                'SELECT id,closure_agreement_id FROM inter_member_obligations WHERE space_id=$1 AND closure_agreement_id IS NOT NULL',
                [f.space],
            );
        await f.a
            .post(
                `/v2/spaces/${f.space}/inter-member-obligations/${agreement.id}/settlement-assignment`,
                {
                    expectedSpaceVersion: plan.spaceVersion,
                    expectedObligationVersion: 1,
                    expectedCycleVersions: [
                        { cycleId: originalCycle, version: 1 },
                    ],
                    settlement: { mode: 'CYCLE', cycleId: originalCycle },
                },
            )
            .expect(200);
        const settled = await transfer(f, plan, agreement.id, 2500),
            [sourceCycle] = await db.query(
                'SELECT version FROM settlement_cycles WHERE id=$1',
                [originalCycle],
            );
        await f.a
            .post(
                `/v2/spaces/${f.space}/settlement-cycles/${originalCycle}/finalize`,
                {
                    expectedSpaceVersion: plan.spaceVersion,
                    expectedCycleVersion: sourceCycle.version,
                },
            )
            .expect(200);
        const path = `/v2/spaces/${f.space}/settlement-transfers/${settled.transfer.id}`,
            options = (
                await f.a.agent.get(`${path}/reversal-options`).expect(200)
            ).body,
            cycleVersions = [...options.cycles];
        if (
            !cycleVersions.some(
                (row: { id: string }) => row.id === correctionCycle,
            )
        )
            cycleVersions.push(
                (
                    await db.query(
                        'SELECT id,version FROM settlement_cycles WHERE id=$1',
                        [correctionCycle],
                    )
                )[0],
            );
        await f.a
            .post(`${path}/reversals`, {
                expectedSpaceVersion: plan.spaceVersion,
                factDate: day,
                correctionCycleId: correctionCycle,
                expectedObligationVersions: options.obligations.map(
                    (row: { id: string; version: number }) => ({
                        obligationId: row.id,
                        version: row.version,
                    }),
                ),
                expectedCycleVersions: cycleVersions.map(
                    (row: { id: string; version: number }) => ({
                        cycleId: row.id,
                        version: row.version,
                    }),
                ),
                applications: options.allocations.map(
                    (row: { id: string; amountInCents: number }) => ({
                        allocationId: row.id,
                        amountInCents: row.amountInCents,
                    }),
                ),
            })
            .expect(201);
        const [corrective] = await db.query(
            'SELECT id,version,closure_agreement_id,cycle_id,remaining_amount_in_cents::text AS remaining FROM inter_member_obligations WHERE closure_agreement_id=$1 AND remaining_amount_in_cents>0',
            [agreement.closure_agreement_id],
        );
        expect(corrective).toMatchObject({
            closure_agreement_id: agreement.closure_agreement_id,
            cycle_id: correctionCycle,
            remaining: '2500',
        });
        expect(corrective.id).not.toBe(agreement.id);
        expect(
            (
                await db.query(
                    'SELECT remaining_amount_in_cents::text AS remaining FROM inter_member_obligations WHERE id=$1',
                    [agreement.id],
                )
            )[0].remaining,
        ).toBe('0');
        await f.a
            .post(
                `/v2/spaces/${f.space}/inter-member-obligations/${corrective.id}/waivers`,
                {
                    expectedSpaceVersion: plan.spaceVersion,
                    expectedObligationVersion: corrective.version,
                    amountInCents: 500,
                    factDate: day,
                },
            )
            .expect(201);
        await transfer(f, plan, corrective.id, 2000);
        const [targetCycle] = await db.query(
            'SELECT version FROM settlement_cycles WHERE id=$1',
            [correctionCycle],
        );
        await f.a
            .post(
                `/v2/spaces/${f.space}/settlement-cycles/${correctionCycle}/finalize`,
                {
                    expectedSpaceVersion: plan.spaceVersion,
                    expectedCycleVersion: targetCycle.version,
                },
            )
            .expect(200);
        const final = await validation(f);
        expect(final).toMatchObject({
            financiallyReady: true,
            canConfirm: true,
        });
        expect(
            final.resolutions.map((entry: { kind: string }) => entry.kind),
        ).toEqual(
            expect.arrayContaining([
                'TRANSFER',
                'REVERSAL',
                'WAIVER',
                'ASSIGNMENT',
                'CYCLE_FINALIZATION',
            ]),
        );
    });

    it('recomputes readiness and its fingerprint when a legitimate settlement reversal reopens an obligation', async () => {
        const f = await closureFinance(app),
            origin = await debt(f),
            plan = await approve(f, await begin(f)),
            settled = await transfer(f, plan, origin.obligation.id, 1000),
            original = await db.query(
                'SELECT * FROM settlement_transfers WHERE id=$1',
                [settled.transfer.id],
            ),
            ready = await validation(f),
            path = `/v2/spaces/${f.space}/settlement-transfers/${settled.transfer.id}`,
            options = (
                await f.a.agent.get(`${path}/reversal-options`).expect(200)
            ).body;
        await f.a
            .post(`${path}/reversals`, {
                expectedSpaceVersion: plan.spaceVersion,
                factDate: day,
                expectedObligationVersions: options.obligations.map(
                    (row: { id: string; version: number }) => ({
                        obligationId: row.id,
                        version: row.version,
                    }),
                ),
                expectedCycleVersions: options.cycles.map(
                    (row: { id: string; version: number }) => ({
                        cycleId: row.id,
                        version: row.version,
                    }),
                ),
                applications: options.allocations.map(
                    (row: { id: string; amountInCents: number }) => ({
                        allocationId: row.id,
                        amountInCents: row.amountInCents,
                    }),
                ),
            })
            .expect(201);
        const reopened = await validation(f);
        expect(ready).toMatchObject({
            financiallyReady: true,
            canConfirm: true,
        });
        expect(reopened).toMatchObject({
            financiallyReady: false,
            canConfirm: false,
            counts: { INTER_MEMBER_OBLIGATION: 1 },
        });
        expect(reopened.financialFingerprint).not.toBe(
            ready.financialFingerprint,
        );
        expect(
            await db.query('SELECT * FROM settlement_transfers WHERE id=$1', [
                settled.transfer.id,
            ]),
        ).toEqual(original);
    });

    it('keeps pending routine and shopping data informational while empty approved finance is ready', async () => {
        const f = await closureFinance(app, 'solo');
        await f.a
            .post(`/v2/spaces/${f.space}/tasks`, {
                description: 'Tarefa pendente',
            })
            .expect(201);
        await f.a
            .post(`/v2/spaces/${f.space}/shopping-lists`, {
                name: 'Lista ainda aberta',
            })
            .expect(201);
        await approve(f, await begin(f));
        const before = await snapshot(),
            response = await f.a.agent
                .get(`${f.path}/financial-validation`)
                .expect(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).toMatchObject({
            financiallyReady: true,
            canConfirm: true,
            informational: {
                routine: { pendingTaskCount: 1 },
                shopping: { activeListCount: 1 },
                blocksFinancialClosure: false,
            },
        });
        expect(await snapshot()).toEqual(before);
    });

    it('keeps a merely drafted future destination blocking until the plan authorizes its actual application', async () => {
        const f = await closureFinance(app, 'solo'),
            root = await futureClosureRecurrence(f, monthDate(1)),
            started = await begin(f),
            drafted = (
                await f.a
                    .post(`${f.path}/future-destinations`, {
                        ...versions(started),
                        originType: 'RECURRING',
                        originId: root.id,
                        expectedOriginVersion: 1,
                        destination: 'TERMINATE',
                    })
                    .expect(200)
            ).body;
        expect(await validation(f)).toMatchObject({
            planApproved: false,
            financiallyReady: false,
            canConfirm: false,
            missingDestinationOriginIds: [root.id],
        });
        await approve(f, drafted);
        expect(await validation(f)).toMatchObject({
            planApproved: true,
            financiallyReady: true,
            canConfirm: true,
            missingDestinationOriginIds: [],
        });
    });

    it('includes every blocker beyond the first one hundred rows without materializing financial data', async () => {
        const f = await closureFinance(app),
            ids: string[] = [];
        for (let index = 0; index < 101; index++)
            ids.push((await debt(f, 1)).obligation.id);
        await approve(f, await begin(f));
        const before = await snapshot(),
            result = await validation(f);
        expect(result).toMatchObject({
            financiallyReady: false,
            canConfirm: false,
            totalCount: 101,
            counts: { INTER_MEMBER_OBLIGATION: 101 },
        });
        expect(result.blockers).toHaveLength(101);
        expect(
            result.blockers
                .map((row: { originId: string }) => row.originId)
                .sort(),
        ).toEqual(ids.sort());
        expect(await snapshot()).toEqual(before);
    });

    it('does not expose an unavailable financial query as a successful ready state', async () => {
        const f = await closureFinance(app, 'solo');
        await begin(f);
        const before = await snapshot();
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        vi.spyOn(
            app.get<FinancialClosureDestinationsPort>(
                FINANCIAL_CLOSURE_DESTINATIONS_PORT,
            ),
            'reviewPlan',
        ).mockRejectedValue(
            Object.assign(new Error('Financial source unavailable'), {
                code: '08006',
            }),
        );
        const response = await f.a.agent
            .get(`${f.path}/financial-validation`)
            .expect(503);
        expect(response.body).not.toHaveProperty('financiallyReady', true);
        expect(response.body).not.toHaveProperty('canConfirm', true);
        expect(await snapshot()).toEqual(before);
    });

    it('returns a complete repeatable snapshot while another connection resolves an obligation', async () => {
        const f = await closureFinance(app),
            origin = await debt(f),
            plan = await approve(f, await begin(f)),
            before = await validation(f),
            original = EntityManager.prototype.query;
        let armed = true;
        vi.spyOn(EntityManager.prototype, 'query').mockImplementation(
            async function (this: EntityManager, sql, params) {
                const rows = await original.call(this, sql, params);
                if (
                    armed &&
                    sql.includes('obligations AS MATERIALIZED (') &&
                    sql.includes('FROM blockers) AS total_count')
                ) {
                    armed = false;
                    const [mode] = (await original.call(
                        this,
                        'SHOW transaction_read_only',
                        [],
                    )) as { transaction_read_only: string }[];
                    expect(mode.transaction_read_only).toBe('on');
                    await transfer(f, plan, origin.obligation.id, 1000);
                }
                return rows;
            },
        );
        const during = await validation(f);
        expect(armed).toBe(false);
        expect(during).toMatchObject({
            financiallyReady: false,
            counts: { INTER_MEMBER_OBLIGATION: 1 },
            financialFingerprint: before.financialFingerprint,
        });
        vi.restoreAllMocks();
        const after = await validation(f);
        expect(after).toMatchObject({
            financiallyReady: true,
            canConfirm: true,
        });
        expect(after.financialFingerprint).not.toBe(
            during.financialFingerprint,
        );
    });

    it('rolls back allocations, obligation state, closure tracing and receipts when transfer auditing fails', async () => {
        const f = await closureFinance(app),
            origin = await debt(f),
            plan = await approve(f, await begin(f)),
            before = await snapshot();
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        await db.query(
            'ALTER TABLE financial_settlement_audit ADD CONSTRAINT test_reject_closure_transfer CHECK (false) NOT VALID',
        );
        try {
            await f.a
                .post(
                    `/v2/spaces/${f.space}/settlement-transfers`,
                    await transferInput(f, plan, origin.obligation.id, 1000),
                )
                .expect(500);
            expect(await snapshot()).toEqual(before);
        } finally {
            await db.query(
                'ALTER TABLE financial_settlement_audit DROP CONSTRAINT test_reject_closure_transfer',
            );
        }
    });

    it('rejects excessive or unallocated transfers without clearing any blocker', async () => {
        const f = await closureFinance(app),
            origin = await debt(f),
            plan = await approve(f, await begin(f)),
            before = await snapshot();
        await f.a
            .post(
                `/v2/spaces/${f.space}/settlement-transfers`,
                await transferInput(f, plan, origin.obligation.id, 1001),
            )
            .expect(409);
        await f.a
            .post(`/v2/spaces/${f.space}/settlement-transfers`, {
                ...(await transferInput(f, plan, origin.obligation.id, 1000)),
                allocations: [],
            })
            .expect(400);
        expect(await snapshot()).toEqual(before);
        expect(await validation(f)).toMatchObject({
            financiallyReady: false,
            counts: { INTER_MEMBER_OBLIGATION: 1 },
        });
    });

    it('requires an authorized shared-space participant for financial validation', async () => {
        const f = await closureFinance(app),
            outsider = await financeBrowser(app);
        await begin(f);
        const before = await snapshot();
        await outsider.agent.get(`${f.path}/financial-validation`).expect(404);
        await f.a.agent
            .get(
                `/v2/spaces/${f.a.context.personalSpace.id}/closure/financial-validation`,
            )
            .expect(409);
        await request(app.getHttpServer())
            .get(`${f.path}/financial-validation`)
            .expect(401);
        expect(await snapshot()).toEqual(before);
    });

    it.each(['rule', 'closure'] as const)(
        'serializes default settlement rule configuration against closure when %s queues first',
        async (first) => {
            const f = await closureFinance(app),
                rule = () =>
                    f.a.put(`/v2/spaces/${f.space}/default-settlement-rule`, {
                        expectedVersion: 0,
                        rule: { kind: 'MONTHLY_DAY', dayOfMonth: 10 },
                    }),
                close = () =>
                    f.a.post(f.path, {
                        expectedSpaceVersion: f.context.version,
                    }),
                [winner, second] = await competingClosureCommands(
                    db,
                    f.space,
                    first === 'rule' ? rule : close,
                    first === 'rule' ? close : rule,
                );
            expect(winner.status).toBe(first === 'rule' ? 200 : 201);
            expect(second.status).toBe(first === 'rule' ? 201 : 409);
            expect(
                await db.query(
                    'SELECT kind,day_of_month FROM default_settlement_rules WHERE space_id=$1',
                    [f.space],
                ),
            ).toEqual(
                first === 'rule'
                    ? [{ kind: 'MONTHLY_DAY', day_of_month: 10 }]
                    : [],
            );
            expect(
                (await f.a.agent.get(`${f.path}/diagnostic`).expect(200)).body
                    .closure.spaceStatus,
            ).toBe('CLOSING');
        },
    );

    it('registers financial validation in executable OpenAPI', () => {
        expect(
            createApiOpenApiDocument(false).paths[
                '/v2/spaces/{spaceId}/closure/financial-validation'
            ]?.get,
        ).toBeDefined();
    });

    it('indexes only remaining closure agreement obligations', async () => {
        const [index] = await db.query(
            "SELECT indexdef FROM pg_indexes WHERE indexname='UQ_obligations_closure_agreement'",
        );
        expect(index.indexdef).toMatch(/WHERE.*remaining_amount_in_cents/i);
    });
});
