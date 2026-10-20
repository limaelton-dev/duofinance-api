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
    formingSharedSpace,
    futureClosureInstallments,
    futureClosureRecurrence,
} from './closure-fixture.js';
import { createApiOpenApiDocument } from '../dist/composition/http/create-api-openapi-document.js';

type Fixture = Awaited<ReturnType<typeof closureFinance>>;
type Version = {
    spaceVersion: number;
    planRevision: number;
    processId: string;
};

describe('final confirmation, cancellation and closed history HTTP/PostgreSQL', () => {
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
    function shiftedDay(amount: number) {
        const value = new Date(`${day}T12:00:00Z`);
        value.setUTCDate(value.getUTCDate() + amount);
        return value.toISOString().slice(0, 10);
    }
    function nextMonth() {
        const value = new Date(`${day.slice(0, 7)}-01T12:00:00Z`);
        value.setUTCMonth(value.getUTCMonth() + 1);
        return value.toISOString().slice(0, 10);
    }
    const begin = async (f: Fixture) =>
        (
            await f.a
                .post(f.path, { expectedSpaceVersion: f.context.version })
                .expect(201)
        ).body;
    async function approve(f: Fixture, view: Version) {
        const review = (
                await f.a.agent.get(`${f.path}/plan-review`).expect(200)
            ).body,
            proposed = (
                await f.a
                    .post(`${f.path}/proposal`, {
                        ...versions(view),
                        expectedFinancialFingerprint:
                            review.finance.fingerprint,
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
    const summary = async (f: Fixture, actor = f.a) =>
        (await actor.agent.get(`${f.path}/final-summary`).expect(200)).body;
    async function confirmationInput(f: Fixture, actor = f.a) {
        const current = await summary(f, actor);
        return {
            expectedSpaceVersion: current.spaceVersion,
            expectedPlanRevision: current.planRevision,
            expectedFinancialFingerprint: current.financialFingerprint,
        };
    }
    const confirm = async (f: Fixture, actor = f.a) =>
        (
            await actor
                .post(
                    `${f.path}/confirmation`,
                    await confirmationInput(f, actor),
                )
                .expect(200)
        ).body;
    async function close(f: Fixture) {
        const first = await confirm(f);
        return f.b ? await confirm(f, f.b) : first;
    }
    async function paidExpense(f: Fixture) {
        const ids = [f.ma, ...(f.mb ? [f.mb] : [])];
        return (
            await f.a
                .post(`/v2/spaces/${f.space}/shared-cash-expenses`, {
                    expectedSpaceVersion: f.context.version,
                    description: 'Despesa histórica resolvida',
                    amountInCents: 1000,
                    factDate: day,
                    expectedPayerMemberId: f.ma,
                    responsibilitySplit: {
                        mode: 'AMOUNTS',
                        shares: ids.map((memberId) => ({
                            memberId,
                            amountInCents: memberId === f.ma ? 1000 : 0,
                        })),
                    },
                    disbursement: {
                        method: 'PIX',
                        payerMemberId: f.ma,
                        amountInCents: 1000,
                    },
                    settlement: { mode: 'NONE' },
                })
                .expect(201)
        ).body;
    }
    async function planFuture(
        f: Fixture,
        view: Version,
        id: string,
        originType: 'RECURRING' | 'INSTALLMENT',
        successor = false,
    ) {
        return (
            await f.a
                .post(`${f.path}/future-destinations`, {
                    ...versions(view),
                    originType,
                    originId: id,
                    expectedOriginVersion: 1,
                    destination: successor ? 'PERSONAL_SUCCESSOR' : 'TERMINATE',
                    ...(successor ? { assigneeMemberId: f.ma } : {}),
                })
                .expect(200)
        ).body;
    }
    async function rich(f: Fixture) {
        const base = `/v2/spaces/${f.space}`,
            list = (
                await f.a
                    .post(`${base}/shopping-lists`, { name: 'Compras da casa' })
                    .expect(201)
            ).body,
            item = (
                await f.a
                    .post(`${base}/shopping-lists/${list.id}/items`, {
                        expectedVersion: 1,
                        description: 'Arroz',
                        desiredQuantity: '4',
                        unit: 'kg',
                    })
                    .expect(201)
            ).body.item,
            purchase = (
                await f.a
                    .post(
                        `${base}/shopping-lists/${list.id}/items/${item.id}/purchases`,
                        { expectedVersion: 2, quantity: '1.25' },
                    )
                    .expect(201)
            ).body.purchase;
        await f.a
            .post(
                `${base}/shopping-lists/${list.id}/items/${item.id}/purchases/${purchase.id}/corrections`,
                { expectedVersion: 3, quantity: '1.5' },
            )
            .expect(200);
        const pending = (
                await f.a
                    .post(`${base}/tasks`, {
                        description: 'Comprar o restante',
                        shoppingListId: list.id,
                    })
                    .expect(201)
            ).body,
            completedRoot = (
                await f.a
                    .post(`${base}/tasks`, {
                        description: 'Tarefa já executada',
                        shoppingListId: list.id,
                    })
                    .expect(201)
            ).body,
            completed = (
                await (f.b ?? f.a)
                    .post(`${base}/tasks/${completedRoot.id}/complete`, {
                        expectedVersion: 1,
                    })
                    .expect(200)
            ).body,
            recurrence = (
                await f.a
                    .post(`${base}/task-recurrences`, {
                        description: 'Rotina da casa',
                        rule: { frequency: 'DAILY' },
                        startsOn: shiftedDay(-1),
                    })
                    .expect(201)
            ).body,
            past = (
                await (f.b ?? f.a)
                    .post(
                        `${base}/task-recurrences/${recurrence.id}/occurrences/${shiftedDay(-1)}/complete`,
                        {
                            expectedRecurrenceVersion: 1,
                            expectedOccurrenceVersion: null,
                        },
                    )
                    .expect(200)
            ).body,
            current = (
                await f.a
                    .post(
                        `${base}/task-recurrences/${recurrence.id}/occurrences/${day}/complete`,
                        {
                            expectedRecurrenceVersion: 1,
                            expectedOccurrenceVersion: null,
                        },
                    )
                    .expect(200)
            ).body;
        await f.a
            .post(
                `${base}/task-recurrences/${recurrence.id}/occurrences/${day}/reopen`,
                {
                    expectedRecurrenceVersion: 1,
                    expectedOccurrenceVersion: current.version,
                },
            )
            .expect(200);
        const expense = await paidExpense(f),
            financialRecurrence = await futureClosureRecurrence(f, nextMonth()),
            installments = await futureClosureInstallments(f, nextMonth()),
            started = await begin(f),
            recurringPlan = await planFuture(
                f,
                started,
                financialRecurrence.id,
                'RECURRING',
            ),
            installmentPlan = await planFuture(
                f,
                recurringPlan,
                installments.id,
                'INSTALLMENT',
            ),
            plan = await approve(f, installmentPlan);
        return {
            base,
            list,
            item,
            purchase,
            pending,
            completed,
            recurrence,
            past,
            expense,
            financialRecurrence,
            installments,
            plan,
        };
    }

    it.each(['solo', 'bilateral'] as const)(
        'closes an empty %s space only after its distinct final confirmations',
        async (mode) => {
            const f = await closureFinance(app, mode),
                plan = await approve(f, await begin(f)),
                initial = await summary(f);
            expect(initial).toMatchObject({
                planApproved: true,
                financiallyReady: true,
                requiredConfirmations: mode === 'solo' ? 1 : 2,
                confirmedCount: 0,
                actorConfirmed: false,
                appliedDestinations: [],
                closure: { spaceStatus: 'CLOSING', confirmations: [] },
            });
            const firstInput = await confirmationInput(f),
                key = randomUUID(),
                first = (
                    await f.a
                        .post(`${f.path}/confirmation`, firstInput, key)
                        .expect(200)
                ).body;
            expect(first).toMatchObject({
                spaceStatus: mode === 'solo' ? 'CLOSED' : 'CLOSING',
                processStatus: mode === 'solo' ? 'COMPLETED' : 'OPEN',
            });
            const beforeReplay = await snapshot();
            expect(
                (
                    await f.a
                        .post(`${f.path}/confirmation`, firstInput, key)
                        .expect(200)
                ).body,
            ).toEqual(first);
            expect(await snapshot()).toEqual(beforeReplay);
            if (f.b) {
                const own = await summary(f);
                expect(own).toMatchObject({
                    confirmedCount: 1,
                    actorConfirmed: true,
                    canConfirm: false,
                });
                await f.a
                    .post(`${f.path}/confirmation`, await confirmationInput(f))
                    .expect(409);
                const last = await confirm(f, f.b);
                expect(last).toMatchObject({
                    spaceStatus: 'CLOSED',
                    processStatus: 'COMPLETED',
                    completedAt: expect.any(String),
                });
                expect(
                    last.confirmations
                        .map((entry: { memberId: string }) => entry.memberId)
                        .sort(),
                ).toEqual([f.ma, f.mb].sort());
            }
            expect((await summary(f)).confirmedCount).toBe(
                mode === 'solo' ? 1 : 2,
            );
            expect(
                (await f.a.agent.get(`${f.path}/diagnostic`).expect(200)).body
                    .closure.planRevision,
            ).toBe(plan.planRevision);
        },
    );

    it('requires an approved plan, ready finance and a current financial fingerprint', async () => {
        const f = await closureFinance(app, 'solo'),
            started = await begin(f);
        await f.a
            .post(`${f.path}/confirmation`, await confirmationInput(f))
            .expect(409);
        await approve(f, started);
        const body = await confirmationInput(f),
            before = await snapshot();
        await f.a
            .post(`${f.path}/confirmation`, {
                ...body,
                expectedFinancialFingerprint: '0'.repeat(64),
            })
            .expect(409);
        await f.a
            .post(`${f.path}/confirmation`, {
                ...body,
                expectedSpaceVersion: body.expectedSpaceVersion + 1,
            })
            .expect(409);
        expect(await snapshot()).toEqual(before);
    });

    it('finishes routine and shopping atomically while preserving completed work, partial purchases, corrections and links', async () => {
        const f = await closureFinance(app),
            r = await rich(f),
            facts = await Promise.all(
                [
                    'shopping_purchase_records',
                    'shopping_purchase_corrections',
                ].map((table) =>
                    db.query(`SELECT * FROM ${table} ORDER BY id`),
                ),
            ),
            completedBefore = (
                await f.a.agent
                    .get(`${r.base}/tasks/${r.completed.id}`)
                    .expect(200)
            ).body,
            pastBefore = (
                await f.a.agent
                    .get(
                        `${r.base}/task-recurrences/${r.recurrence.id}/occurrences/${shiftedDay(-1)}`,
                    )
                    .expect(200)
            ).body;
        await close(f);
        expect(
            await Promise.all(
                [
                    'shopping_purchase_records',
                    'shopping_purchase_corrections',
                ].map((table) =>
                    db.query(`SELECT * FROM ${table} ORDER BY id`),
                ),
            ),
        ).toEqual(facts);
        expect(
            (await f.a.agent.get(`${r.base}/tasks/${r.pending.id}`).expect(200))
                .body,
        ).toMatchObject({
            status: 'CANCELLED',
            completion: null,
            shoppingListId: r.list.id,
            allowedActions: [],
        });
        expect(
            (
                await f.a.agent
                    .get(`${r.base}/tasks/${r.completed.id}`)
                    .expect(200)
            ).body,
        ).toMatchObject({
            status: 'COMPLETED',
            completion: completedBefore.completion,
            shoppingListId: r.list.id,
            allowedActions: [],
        });
        expect(
            (
                await f.a.agent
                    .get(`${r.base}/task-recurrences/${r.recurrence.id}`)
                    .expect(200)
            ).body.status,
        ).toBe('CANCELLED');
        expect(
            (
                await f.a.agent
                    .get(
                        `${r.base}/task-recurrences/${r.recurrence.id}/occurrences/${day}`,
                    )
                    .expect(200)
            ).body,
        ).toMatchObject({ status: 'CANCELLED', completion: null });
        expect(
            (
                await f.a.agent
                    .get(
                        `${r.base}/task-recurrences/${r.recurrence.id}/occurrences/${shiftedDay(-1)}`,
                    )
                    .expect(200)
            ).body,
        ).toMatchObject({
            status: 'COMPLETED',
            completion: pastBefore.completion,
        });
        expect(
            (
                await f.a.agent
                    .get(`${r.base}/shopping-lists/${r.list.id}`)
                    .expect(200)
            ).body,
        ).toMatchObject({ status: 'ARCHIVED', allowedActions: [] });
        expect(
            (
                await f.a.agent
                    .get(
                        `${r.base}/shopping-lists/${r.list.id}/items/${r.item.id}`,
                    )
                    .expect(200)
            ).body.item,
        ).toMatchObject({
            status: 'PARTIALLY_PURCHASED',
            purchasedQuantity: '1.5',
            remainingQuantity: '2.5',
            unit: 'kg',
            allowedActions: [],
        });
        const history = (
            await f.a.agent
                .get(`${r.base}/shopping-lists/${r.list.id}/history`)
                .expect(200)
        ).body.items;
        expect(
            history.find(
                (entry: { type: string }) => entry.type === 'ARCHIVED',
            ),
        ).toMatchObject({
            type: 'ARCHIVED',
            data: {
                closure: {
                    processId: r.plan.processId,
                    planRevision: r.plan.planRevision,
                },
            },
        });
        for (const actor of [f.a, f.b!]) {
            expect(
                (
                    await actor.agent
                        .get(
                            `/v2/spaces/${actor.context.personalSpace.id}/tasks`,
                        )
                        .expect(200)
                ).body.items,
            ).toEqual([]);
            expect(
                (
                    await actor.agent
                        .get(
                            `/v2/spaces/${actor.context.personalSpace.id}/shopping-lists`,
                        )
                        .expect(200)
                ).body.items,
            ).toEqual([]);
        }
    });

    it('invalidates previous confirmations when allowed financial correction changes a ready state before the last consent', async () => {
        const f = await closureFinance(app),
            expense = await paidExpense(f),
            plan = await approve(f, await begin(f)),
            old = await confirmationInput(f),
            first = await confirm(f),
            path = `/v2/spaces/${f.space}/financial-commitments/${expense.commitment.id}`;
        await f.a
            .post(`${path}/adjustments`, {
                expectedCommitmentVersion: 1,
                expectedSpaceVersion: first.spaceVersion,
                direction: 'INCREASE',
                amountInCents: 100,
                reason: 'Correção histórica após primeira confirmação',
                factDate: day,
            })
            .expect(201);
        await f.a
            .post(`${path}/disbursements`, {
                expectedCommitmentVersion: 2,
                expectedSpaceVersion: first.spaceVersion,
                amountInCents: 100,
                factDate: day,
                method: 'PIX',
                payerMemberId: f.ma,
                settlement: { mode: 'NONE' },
            })
            .expect(201);
        const changed = await summary(f, f.b!);
        expect(changed).toMatchObject({
            financiallyReady: true,
            confirmedCount: 0,
            actorConfirmed: false,
        });
        expect(changed.financialFingerprint).not.toBe(
            old.expectedFinancialFingerprint,
        );
        const before = await snapshot();
        await f
            .b!.post(`${f.path}/confirmation`, {
                ...versions(first),
                expectedFinancialFingerprint: old.expectedFinancialFingerprint,
            })
            .expect(409);
        expect(await snapshot()).toEqual(before);
        const other = await confirm(f, f.b!);
        expect(other.spaceStatus).toBe('CLOSING');
        expect((await summary(f)).confirmedCount).toBe(1);
        expect((await confirm(f)).spaceStatus).toBe('CLOSED');
        expect(plan.planRevision).toBe(other.planRevision);
    });

    it('allows only the requester to cancel before the other participant has consented', async () => {
        const f = await closureFinance(app),
            started = await begin(f),
            before = await snapshot();
        await f
            .b!.post(`${f.path}/cancellation`, versions(started))
            .expect(403);
        expect(await snapshot()).toEqual(before);
        expect(
            (
                await f.a
                    .post(`${f.path}/cancellation`, versions(started))
                    .expect(200)
            ).body,
        ).toMatchObject({
            spaceStatus: 'ACTIVE',
            processStatus: 'CANCELLED',
            cancelledAt: expect.any(String),
            confirmations: [],
        });
    });

    it.each([false, true])(
        'counts the other participant proposal as real consent unless materially invalidated first=%s',
        async (invalidate) => {
            const f = await closureFinance(app),
                started = await begin(f),
                review = (
                    await f.b!.agent.get(`${f.path}/plan-review`).expect(200)
                ).body,
                proposed = (
                    await f
                        .b!.post(`${f.path}/proposal`, {
                            ...versions(started),
                            expectedFinancialFingerprint:
                                review.finance.fingerprint,
                        })
                        .expect(200)
                ).body;
            const current = invalidate
                    ? (
                          await f.a
                              .post(`${f.path}/cutoff-date`, {
                                  ...versions(proposed),
                                  cutoffDate: shiftedDay(3),
                              })
                              .expect(200)
                      ).body
                    : proposed,
                canceled = (
                    await f.a
                        .post(`${f.path}/cancellation`, versions(current))
                        .expect(200)
                ).body;
            expect(canceled.spaceStatus).toBe(
                invalidate ? 'ACTIVE' : 'CLOSING',
            );
            if (!invalidate)
                expect(
                    (
                        await f
                            .b!.post(
                                `${f.path}/cancellation`,
                                versions(canceled),
                            )
                            .expect(200)
                    ).body.spaceStatus,
                ).toBe('ACTIVE');
        },
    );

    it('requires both cancellation consents after bilateral approval and blocks confirmation while cancellation is pending', async () => {
        const f = await closureFinance(app),
            plan = await approve(f, await begin(f)),
            confirmed = await confirm(f),
            key = randomUUID(),
            firstInput = versions(confirmed),
            pending = (
                await f
                    .b!.post(`${f.path}/cancellation`, firstInput, key)
                    .expect(200)
            ).body;
        expect(pending).toMatchObject({
            spaceStatus: 'CLOSING',
            confirmations: [],
        });
        expect((await summary(f)).confirmedCount).toBe(0);
        await f.a
            .post(`${f.path}/confirmation`, await confirmationInput(f))
            .expect(409);
        await f
            .b!.post(`${f.path}/cancellation`, versions(pending))
            .expect(409);
        const before = await snapshot();
        expect(
            (
                await f
                    .b!.post(`${f.path}/cancellation`, firstInput, key)
                    .expect(200)
            ).body,
        ).toEqual(pending);
        expect(await snapshot()).toEqual(before);
        expect(
            (
                await f.a
                    .post(`${f.path}/cancellation`, versions(pending))
                    .expect(200)
            ).body,
        ).toMatchObject({ spaceStatus: 'ACTIVE', processStatus: 'CANCELLED' });
        expect(plan.hasBilateralApproval).toBe(true);
    });

    it('preserves the requirement of bilateral cancellation after an approved plan is materially revised', async () => {
        const f = await closureFinance(app),
            plan = await approve(f, await begin(f)),
            changed = (
                await f.a
                    .post(`${f.path}/cutoff-date`, {
                        ...versions(plan),
                        cutoffDate: shiftedDay(3),
                    })
                    .expect(200)
            ).body,
            pending = (
                await f.a
                    .post(`${f.path}/cancellation`, versions(changed))
                    .expect(200)
            ).body;
        expect(pending).toMatchObject({
            spaceStatus: 'CLOSING',
            hasBilateralApproval: true,
        });
        expect(
            (
                await f
                    .b!.post(`${f.path}/cancellation`, versions(pending))
                    .expect(200)
            ).body.spaceStatus,
        ).toBe('ACTIVE');
    });

    it('clears pending cancellation consents when the plan is materially changed', async () => {
        const f = await closureFinance(app),
            plan = await approve(f, await begin(f)),
            pending = (
                await f.a
                    .post(`${f.path}/cancellation`, versions(plan))
                    .expect(200)
            ).body,
            changed = (
                await f.a
                    .post(`${f.path}/cutoff-date`, {
                        ...versions(pending),
                        cutoffDate: shiftedDay(3),
                    })
                    .expect(200)
            ).body;
        expect(changed).toMatchObject({
            planStatus: 'DRAFT',
            cancellationConsents: [],
            confirmations: [],
            hasBilateralApproval: true,
        });
    });

    it.each(['solo', 'bilateral'] as const)(
        'cancels an approved %s plan without undoing its real successor or reactivating the shared origin',
        async (mode) => {
            const f = await closureFinance(app, mode),
                root = await futureClosureRecurrence(f, nextMonth()),
                started = await begin(f),
                planned = await planFuture(
                    f,
                    started,
                    root.id,
                    'RECURRING',
                    true,
                ),
                plan = await approve(f, planned),
                financeBefore = await financeSnapshot(db),
                requested = (
                    await f.a
                        .post(`${f.path}/cancellation`, versions(plan))
                        .expect(200)
                ).body,
                canceled = f.b
                    ? (
                          await f.b
                              .post(
                                  `${f.path}/cancellation`,
                                  versions(requested),
                              )
                              .expect(200)
                      ).body
                    : requested;
            expect(canceled).toMatchObject({
                spaceStatus: 'ACTIVE',
                processStatus: 'CANCELLED',
            });
            expect(await financeSnapshot(db)).toEqual(financeBefore);
            const [effect] = await db.query(
                'SELECT successor_commitment_id FROM financial_closure_effects WHERE origin_id=$1',
                [root.id],
            );
            await f.a.agent
                .get(
                    `/v2/spaces/${f.a.context.personalSpace.id}/recurring-commitments/${effect.successor_commitment_id}`,
                )
                .expect(200);
            const next = (
                await f.a
                    .post(f.path, {
                        expectedSpaceVersion: canceled.spaceVersion,
                    })
                    .expect(201)
            ).body;
            expect(next.processId).not.toBe(plan.processId);
            expect(next).toMatchObject({
                planStatus: 'DRAFT',
                approvals: [],
                confirmations: [],
            });
        },
    );

    it('keeps the old invitation invalid after cancellation and requires a fresh invitation before a new bilateral process', async () => {
        const formed = await formingSharedSpace(app),
            f = { ...formed, ma: formed.memberId, mb: null, b: null },
            invitee = await financeBrowser(app),
            started = await begin(f),
            canceled = (
                await f.a
                    .post(`${f.path}/cancellation`, versions(started))
                    .expect(200)
            ).body;
        await invitee
            .post('/v2/invitations/preview', { token: formed.token })
            .expect(404);
        await invitee
            .post('/v2/invitations/respond', {
                token: formed.token,
                decision: 'ACCEPT',
                expectedVersion: canceled.spaceVersion,
            })
            .expect(404);
        const issued = (
                await f.a
                    .post(`/v2/spaces/${f.space}/invitations`, {
                        expectedVersion: canceled.spaceVersion,
                    })
                    .expect(201)
            ).body,
            token = new URLSearchParams(
                new URL(issued.inviteUrl).hash.slice(1),
            ).get('token');
        expect(token).not.toBe(formed.token);
        expect(issued.invitation.id).not.toBe(formed.created.invitation.id);
        await invitee
            .post('/v2/invitations/respond', {
                token,
                decision: 'ACCEPT',
                expectedVersion: issued.space.version,
            })
            .expect(200);
        const context = (
                await f.a.agent
                    .get(`/v2/spaces/${f.space}/financial-entry-context`)
                    .expect(200)
            ).body,
            next = (
                await f.a
                    .post(f.path, { expectedSpaceVersion: context.version })
                    .expect(201)
            ).body;
        expect(next.processId).not.toBe(started.processId);
        expect(next.requiredMemberIds).toHaveLength(2);
        expect(next.approvals).toEqual([]);
    });

    it.each(['confirmation', 'cancellation'] as const)(
        'serializes final confirmation and cancellation when %s queues first',
        async (first) => {
            const f = await closureFinance(app),
                plan = await approve(f, await begin(f)),
                firstConfirmation = await confirm(f),
                confirmation = await confirmationInput(f, f.b!),
                finish = () =>
                    f.b!.post(`${f.path}/confirmation`, confirmation),
                cancel = () =>
                    f.a.post(
                        `${f.path}/cancellation`,
                        versions(firstConfirmation),
                    ),
                [winner, loser] = await competingClosureCommands(
                    db,
                    f.space,
                    first === 'confirmation' ? finish : cancel,
                    first === 'confirmation' ? cancel : finish,
                );
            expect(winner.status).toBe(200);
            expect(loser.status).toBe(409);
            expect(
                (await f.a.agent.get(`${f.path}/diagnostic`).expect(200)).body
                    .closure.spaceStatus,
            ).toBe(first === 'confirmation' ? 'CLOSED' : 'CLOSING');
            expect(plan.planStatus).toBe('APPROVED');
        },
    );

    it.each(['confirmation', 'adjustment'] as const)(
        'serializes final confirmation and permitted financial correction when %s queues first',
        async (first) => {
            const f = await closureFinance(app),
                expense = await paidExpense(f);
            await approve(f, await begin(f));
            const firstConfirmation = await confirm(f),
                confirmation = await confirmationInput(f, f.b!),
                finish = () =>
                    f.b!.post(`${f.path}/confirmation`, confirmation),
                adjust = () =>
                    f.a.post(
                        `/v2/spaces/${f.space}/financial-commitments/${expense.commitment.id}/adjustments`,
                        {
                            expectedCommitmentVersion: 1,
                            expectedSpaceVersion:
                                firstConfirmation.spaceVersion,
                            direction: 'INCREASE',
                            amountInCents: 100,
                            reason: 'Correção simultânea legítima',
                            factDate: day,
                        },
                    ),
                [winner, loser] = await competingClosureCommands(
                    db,
                    f.space,
                    first === 'confirmation' ? finish : adjust,
                    first === 'confirmation' ? adjust : finish,
                );
            expect(winner.status).toBe(first === 'confirmation' ? 200 : 201);
            expect(loser.status).toBe(409);
            const state = await summary(f);
            expect(state.closure.spaceStatus).toBe(
                first === 'confirmation' ? 'CLOSED' : 'CLOSING',
            );
            if (first === 'adjustment')
                expect(state).toMatchObject({
                    financiallyReady: false,
                    confirmedCount: 0,
                });
        },
    );

    it.each([
        'routine_history',
        'routine_command_audit',
        'shopping_history',
        'shopping_command_audit',
        'space_closure_history',
        'space_closure_audit',
    ])(
        'rolls back the last confirmation and every module if %s rejects closure persistence',
        async (table) => {
            const f = await closureFinance(app);
            await rich(f);
            await confirm(f);
            const body = await confirmationInput(f, f.b!),
                before = await snapshot();
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            await db.query(
                `ALTER TABLE ${table} ADD CONSTRAINT test_reject_final_closure CHECK (false) NOT VALID`,
            );
            try {
                await f.b!.post(`${f.path}/confirmation`, body).expect(500);
                expect(await snapshot()).toEqual(before);
            } finally {
                await db.query(
                    `ALTER TABLE ${table} DROP CONSTRAINT test_reject_final_closure`,
                );
            }
        },
    );

    it('preserves the first confirmation and all modules when the last financial read fails', async () => {
        const f = await closureFinance(app);
        await approve(f, await begin(f));
        await confirm(f);
        const body = await confirmationInput(f, f.b!),
            before = await snapshot();
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        await db.query(
            'ALTER TABLE financial_closure_effects RENAME TO test_unavailable_closure_effects',
        );
        try {
            await f.b!.post(`${f.path}/confirmation`, body).expect(500);
        } finally {
            await db.query(
                'ALTER TABLE test_unavailable_closure_effects RENAME TO financial_closure_effects',
            );
        }
        expect(await snapshot()).toEqual(before);
    });

    it('preserves authorized closed history for both participants and rejects outsiders', async () => {
        const f = await closureFinance(app),
            r = await rich(f),
            outsider = await financeBrowser(app);
        await close(f);
        const before = await snapshot();
        for (const actor of [f.a, f.b!]) {
            for (const path of [
                `${f.path}/diagnostic`,
                `${f.path}/history`,
                `${f.path}/final-summary`,
                `${r.base}/financial-commitments/${r.expense.commitment.id}`,
                `${r.base}/recurring-commitments/${r.financialRecurrence.id}`,
                `${r.base}/installment-commitments/${r.installments.id}`,
                `${r.base}/tasks/${r.completed.id}`,
                `${r.base}/task-recurrences/${r.recurrence.id}`,
                `${r.base}/shopping-lists/${r.list.id}`,
                `${r.base}/today`,
            ])
                await actor.agent.get(path).expect(200);
            expect(
                (await actor.agent.get('/v2/spaces').expect(200)).body.items,
            ).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ id: f.space, status: 'CLOSED' }),
                ]),
            );
        }
        for (const suffix of ['/diagnostic', '/history', '/final-summary'])
            await outsider.agent.get(f.path + suffix).expect(404);
        await outsider
            .post(`${f.path}/confirmation`, {
                expectedSpaceVersion: 1,
                expectedPlanRevision: 1,
                expectedFinancialFingerprint: '0'.repeat(64),
            })
            .expect(404);
        const today = (await f.a.agent.get(`${r.base}/today`).expect(200)).body;
        expect(today).toMatchObject({
            spaceStatus: 'CLOSED',
            closure: { data: { actorNextAction: 'READ_ONLY' } },
        });
        expect(await snapshot()).toEqual(before);
    });

    it('keeps an unjoined invitation recipient outside the individually closed space', async () => {
        const formed = await formingSharedSpace(app),
            f = { ...formed, ma: formed.memberId, mb: null, b: null },
            invited = await financeBrowser(app);
        await approve(f, await begin(f));
        await close(f);
        const before = await snapshot();
        for (const suffix of ['/diagnostic', '/history', '/final-summary'])
            await invited.agent.get(f.path + suffix).expect(404);
        await invited
            .post(`${f.path}/confirmation`, await confirmationInput(f))
            .expect(404);
        await invited
            .post('/v2/invitations/preview', { token: formed.token })
            .expect(404);
        expect(
            (await invited.agent.get('/v2/spaces').expect(200)).body.items.some(
                (space: { id: string }) => space.id === f.space,
            ),
        ).toBe(false);
        expect(await snapshot()).toEqual(before);
    });

    it('requires the real manual agreement to be settled and keeps its personal successor usable after closure', async () => {
        const f = await closureFinance(app),
            root = await futureClosureRecurrence(f, nextMonth()),
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
            [obligation] = await db.query(
                'SELECT id,version,debtor_member_id,creditor_member_id FROM inter_member_obligations WHERE space_id=$1 AND closure_agreement_id IS NOT NULL',
                [f.space],
            );
        expect(await summary(f)).toMatchObject({
            planApproved: true,
            financiallyReady: false,
            canConfirm: false,
            confirmedCount: 0,
            appliedDestinations: [
                {
                    effectId: expect.any(String),
                    originId: root.id,
                    successorCommitmentId: expect.any(String),
                    agreementObligationId: obligation.id,
                },
            ],
        });
        const before = await snapshot();
        await f.a
            .post(`${f.path}/confirmation`, await confirmationInput(f))
            .expect(409);
        expect(await snapshot()).toEqual(before);
        const transfer = (
            await f
                .b!.post(`/v2/spaces/${f.space}/settlement-transfers`, {
                    expectedSpaceVersion: plan.spaceVersion,
                    payerMemberId: obligation.debtor_member_id,
                    recipientMemberId: obligation.creditor_member_id,
                    amountInCents: 2500,
                    factDate: day,
                    allocations: [
                        {
                            obligationId: obligation.id,
                            expectedObligationVersion: obligation.version,
                            amountInCents: 2500,
                        },
                    ],
                })
                .expect(201)
        ).body;
        expect((await summary(f)).resolutions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'TRANSFER',
                    id: transfer.transfer.id,
                    planRevision: plan.planRevision,
                    obligationIds: [obligation.id],
                }),
            ]),
        );
        await close(f);
        const [effect] = (await summary(f)).appliedDestinations,
            personal = `/v2/spaces/${f.a.context.personalSpace.id}`,
            reference = `${nextMonth().slice(0, 7)}-20`;
        const successor = (
            await f.a.agent
                .get(
                    `${personal}/recurring-commitments/${effect.successorCommitmentId}`,
                )
                .expect(200)
        ).body;
        await f.a
            .post(
                `${personal}/recurring-commitments/${effect.successorCommitmentId}/occurrences/${reference}/disbursements`,
                {
                    expectedCommitmentVersion: successor.commitment.version,
                    expectedOccurrenceVersion: 1,
                    amountInCents: 3000,
                    factDate: day,
                    method: 'PIX',
                },
            )
            .expect(201);
        await f.a
            .post(`${personal}/tasks`, { description: 'Continuidade pessoal' })
            .expect(201);
        await f.a
            .post(`${personal}/shopping-lists`, { name: 'Compras pessoais' })
            .expect(201);
        expect(
            (await f.a.agent.get(`${f.path}/diagnostic`).expect(200)).body
                .closure.spaceStatus,
        ).toBe('CLOSED');
        expect(
            (
                await db.query(
                    'SELECT remaining_amount_in_cents::text AS remaining FROM inter_member_obligations WHERE id=$1',
                    [obligation.id],
                )
            )[0].remaining,
        ).toBe('0');
    });

    it('rejects new commands from every shared write family after CLOSED without changing any facts', async () => {
        const f = await closureFinance(app),
            r = await rich(f),
            closed = await close(f),
            base = r.base,
            shared = { expectedSpaceVersion: closed.spaceVersion },
            distribution = {
                mode: 'PERCENTAGES',
                shares: [f.ma, f.mb!].map((memberId) => ({
                    memberId,
                    basisPoints: 5000,
                })),
            },
            recurring = {
                scope: 'SHARED',
                kind: 'EXPENSE',
                valueMode: 'FIXED',
                description: 'Novo compromisso proibido',
                amountInCents: 3000,
                recurrence: { frequency: 'MONTHLY', dayOfMonth: 20 },
                startsOn: nextMonth(),
                ...shared,
                expectedMemberId: f.ma,
                distribution,
            },
            change = {
                scope: 'SHARED',
                kind: 'EXPENSE',
                valueMode: 'FIXED',
                description: 'Versão proibida',
                amountInCents: 4000,
                recurrence: { frequency: 'MONTHLY', dayOfMonth: 20 },
                effectiveFrom: nextMonth(),
                expectedCommitmentVersion: 2,
                ...shared,
                expectedMemberId: f.ma,
                distribution,
            },
            origin = `${base}/financial-commitments/${r.expense.commitment.id}`,
            rec = `${base}/recurring-commitments/${r.financialRecurrence.id}`,
            reference = `${nextMonth().slice(0, 7)}-20`,
            [payment] = await db.query(
                'SELECT id FROM financial_disbursements WHERE commitment_id=$1',
                [r.expense.commitment.id],
            ),
            [installment] = await db.query(
                'SELECT i.id,o.state_version AS version FROM financial_installments i JOIN financial_occurrences o ON o.installment_id=i.id WHERE i.commitment_id=$1 ORDER BY i.position',
                [r.installments.id],
            ),
            posts: [string, object][] = [
                [f.path, shared],
                [`${f.path}/confirmation`, await confirmationInput(f)],
                [`${f.path}/cancellation`, versions(closed)],
                [
                    `${base}/invitations`,
                    { expectedVersion: closed.spaceVersion },
                ],
                [
                    `${base}/shared-cash-expenses`,
                    {
                        ...shared,
                        description: 'Nova despesa',
                        amountInCents: 1000,
                        factDate: day,
                        expectedPayerMemberId: f.ma,
                        responsibilitySplit: distribution,
                        disbursement: {
                            method: 'PIX',
                            payerMemberId: f.ma,
                            amountInCents: 1000,
                        },
                        settlement: { mode: 'NONE' },
                    },
                ],
                [
                    `${base}/planned-expenses`,
                    {
                        scope: 'SHARED',
                        ...shared,
                        description: 'Novo planejamento',
                        amountInCents: 1000,
                        expectedPaymentDate: day,
                        expectedPayerMemberId: f.ma,
                        responsibilitySplit: distribution,
                    },
                ],
                [
                    `${base}/incomes`,
                    {
                        ...shared,
                        description: 'Nova receita',
                        amountInCents: 1000,
                        expectedReceiptDate: day,
                        expectedRecipientMemberId: f.ma,
                        participationSplit: distribution,
                        receipt: null,
                    },
                ],
                [`${base}/recurring-commitments`, recurring],
                [
                    `${base}/installment-commitments`,
                    {
                        scope: 'SHARED',
                        ...shared,
                        description: 'Novo parcelamento',
                        count: 2,
                        firstDueDate: nextMonth(),
                        cadence: 'MONTHLY',
                        totalAmountInCents: 2000,
                        expectedRuleVersion: 0,
                        expectedMemberId: f.ma,
                        distribution,
                    },
                ],
                [`${rec}/versions`, change],
                [
                    `${base}/financial-commitments/${r.financialRecurrence.id}/change-proposals`,
                    change,
                ],
                [
                    `${rec}/termination`,
                    {
                        expectedCommitmentVersion: 2,
                        ...shared,
                        endsOn: nextMonth(),
                    },
                ],
                [
                    `${rec}/occurrences/${reference}/disbursements`,
                    {
                        expectedCommitmentVersion: 2,
                        expectedOccurrenceVersion: 1,
                        ...shared,
                        amountInCents: 1000,
                        factDate: day,
                        method: 'PIX',
                        payerMemberId: f.ma,
                        settlement: { mode: 'NONE' },
                    },
                ],
                [
                    `${base}/installment-commitments/${r.installments.id}/installments/${installment.id}/disbursements`,
                    {
                        expectedCommitmentVersion: 2,
                        expectedInstallmentVersion: installment.version,
                        ...shared,
                        amountInCents: 100,
                        factDate: day,
                        method: 'PIX',
                        payerMemberId: f.ma,
                        settlement: { mode: 'NONE' },
                    },
                ],
                [
                    `${origin}/adjustments`,
                    {
                        expectedCommitmentVersion: 1,
                        ...shared,
                        direction: 'INCREASE',
                        amountInCents: 100,
                        reason: 'Correção proibida',
                        factDate: day,
                    },
                ],
                [
                    `${origin}/reversals`,
                    {
                        expectedCommitmentVersion: 1,
                        ...shared,
                        originalKind: 'DISBURSEMENT',
                        originalId: payment.id,
                        amountInCents: 100,
                        reason: 'Reversão proibida',
                        factDate: day,
                        settlement: { mode: 'NONE' },
                    },
                ],
                [
                    `${origin}/disbursements`,
                    {
                        expectedCommitmentVersion: 1,
                        ...shared,
                        amountInCents: 100,
                        factDate: day,
                        method: 'PIX',
                        payerMemberId: f.ma,
                        settlement: { mode: 'NONE' },
                    },
                ],
                [`${base}/tasks`, { description: 'Nova tarefa' }],
                [
                    `${base}/tasks/${r.completed.id}/reopen`,
                    { expectedVersion: r.completed.version },
                ],
                [
                    `${base}/tasks/${r.pending.id}/complete`,
                    { expectedVersion: 2 },
                ],
                [
                    `${base}/tasks/${r.completed.id}/shopping-list`,
                    {
                        expectedVersion: r.completed.version,
                        shoppingListId: r.list.id,
                    },
                ],
                [
                    `${base}/tasks/${r.completed.id}/shopping-list/removal`,
                    { expectedVersion: r.completed.version },
                ],
                [
                    `${base}/tasks/${r.pending.id}/assignment`,
                    { expectedVersion: 2, assigneeMemberId: f.ma },
                ],
                [
                    `${base}/tasks/${r.pending.id}/deadline`,
                    { expectedVersion: 2, deadline: { date: shiftedDay(2) } },
                ],
                [
                    `${base}/tasks/${r.pending.id}/urgency`,
                    { expectedVersion: 2, urgency: 'URGENT' },
                ],
                [
                    `${base}/task-recurrences`,
                    {
                        description: 'Nova rotina',
                        rule: { frequency: 'DAILY' },
                        startsOn: day,
                    },
                ],
                [
                    `${base}/task-recurrences/${r.recurrence.id}/occurrences/${shiftedDay(-1)}/reopen`,
                    {
                        expectedRecurrenceVersion: 2,
                        expectedOccurrenceVersion: r.past.version,
                    },
                ],
                [
                    `${base}/task-recurrences/${r.recurrence.id}/occurrences/${shiftedDay(-2)}/complete`,
                    {
                        expectedRecurrenceVersion: 2,
                        expectedOccurrenceVersion: null,
                    },
                ],
                [
                    `${base}/task-recurrences/${r.recurrence.id}/cancel`,
                    { expectedVersion: 2 },
                ],
                [`${base}/shopping-lists`, { name: 'Nova lista' }],
                [
                    `${base}/shopping-lists/${r.list.id}/items`,
                    {
                        expectedVersion: 5,
                        description: 'Novo item',
                        desiredQuantity: '1',
                    },
                ],
                [
                    `${base}/shopping-lists/${r.list.id}/items/${r.item.id}/need`,
                    { expectedVersion: 5, desiredQuantity: '5', unit: 'kg' },
                ],
                [
                    `${base}/shopping-lists/${r.list.id}/items/${r.item.id}/purchases`,
                    { expectedVersion: 5, quantity: '1' },
                ],
                [
                    `${base}/shopping-lists/${r.list.id}/items/${r.item.id}/purchases/${r.purchase.id}/corrections`,
                    { expectedVersion: 5, quantity: '1.2' },
                ],
                [
                    `${base}/shopping-lists/${r.list.id}/items/${r.item.id}/removal`,
                    { expectedVersion: 5 },
                ],
                [
                    `${base}/shopping-lists/${r.list.id}/archival`,
                    { expectedVersion: 5 },
                ],
            ],
            before = await snapshot();
        for (const [path, body] of posts) {
            const response = await f.a.post(path, body);
            expect(
                response.status,
                `${path}: ${JSON.stringify(response.body)}`,
            ).toBe(409);
        }
        await f.a
            .put(`${base}/default-settlement-rule`, {
                expectedVersion: 0,
                rule: { kind: 'MONTHLY_DAY', dayOfMonth: 10 },
            })
            .expect(409);
        await f.a
            .put(`${rec}/occurrences/${reference}/value`, {
                expectedCommitmentVersion: 2,
                expectedOccurrenceVersion: 1,
                ...shared,
                amountInCents: 1000,
            })
            .expect(409);
        expect(await snapshot()).toEqual(before);
    });

    it('enforces the cancellation consent collection shape', async () => {
        const f = await closureFinance(app),
            started = await begin(f);
        for (const value of [{}, [{}, {}, {}]])
            await expect(
                db.query(
                    'UPDATE space_closure_processes SET cancellation_consents=$2::jsonb WHERE id=$1',
                    [started.processId, JSON.stringify(value)],
                ),
            ).rejects.toThrow(/cancellation_consents/i);
    });

    it('selects the new completed process after cancellation and restart at the same clock instant', async () => {
        const f = await closureFinance(app, 'solo'),
            started = await begin(f),
            canceled = (
                await f.a
                    .post(`${f.path}/cancellation`, versions(started))
                    .expect(200)
            ).body,
            next = (
                await f.a
                    .post(f.path, {
                        expectedSpaceVersion: canceled.spaceVersion,
                    })
                    .expect(201)
            ).body;
        expect(next.startedAt).toBe(started.startedAt);
        await approve(f, next);
        const completed = await close(f);
        expect(completed).toMatchObject({
            processId: next.processId,
            spaceStatus: 'CLOSED',
            processStatus: 'COMPLETED',
        });
        expect(
            (await f.a.agent.get(`${f.path}/diagnostic`).expect(200)).body
                .closure.processId,
        ).toBe(next.processId);
        expect((await summary(f)).closure.processId).toBe(next.processId);
        expect(
            (await f.a.agent.get(`${f.path}/history`).expect(200)).body.items,
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    processId: next.processId,
                    action: 'CONFIRM_SPACE_CLOSURE',
                    snapshot: expect.objectContaining({
                        spaceStatus: 'CLOSED',
                    }),
                }),
            ]),
        );
    });

    it('replays authorized old routine and shopping receipts in CLOSED without reopening anything', async () => {
        const f = await closureFinance(app),
            base = `/v2/spaces/${f.space}`,
            task = (
                await f.a
                    .post(`${base}/tasks`, {
                        description: 'Histórico de execução',
                    })
                    .expect(201)
            ).body,
            taskKey = randomUUID(),
            completeBody = { expectedVersion: 1 },
            completed = (
                await f.a
                    .post(
                        `${base}/tasks/${task.id}/complete`,
                        completeBody,
                        taskKey,
                    )
                    .expect(200)
            ).body,
            list = (
                await f.a
                    .post(`${base}/shopping-lists`, {
                        name: 'Histórico de compra',
                    })
                    .expect(201)
            ).body,
            item = (
                await f.a
                    .post(`${base}/shopping-lists/${list.id}/items`, {
                        expectedVersion: 1,
                        description: 'Arroz',
                        desiredQuantity: '4',
                        unit: 'kg',
                    })
                    .expect(201)
            ).body.item,
            purchaseKey = randomUUID(),
            purchaseBody = { expectedVersion: 2, quantity: '1' },
            purchasePath = `${base}/shopping-lists/${list.id}/items/${item.id}/purchases`,
            purchased = (
                await f.a
                    .post(purchasePath, purchaseBody, purchaseKey)
                    .expect(201)
            ).body;
        await approve(f, await begin(f));
        await close(f);
        const before = await snapshot();
        expect(
            (
                await f.a
                    .post(
                        `${base}/tasks/${task.id}/complete`,
                        completeBody,
                        taskKey,
                    )
                    .expect(200)
            ).body,
        ).toEqual(completed);
        expect(
            (
                await f.a
                    .post(purchasePath, purchaseBody, purchaseKey)
                    .expect(201)
            ).body,
        ).toEqual(purchased);
        expect(await snapshot()).toEqual(before);
        expect(
            (await f.a.agent.get(`${base}/tasks/${task.id}`).expect(200)).body
                .status,
        ).toBe('COMPLETED');
        expect(
            (
                await f.a.agent
                    .get(`${base}/shopping-lists/${list.id}`)
                    .expect(200)
            ).body.status,
        ).toBe('ARCHIVED');
    });

    it('registers final summary, confirmation and cancellation in executable OpenAPI', () => {
        const paths = createApiOpenApiDocument(false).paths,
            base = '/v2/spaces/{spaceId}/closure';
        expect(paths[`${base}/final-summary`]?.get).toBeDefined();
        expect(paths[`${base}/confirmation`]?.post).toBeDefined();
        expect(paths[`${base}/cancellation`]?.post).toBeDefined();
    });
});
