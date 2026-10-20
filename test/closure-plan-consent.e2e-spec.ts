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
import { financeBrowser, financeSnapshot } from './settlement-fixture.js';
import { prepareShoppingDatabase } from './shopping-fixture.js';
import { routineSnapshot } from './routine-fixture.js';
import { shoppingSnapshot } from './shopping-fixture.js';
import {
    closureFinance,
    closureApp,
    closureSnapshot,
    competingClosureCommands,
    futureClosureInstallments,
    futureClosureRecurrence,
} from './closure-fixture.js';
import { createApiOpenApiDocument } from '../dist/composition/http/create-api-openapi-document.js';

type Version = {
    spaceVersion: number;
    planRevision: number;
    proposalSnapshot?: { financialFingerprint: string } | null;
};

describe('closure proposal and consent HTTP/PostgreSQL', () => {
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
    const input = (view: Version) => ({
        expectedSpaceVersion: view.spaceVersion,
        expectedPlanRevision: view.planRevision,
    });
    function monthDate(months: number, targetDay = 1) {
        const value = new Date(`${day.slice(0, 7)}-01T12:00:00Z`);
        value.setUTCMonth(value.getUTCMonth() + months);
        const last = new Date(
            Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0),
        ).getUTCDate();
        value.setUTCDate(Math.min(targetDay, last));
        return value.toISOString().slice(0, 10);
    }
    function laterDay() {
        const value = new Date(`${day}T12:00:00Z`);
        value.setUTCDate(value.getUTCDate() + 3);
        return value.toISOString().slice(0, 10);
    }
    type Fixture = Awaited<ReturnType<typeof closureFinance>>;
    const approvalInput = (view: Version) => ({
        ...input(view),
        expectedFinancialFingerprint:
            view.proposalSnapshot!.financialFingerprint,
    });
    const proposalInput = async (f: Fixture, view: Version) => ({
        ...input(view),
        expectedFinancialFingerprint: (
            await f.a.agent.get(`${f.path}/plan-review`).expect(200)
        ).body.finance.fingerprint,
    });
    const begin = async (f: Fixture) =>
        (
            await f.a
                .post(f.path, { expectedSpaceVersion: f.context.version })
                .expect(201)
        ).body;
    async function select(
        f: Fixture,
        view: Version,
        rootId: string,
        originType: 'RECURRING' | 'INSTALLMENT' = 'RECURRING',
        successor = true,
    ) {
        return (
            await f.a
                .post(`${f.path}/future-destinations`, {
                    ...input(view),
                    originType,
                    originId: rootId,
                    expectedOriginVersion: 1,
                    destination: successor ? 'PERSONAL_SUCCESSOR' : 'TERMINATE',
                    ...(successor ? { assigneeMemberId: f.ma } : {}),
                })
                .expect(200)
        ).body;
    }
    const effects = (processId: string) =>
        db.query(
            'SELECT * FROM financial_closure_effects WHERE process_id=$1 ORDER BY origin_id',
            [processId],
        );

    it('approves an eligible individual proposal with one real consent and a distinct final confirmation still pending', async () => {
        const f = await closureFinance(app, 'solo'),
            started = await begin(f),
            proposed = (
                await f.a
                    .post(`${f.path}/proposal`, await proposalInput(f, started))
                    .expect(200)
            ).body;
        expect(proposed).toMatchObject({
            spaceStatus: 'CLOSING',
            processStatus: 'OPEN',
            planStatus: 'APPROVED',
            requiredMemberIds: [f.ma],
            confirmations: [],
            hasBilateralApproval: false,
        });
        expect(proposed.approvals).toMatchObject([
            { memberId: f.ma, planRevision: proposed.planRevision },
        ]);
        expect(proposed.approvals).toHaveLength(1);
        expect(proposed.proposalSnapshot).not.toBeNull();
        const before = await snapshot();
        for (const action of ['approval', 'rejection'])
            await f.a
                .post(
                    `${f.path}/${action}`,
                    action === 'approval'
                        ? approvalInput(proposed)
                        : input(proposed),
                )
                .expect(403);
        expect(await snapshot()).toEqual(before);
        expect(await effects(started.processId)).toEqual([]);
    });

    it.each(['requester', 'other'] as const)(
        'requires two distinct real consents when the %s proposes',
        async (proposer) => {
            const f = await closureFinance(app),
                started = await begin(f),
                actor = proposer === 'requester' ? f.a : f.b!,
                recipient = proposer === 'requester' ? f.b! : f.a,
                actorMemberId = proposer === 'requester' ? f.ma : f.mb,
                recipientId = proposer === 'requester' ? f.mb : f.ma,
                first = (
                    await actor
                        .post(
                            `${f.path}/proposal`,
                            await proposalInput(f, started),
                        )
                        .expect(200)
                ).body;
            expect(first).toMatchObject({
                planStatus: 'PROPOSED',
                requestedByMemberId: f.ma,
                actorNextAction: 'WAIT_APPROVAL',
            });
            expect(first.approvals).toMatchObject([
                { memberId: actorMemberId },
            ]);
            for (const action of ['approval', 'rejection'])
                await actor
                    .post(
                        `${f.path}/${action}`,
                        action === 'approval'
                            ? approvalInput(first)
                            : input(first),
                    )
                    .expect(403);
            const review = (
                await recipient.agent.get(`${f.path}/plan-review`).expect(200)
            ).body;
            expect(review.closure.actorNextAction).toBe('REVIEW_PLAN');
            const approved = (
                await recipient
                    .post(`${f.path}/approval`, approvalInput(first))
                    .expect(200)
            ).body;
            expect(approved).toMatchObject({
                spaceStatus: 'CLOSING',
                planStatus: 'APPROVED',
                hasBilateralApproval: true,
                confirmations: [],
            });
            expect(
                approved.approvals
                    .map((value: { memberId: string }) => value.memberId)
                    .sort(),
            ).toEqual([actorMemberId, recipientId].sort());
            expect(
                approved.approvals.every(
                    (value: { planRevision: number }) =>
                        value.planRevision === approved.planRevision,
                ),
            ).toBe(true);
        },
    );

    it('reviews financial and informational consequences without writes and identifies virtual and installment origins missing destinations', async () => {
        const f = await closureFinance(app),
            recurrence = await futureClosureRecurrence(f, monthDate(1), true),
            installments = await futureClosureInstallments(f, monthDate(1, 20));
        await f.a
            .post(`/v2/spaces/${f.space}/tasks`, {
                description: 'Organizar a mudança',
            })
            .expect(201);
        await f.a
            .post(`/v2/spaces/${f.space}/shopping-lists`, {
                name: 'Últimas compras',
            })
            .expect(201);
        const started = await begin(f),
            before = await snapshot(),
            response = await f.a.agent.get(`${f.path}/plan-review`).expect(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).toMatchObject({
            spaceId: f.space,
            closure: { processId: started.processId },
            finance: {
                fingerprint: expect.any(String),
                diagnostic: {
                    financiallyReady: false,
                    counts: { ACTIVE_RECURRENCE: 1, UNRESOLVED_INSTALLMENT: 2 },
                },
            },
            informational: {
                routine: { pendingTaskCount: 1, activeRecurrenceCount: 0 },
                shopping: { activeListCount: 1 },
            },
        });
        expect(
            response.body.finance.missingDestinationOriginIds.sort(),
        ).toEqual([recurrence.id, installments.id].sort());
        await f.a
            .post(`${f.path}/proposal`, await proposalInput(f, started))
            .expect(409);
        expect(await snapshot()).toEqual(before);
        expect(
            await db.query(
                'SELECT id FROM financial_occurrences WHERE commitment_id=$1',
                [recurrence.id],
            ),
        ).toEqual([]);
    });

    it.each(['solo', 'bilateral'] as const)(
        'applies approved destinations synchronously in a %s plan without completing the space',
        async (mode) => {
            const f = await closureFinance(app, mode),
                root = await futureClosureRecurrence(f, monthDate(1)),
                started = await begin(f),
                planned = await select(f, started, root.id),
                proposed = (
                    await f.a
                        .post(
                            `${f.path}/proposal`,
                            await proposalInput(f, planned),
                        )
                        .expect(200)
                ).body;
            if (mode === 'bilateral') {
                expect(await effects(started.processId)).toEqual([]);
                await f
                    .b!.post(`${f.path}/approval`, approvalInput(proposed))
                    .expect(200);
            }
            const applied = await effects(started.processId);
            expect(applied).toHaveLength(1);
            expect(applied[0]).toMatchObject({
                origin_id: root.id,
                successor_commitment_id: expect.any(String),
            });
            const state = (await f.a.agent.get(f.path).expect(200)).body;
            expect(state).toMatchObject({
                spaceStatus: 'CLOSING',
                planStatus: 'APPROVED',
                confirmations: [],
            });
            expect(
                (await f.a.agent.get(`${f.path}/plan-review`).expect(200)).body
                    .finance.missingDestinationOriginIds,
            ).toEqual([]);
        },
    );

    it('approves destinations while an existing inter-member debt remains open', async () => {
        const f = await closureFinance(app),
            root = await futureClosureRecurrence(f, monthDate(1));
        await f.a
            .post(`/v2/spaces/${f.space}/shared-cash-expenses`, {
                expectedSpaceVersion: f.context.version,
                description: 'Pagamento anterior à saída',
                amountInCents: 1000,
                factDate: day,
                expectedPayerMemberId: f.ma,
                responsibilitySplit: {
                    mode: 'AMOUNTS',
                    shares: [
                        { memberId: f.ma, amountInCents: 0 },
                        { memberId: f.mb, amountInCents: 1000 },
                    ],
                },
                disbursement: {
                    method: 'PIX',
                    payerMemberId: f.ma,
                    amountInCents: 1000,
                },
                settlement: { mode: 'NONE' },
            })
            .expect(201);
        const started = await begin(f),
            planned = await select(f, started, root.id),
            proposed = (
                await f.a
                    .post(`${f.path}/proposal`, await proposalInput(f, planned))
                    .expect(200)
            ).body;
        await f
            .b!.post(`${f.path}/approval`, approvalInput(proposed))
            .expect(200);
        expect(await effects(started.processId)).toHaveLength(1);
        const review = (
            await f.a.agent.get(`${f.path}/plan-review`).expect(200)
        ).body;
        expect(review).toMatchObject({
            closure: { planStatus: 'APPROVED', spaceStatus: 'CLOSING' },
            finance: {
                diagnostic: {
                    financiallyReady: false,
                    counts: { INTER_MEMBER_OBLIGATION: 1 },
                },
            },
        });
    });

    it('preserves rejection and resubmission history without applying a rejected plan', async () => {
        const f = await closureFinance(app),
            root = await futureClosureRecurrence(f, monthDate(1)),
            started = await begin(f),
            planned = await select(f, started, root.id),
            proposed = (
                await f.a
                    .post(`${f.path}/proposal`, await proposalInput(f, planned))
                    .expect(200)
            ).body,
            rejected = (
                await f
                    .b!.post(`${f.path}/rejection`, input(proposed))
                    .expect(200)
            ).body;
        expect(rejected).toMatchObject({
            planStatus: 'REJECTED',
            spaceStatus: 'CLOSING',
        });
        expect(await effects(started.processId)).toEqual([]);
        const resubmitted = (
            await f
                .b!.post(`${f.path}/proposal`, await proposalInput(f, rejected))
                .expect(200)
        ).body;
        expect(resubmitted.planRevision).toBe(rejected.planRevision + 1);
        expect(resubmitted.approvals).toMatchObject([{ memberId: f.mb }]);
        await f.a
            .post(`${f.path}/approval`, approvalInput(resubmitted))
            .expect(200);
        const actions = (
            await f.a.agent.get(`${f.path}/history`).expect(200)
        ).body.items.map((entry: { action: string }) => entry.action);
        expect(
            actions.filter(
                (action: string) => action === 'PROPOSE_CLOSURE_PLAN',
            ),
        ).toHaveLength(2);
        expect(actions).toContain('REJECT_CLOSURE_PLAN');
        expect(actions).toContain('APPROVE_CLOSURE_PLAN');
        expect(await effects(started.processId)).toHaveLength(1);
    });

    it('invalidates proposed consents when a destination materially changes and refuses decisions from the old revision', async () => {
        const f = await closureFinance(app),
            root = await futureClosureRecurrence(f, monthDate(1)),
            started = await begin(f),
            planned = await select(f, started, root.id),
            proposed = (
                await f.a
                    .post(`${f.path}/proposal`, await proposalInput(f, planned))
                    .expect(200)
            ).body,
            changed = await select(f, proposed, root.id, 'RECURRING', false);
        expect(changed).toMatchObject({
            planStatus: 'DRAFT',
            approvals: [],
            confirmations: [],
            proposalSnapshot: null,
        });
        expect(changed.planRevision).toBe(proposed.planRevision + 1);
        const before = await snapshot();
        await f
            .b!.post(`${f.path}/approval`, approvalInput(proposed))
            .expect(409);
        expect(await snapshot()).toEqual(before);
    });

    it('keeps the effective cutoff until both consent to a future date', async () => {
        const f = await closureFinance(app),
            started = await begin(f),
            future = laterDay(),
            changed = (
                await f.a
                    .post(`${f.path}/cutoff-date`, {
                        ...input(started),
                        cutoffDate: future,
                    })
                    .expect(200)
            ).body,
            proposed = (
                await f.a
                    .post(`${f.path}/proposal`, await proposalInput(f, changed))
                    .expect(200)
            ).body;
        expect(proposed).toMatchObject({
            cutoffDate: day,
            proposedCutoffDate: future,
            planStatus: 'PROPOSED',
        });
        expect((await f.b!.agent.get(f.path).expect(200)).body.cutoffDate).toBe(
            day,
        );
        const approved = (
            await f
                .b!.post(`${f.path}/approval`, approvalInput(proposed))
                .expect(200)
        ).body;
        expect(approved).toMatchObject({
            cutoffDate: future,
            proposedCutoffDate: null,
            planStatus: 'APPROVED',
            spaceStatus: 'CLOSING',
        });
    });

    it('retains bilateral approval history after a later material revision and requires fresh consent from both', async () => {
        const f = await closureFinance(app),
            started = await begin(f),
            proposed = (
                await f.a
                    .post(`${f.path}/proposal`, await proposalInput(f, started))
                    .expect(200)
            ).body,
            approved = (
                await f
                    .b!.post(`${f.path}/approval`, approvalInput(proposed))
                    .expect(200)
            ).body,
            changed = (
                await f.a
                    .post(`${f.path}/cutoff-date`, {
                        ...input(approved),
                        cutoffDate: laterDay(),
                    })
                    .expect(200)
            ).body;
        expect(changed).toMatchObject({
            planStatus: 'DRAFT',
            approvals: [],
            confirmations: [],
            hasBilateralApproval: true,
            proposalSnapshot: null,
        });
        const reproposed = (
            await f.a
                .post(`${f.path}/proposal`, await proposalInput(f, changed))
                .expect(200)
        ).body;
        expect(reproposed.approvals).toHaveLength(1);
        const reapproved = (
            await f
                .b!.post(`${f.path}/approval`, approvalInput(reproposed))
                .expect(200)
        ).body;
        expect(reapproved.approvals).toHaveLength(2);
        expect(reapproved.hasBilateralApproval).toBe(true);
        expect(await effects(started.processId)).toEqual([]);
    });

    it('replays historical proposal and approval responses without repeating finance or history', async () => {
        const f = await closureFinance(app),
            root = await futureClosureRecurrence(f, monthDate(1)),
            started = await begin(f),
            planned = await select(f, started, root.id),
            proposalRequest = await proposalInput(f, planned),
            proposalKey = randomUUID(),
            approvalKey = randomUUID(),
            proposed = (
                await f.a
                    .post(`${f.path}/proposal`, proposalRequest, proposalKey)
                    .expect(200)
            ).body,
            approved = (
                await f
                    .b!.post(
                        `${f.path}/approval`,
                        approvalInput(proposed),
                        approvalKey,
                    )
                    .expect(200)
            ).body,
            before = await snapshot();
        expect(
            (
                await f.a
                    .post(`${f.path}/proposal`, proposalRequest, proposalKey)
                    .expect(200)
            ).body,
        ).toEqual(proposed);
        expect(
            (
                await f
                    .b!.post(
                        `${f.path}/approval`,
                        approvalInput(proposed),
                        approvalKey,
                    )
                    .expect(200)
            ).body,
        ).toEqual(approved);
        await f.a
            .post(
                `${f.path}/proposal`,
                await proposalInput(f, approved),
                proposalKey,
            )
            .expect(409);
        await f
            .b!.post(`${f.path}/approval`, approvalInput(approved), approvalKey)
            .expect(409);
        expect(await snapshot()).toEqual(before);
        expect(await effects(started.processId)).toHaveLength(1);
    });

    it('rejects approval after a legitimate historical correction changes an origin in the proposed snapshot', async () => {
        const f = await closureFinance(app),
            root = await futureClosureRecurrence(f, monthDate(-1)),
            started = await begin(f),
            planned = await select(f, started, root.id),
            proposed = (
                await f.a
                    .post(`${f.path}/proposal`, await proposalInput(f, planned))
                    .expect(200)
            ).body;
        await f.a
            .post(
                `/v2/spaces/${f.space}/financial-commitments/${root.id}/adjustments`,
                {
                    expectedCommitmentVersion: 1,
                    expectedOccurrenceVersion: 1,
                    expectedSpaceVersion: proposed.spaceVersion,
                    referenceDate: monthDate(-1, 20),
                    direction: 'DECREASE',
                    amountInCents: 100,
                    reason: 'Correção histórica antes da aprovação',
                    factDate: day,
                },
            )
            .expect(201);
        const before = await snapshot();
        await f
            .b!.post(`${f.path}/approval`, approvalInput(proposed))
            .expect(409);
        expect(await snapshot()).toEqual(before);
        expect(await effects(started.processId)).toEqual([]);
        expect((await f.a.agent.get(f.path).expect(200)).body.planStatus).toBe(
            'PROPOSED',
        );
    });

    it.each(['approval', 'edit'] as const)(
        'serializes approval and material editing when %s queues first',
        async (first) => {
            const f = await closureFinance(app),
                started = await begin(f),
                proposed = (
                    await f.a
                        .post(
                            `${f.path}/proposal`,
                            await proposalInput(f, started),
                        )
                        .expect(200)
                ).body,
                approvalRequest = approvalInput(proposed),
                approve = () =>
                    f.b!.post(`${f.path}/approval`, approvalRequest),
                edit = () =>
                    f.a.post(`${f.path}/cutoff-date`, {
                        ...input(proposed),
                        cutoffDate: laterDay(),
                    }),
                [winner, loser] = await competingClosureCommands(
                    db,
                    f.space,
                    first === 'approval' ? approve : edit,
                    first === 'approval' ? edit : approve,
                );
            expect(winner.status).toBe(200);
            expect(loser.status).toBe(409);
            const view = (await f.a.agent.get(f.path).expect(200)).body;
            expect(view.planStatus).toBe(
                first === 'approval' ? 'APPROVED' : 'DRAFT',
            );
            expect(view.approvals).toHaveLength(first === 'approval' ? 2 : 0);
        },
    );

    it.each(['approval', 'rejection'] as const)(
        'serializes competing decisions when %s queues first',
        async (first) => {
            const f = await closureFinance(app),
                root = await futureClosureRecurrence(f, monthDate(1)),
                started = await begin(f),
                planned = await select(f, started, root.id),
                proposed = (
                    await f.a
                        .post(
                            `${f.path}/proposal`,
                            await proposalInput(f, planned),
                        )
                        .expect(200)
                ).body,
                approvalRequest = approvalInput(proposed),
                approve = () =>
                    f.b!.post(`${f.path}/approval`, approvalRequest),
                reject = () =>
                    f.b!.post(`${f.path}/rejection`, input(proposed)),
                [winner, loser] = await competingClosureCommands(
                    db,
                    f.space,
                    first === 'approval' ? approve : reject,
                    first === 'approval' ? reject : approve,
                );
            expect(winner.status).toBe(200);
            expect(loser.status).toBe(409);
            const view = (await f.a.agent.get(f.path).expect(200)).body;
            expect(view.planStatus).toBe(
                first === 'approval' ? 'APPROVED' : 'REJECTED',
            );
            expect(await effects(started.processId)).toHaveLength(
                first === 'approval' ? 1 : 0,
            );
        },
    );

    it.each([
        'financial_recurrence_versions',
        'financial_closure_effects',
        'space_closure_history',
        'space_closure_audit',
    ])(
        'rolls back the final consent and all financial effects when %s fails',
        async (table) => {
            const f = await closureFinance(app),
                root = await futureClosureRecurrence(f, monthDate(1)),
                started = await begin(f),
                planned = await select(f, started, root.id),
                proposed = (
                    await f.a
                        .post(
                            `${f.path}/proposal`,
                            await proposalInput(f, planned),
                        )
                        .expect(200)
                ).body,
                before = await snapshot();
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            await db.query(
                `ALTER TABLE ${table} ADD CONSTRAINT test_reject_plan_approval CHECK (false) NOT VALID`,
            );
            try {
                await f
                    .b!.post(`${f.path}/approval`, approvalInput(proposed))
                    .expect(500);
                expect(await snapshot()).toEqual(before);
            } finally {
                await db.query(
                    `ALTER TABLE ${table} DROP CONSTRAINT test_reject_plan_approval`,
                );
            }
            await f
                .b!.post(`${f.path}/approval`, approvalInput(proposed))
                .expect(200);
            expect(await effects(started.processId)).toHaveLength(1);
        },
    );

    it('isolates plan review and decisions from outsiders and personal spaces', async () => {
        const f = await closureFinance(app),
            outsider = await financeBrowser(app),
            started = await begin(f),
            request = await proposalInput(f, started),
            before = await snapshot();
        await outsider.agent.get(`${f.path}/plan-review`).expect(404);
        for (const action of ['proposal', 'approval', 'rejection']) {
            await outsider
                .post(
                    `${f.path}/${action}`,
                    action === 'rejection' ? input(started) : request,
                )
                .expect(404);
            await f.a
                .post(
                    `/v2/spaces/${f.a.context.personalSpace.id}/closure/${action}`,
                    action === 'rejection' ? input(started) : request,
                )
                .expect(409);
        }
        expect(await snapshot()).toEqual(before);
    });

    it('shows actor-specific proposal attention in Today without generating finance or routine writes', async () => {
        const f = await closureFinance(app),
            started = await begin(f);
        await f.a
            .post(`${f.path}/proposal`, await proposalInput(f, started))
            .expect(200);
        const before = await snapshot();
        for (const [actor, actorNextAction] of [
            [f.a, 'WAIT_APPROVAL'],
            [f.b!, 'REVIEW_PLAN'],
        ] as const) {
            const today = (
                await actor.agent.get(`/v2/spaces/${f.space}/today`).expect(200)
            ).body;
            expect(today.closure.data).toMatchObject({
                planStatus: 'PROPOSED',
                actorNextAction,
            });
            expect(
                today.blocks.find(
                    (block: { kind: string }) => block.kind === 'ATTENTION',
                ).items,
            ).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        type: 'SPACE_CLOSURE',
                        details: expect.objectContaining({ actorNextAction }),
                    }),
                ]),
            );
        }
        expect(await snapshot()).toEqual(before);
    });

    it('registers review, proposal, approval and rejection contracts in executable OpenAPI', () => {
        const paths = createApiOpenApiDocument(false).paths,
            base = '/v2/spaces/{spaceId}/closure';
        expect(paths[`${base}/plan-review`]?.get).toBeDefined();
        for (const action of ['proposal', 'approval', 'rejection'])
            expect(paths[`${base}/${action}`]?.post).toBeDefined();
    });

    it('invalidates proposal consent when debt is resolved even though no destination origin changed', async () => {
        const f = await closureFinance(app),
            paid = (
                await f.a
                    .post(`/v2/spaces/${f.space}/shared-cash-expenses`, {
                        expectedSpaceVersion: f.context.version,
                        description: 'Acerto pendente da casa',
                        amountInCents: 1000,
                        factDate: day,
                        expectedPayerMemberId: f.ma,
                        responsibilitySplit: {
                            mode: 'AMOUNTS',
                            shares: [
                                { memberId: f.ma, amountInCents: 0 },
                                { memberId: f.mb, amountInCents: 1000 },
                            ],
                        },
                        disbursement: {
                            method: 'PIX',
                            payerMemberId: f.ma,
                            amountInCents: 1000,
                        },
                        settlement: { mode: 'NONE' },
                    })
                    .expect(201)
            ).body,
            started = await begin(f),
            proposed = (
                await f.a
                    .post(`${f.path}/proposal`, await proposalInput(f, started))
                    .expect(200)
            ).body;
        await f.a
            .post(
                `/v2/spaces/${f.space}/inter-member-obligations/${paid.obligation.id}/waivers`,
                {
                    expectedSpaceVersion: proposed.spaceVersion,
                    expectedObligationVersion: 1,
                    amountInCents: 1000,
                    factDate: day,
                    reason: 'Dispensa explícita após revisão',
                },
            )
            .expect(201);
        const before = await snapshot(),
            response = await f
                .b!.post(`${f.path}/approval`, approvalInput(proposed))
                .expect(409);
        expect(response.body.code).toBe('CLOSURE_PLAN_OBSOLETE');
        expect(await snapshot()).toEqual(before);
        expect((await f.a.agent.get(f.path).expect(200)).body).toMatchObject({
            planStatus: 'PROPOSED',
            approvals: [{ memberId: f.ma }],
        });
    });

    it('rejects an old reviewed financial fingerprint before recording an individual proposal even when finance remains ready', async () => {
        const f = await closureFinance(app, 'solo'),
            expense = (
                await f.a
                    .post(`/v2/spaces/${f.space}/shared-cash-expenses`, {
                        expectedSpaceVersion: f.context.version,
                        description:
                            'Despesa histórica integralmente resolvida',
                        amountInCents: 1000,
                        factDate: day,
                        expectedPayerMemberId: f.ma,
                        responsibilitySplit: {
                            mode: 'AMOUNTS',
                            shares: [{ memberId: f.ma, amountInCents: 1000 }],
                        },
                        disbursement: {
                            method: 'PIX',
                            payerMemberId: f.ma,
                            amountInCents: 1000,
                        },
                        settlement: { mode: 'NONE' },
                    })
                    .expect(201)
            ).body,
            started = await begin(f),
            reviewed = (
                await f.a.agent.get(`${f.path}/plan-review`).expect(200)
            ).body,
            proposalRequest = {
                ...input(started),
                expectedFinancialFingerprint: reviewed.finance.fingerprint,
            };
        expect(reviewed.finance.diagnostic.financiallyReady).toBe(true);
        const path = `/v2/spaces/${f.space}/financial-commitments/${expense.commitment.id}`;
        await f.a
            .post(`${path}/adjustments`, {
                expectedCommitmentVersion: 1,
                expectedSpaceVersion: started.spaceVersion,
                direction: 'INCREASE',
                amountInCents: 100,
                reason: 'Correção histórica legítima',
                factDate: day,
            })
            .expect(201);
        await f.a
            .post(`${path}/disbursements`, {
                expectedCommitmentVersion: 2,
                expectedSpaceVersion: started.spaceVersion,
                amountInCents: 100,
                method: 'PIX',
                payerMemberId: f.ma,
                factDate: day,
                settlement: { mode: 'NONE' },
            })
            .expect(201);
        const current = (
            await f.a.agent.get(`${f.path}/plan-review`).expect(200)
        ).body;
        expect(current.finance.diagnostic.financiallyReady).toBe(true);
        expect(current.finance.fingerprint).not.toBe(
            reviewed.finance.fingerprint,
        );
        expect(current.closure.spaceVersion).toBe(started.spaceVersion);
        const before = await snapshot(),
            response = await f.a
                .post(`${f.path}/proposal`, proposalRequest)
                .expect(409);
        expect(response.body.code).toBe('CLOSURE_PLAN_OBSOLETE');
        expect(await snapshot()).toEqual(before);
        expect((await f.a.agent.get(f.path).expect(200)).body).toMatchObject({
            planStatus: 'DRAFT',
            approvals: [],
            proposalSnapshot: null,
        });
        expect(await effects(started.processId)).toEqual([]);
    });
});
