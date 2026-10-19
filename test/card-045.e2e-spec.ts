import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Logger, type INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
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
import {
    financeBrowser,
    financeSnapshot,
    recordSharedObligation,
    rewindFinanceMigrationsTo,
    sharedExpenseInput,
    sharedFinance,
} from './settlement-fixture.js';
import {
    prepareShoppingDatabase,
    shoppingApp,
    shoppingSnapshot,
} from './shopping-fixture.js';
import { routineSnapshot } from './routine-fixture.js';
import {
    closurePath,
    closureSnapshot,
    formingSharedSpace,
} from './closure-fixture.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../dist/modules/finances/application/ports/private/shared-expense.repositories.js';
import {
    CLOSURE_CLOCK,
    type ClosureClock,
} from '../dist/composition/space-closure/closure.clock.js';
import { todayReferenceDate } from '../dist/composition/today/today.clock.js';
import migrationSource from '../dist/shared/technical/database/typeorm/data-source.js';
import { createApiOpenApiDocument } from '../dist/composition/http/create-api-openapi-document.js';
import {
    FINANCIAL_CLOSURE_DIAGNOSTICS_PORT,
    type FinancialClosureDiagnosticsPort,
} from '../dist/modules/finances/application/ports/public/financial-closure-diagnostics.port.js';

describe('CARD-045 shared space closure request and diagnosis HTTP/PostgreSQL', () => {
    let app: INestApplication<Server>, db: DataSource;
    let closureDay: string;
    beforeAll(prepareShoppingDatabase);
    beforeEach(async () => {
        ({ app, db } = await shoppingApp(
            () => new Date('2026-10-19T14:00:00Z'),
        ));
        const clock = app.get<FinancesClock>(FINANCES_CLOCK);
        vi.spyOn(clock, 'today').mockReturnValue('2026-10-19');
        vi.spyOn(clock, 'now').mockReturnValue(
            new Date('2026-10-19T14:00:00Z'),
        );
        const instant = new Date(Date.now() + 60000);
        closureDay = todayReferenceDate(instant);
        vi.spyOn(app.get<ClosureClock>(CLOSURE_CLOCK), 'now').mockReturnValue(
            instant,
        );
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await app?.close();
    });
    const snapshot = () =>
        Promise.all([
            closureSnapshot(db),
            financeSnapshot(db),
            routineSnapshot(db),
            shoppingSnapshot(db),
        ]);

    it('reads an authorized active space before any closure without persisting an implicit process', async () => {
        const f = await formingSharedSpace(app),
            before = await snapshot(),
            read = await f.a.agent.get(f.path).expect(200),
            history = await f.a.agent.get(`${f.path}/history`).expect(200),
            diagnostic = await f.a.agent
                .get(`${f.path}/diagnostic`)
                .expect(200);
        expect(read.headers['cache-control']).toBe('no-store');
        expect(history.body).toEqual({ items: [], nextCursor: null });
        expect(diagnostic.body).toMatchObject({
            spaceId: f.space,
            closure: null,
            finance: { financiallyReady: true, totalCount: 0, blockers: [] },
        });
        expect(await snapshot()).toEqual(before);
    });

    it('starts an eligible forming space without closing it automatically and invalidates its invitation', async () => {
        const f = await formingSharedSpace(app),
            invitee = await financeBrowser(app, 'Convidado'),
            financialBefore = await financeSnapshot(db);
        await invitee
            .post('/v2/invitations/preview', { token: f.token })
            .expect(200);
        const result = await f.a
            .post(f.path, { expectedSpaceVersion: f.context.version })
            .expect(201);
        expect(result.headers['cache-control']).toBe('no-store');
        expect(result.body).toMatchObject({
            spaceId: f.space,
            spaceStatus: 'CLOSING',
            spaceVersion: f.context.version + 1,
            planRevision: 1,
            processStatus: 'OPEN',
            planStatus: 'DRAFT',
            cutoffDate: closureDay,
            proposedCutoffDate: null,
            requiredMemberIds: [f.memberId],
            approvals: [],
            confirmations: [],
        });
        expect(result.body.processId).toEqual(expect.any(String));
        expect(
            await db.query(
                'SELECT status,cancellation_reason,replaced_by_invitation_id,resolved_at FROM space_invitations WHERE space_id=$1',
                [f.space],
            ),
        ).toMatchObject([
            {
                status: 'CANCELLED',
                cancellation_reason: 'SPACE_CLOSURE',
                replaced_by_invitation_id: null,
                resolved_at: expect.any(Date),
            },
        ]);
        for (const path of ['preview', 'respond']) {
            const response = await invitee
                .post(`/v2/invitations/${path}`, {
                    token: f.token,
                    ...(path === 'respond'
                        ? {
                              decision: 'ACCEPT',
                              expectedVersion: result.body.spaceVersion,
                          }
                        : {}),
                })
                .expect(404);
            expect(response.body.code).toBe('INVITATION_UNAVAILABLE');
        }
        await f.a
            .post(`/v2/spaces/${f.space}/invitations`, {
                expectedVersion: result.body.spaceVersion,
            })
            .expect(409);
        expect(await financeSnapshot(db)).toEqual(financialBefore);
        expect(
            await db.query('SELECT status,version FROM spaces WHERE id=$1', [
                f.space,
            ]),
        ).toEqual([{ status: 'CLOSING', version: result.body.spaceVersion }]);
    });

    it.each(['creator', 'other'] as const)(
        'allows the %s member to request a bilateral closure while preserving both memberships',
        async (requester) => {
            const f = await sharedFinance(app),
                actor = requester === 'creator' ? f.a : f.b,
                members = await db.query(
                    'SELECT * FROM space_members WHERE space_id=$1 ORDER BY id',
                    [f.space],
                ),
                result = await actor
                    .post(closurePath(f.space), {
                        expectedSpaceVersion: f.context.version,
                    })
                    .expect(201);
            expect(result.body).toMatchObject({
                spaceId: f.space,
                spaceStatus: 'CLOSING',
                planRevision: 1,
            });
            expect(result.body.requiredMemberIds.sort()).toEqual(
                [f.ma, f.mb].sort(),
            );
            for (const member of [f.a, f.b]) {
                const read = await member.agent
                    .get(closurePath(f.space))
                    .expect(200);
                expect(read.body.processId).toBe(result.body.processId);
                expect(read.headers['cache-control']).toBe('no-store');
            }
            expect(
                await db.query(
                    'SELECT * FROM space_members WHERE space_id=$1 ORDER BY id',
                    [f.space],
                ),
            ).toEqual(members);
        },
    );

    it('isolates closure commands and reads from personal spaces, outsiders and unknown spaces', async () => {
        const f = await formingSharedSpace(app),
            outsider = await financeBrowser(app),
            before = await snapshot();
        const personal = closurePath(f.a.context.personalSpace.id);
        expect(
            (await f.a.post(personal, { expectedSpaceVersion: 1 }).expect(409))
                .body.code,
        ).toBe('SHARED_SPACE_REQUIRED');
        for (const space of [f.space, randomUUID()]) {
            const path = closurePath(space);
            await outsider.post(path, { expectedSpaceVersion: 1 }).expect(404);
            for (const suffix of ['', '/diagnostic', '/history'])
                await outsider.agent.get(path + suffix).expect(404);
        }
        expect(await snapshot()).toEqual(before);
    });

    it('replays the original request without creating another process, history or audit and rejects key reuse', async () => {
        const f = await formingSharedSpace(app),
            key = randomUUID(),
            input = { expectedSpaceVersion: f.context.version },
            first = await f.a.post(f.path, input, key).expect(201),
            before = await snapshot(),
            replay = await f.a.post(f.path, input, key).expect(201);
        expect(replay.body).toEqual(first.body);
        await f.a
            .post(
                f.path,
                { expectedSpaceVersion: first.body.spaceVersion },
                key,
            )
            .expect(409);
        await f.a.post(f.path, input).expect(409);
        expect(await snapshot()).toEqual(before);
    });

    it('rejects stale versions and malformed commands without invalidating a pending invitation', async () => {
        const f = await formingSharedSpace(app),
            before = await snapshot();
        expect(
            (
                await f.a
                    .post(f.path, {
                        expectedSpaceVersion: f.context.version + 1,
                    })
                    .expect(409)
            ).body.code,
        ).toBe('CONCURRENT_MODIFICATION');
        for (const input of [
            {},
            { expectedSpaceVersion: 0 },
            { expectedSpaceVersion: '1' },
            { expectedSpaceVersion: 1, secondMemberConsent: true },
        ])
            await f.a.post(f.path, input).expect(400);
        expect(await snapshot()).toEqual(before);
    });

    it.each(['closure', 'acceptance'] as const)(
        'serializes invitation acceptance against the request when %s queues first',
        async (winner) => {
            const f = await formingSharedSpace(app),
                invited = await financeBrowser(app, 'Convidado'),
                gate = db.createQueryRunner(),
                pending: Promise<unknown>[] = [];
            await gate.connect();
            await gate.startTransaction();
            try {
                const [{ pid }] = await gate.query(
                    'SELECT pg_backend_pid() AS pid',
                );
                await gate.query(
                    'SELECT id FROM spaces WHERE id=$1 FOR UPDATE',
                    [f.space],
                );
                const closureCommand = () =>
                        f.a
                            .post(f.path, {
                                expectedSpaceVersion: f.context.version,
                            })
                            .then((response) => response),
                    acceptanceCommand = () =>
                        invited
                            .post('/v2/invitations/respond', {
                                token: f.token,
                                decision: 'ACCEPT',
                                expectedVersion: f.context.version,
                            })
                            .then((response) => response);
                const awaitContenders = (count: number) =>
                    vi.waitFor(
                        async () => {
                            const rows = await db.query(
                                `WITH RECURSIVE blocked(pid) AS (
                        SELECT pid FROM pg_stat_activity WHERE datname=current_database()
                            AND $1=ANY(pg_blocking_pids(pid))
                        UNION
                        SELECT waiting.pid FROM pg_stat_activity waiting
                            JOIN blocked prior ON prior.pid=ANY(pg_blocking_pids(waiting.pid))
                        WHERE waiting.datname=current_database()
                    ) SELECT pid FROM blocked`,
                                [pid],
                            );
                            expect(rows).toHaveLength(count);
                        },
                        { timeout: 10000, interval: 20 },
                    );
                const first =
                    winner === 'closure'
                        ? closureCommand()
                        : acceptanceCommand();
                pending.push(first);
                await awaitContenders(1);
                const second =
                    winner === 'closure'
                        ? acceptanceCommand()
                        : closureCommand();
                pending.push(second);
                await awaitContenders(2);
                await gate.commitTransaction();
                const [firstResponse, secondResponse] = await Promise.all([
                        first,
                        second,
                    ]),
                    closure =
                        winner === 'closure' ? firstResponse : secondResponse,
                    acceptance =
                        winner === 'closure' ? secondResponse : firstResponse;
                if (winner === 'closure') {
                    expect(closure.status).toBe(201);
                    expect(acceptance.status).toBe(409);
                    expect(acceptance.body.code).toBe(
                        'CONCURRENT_MODIFICATION',
                    );
                } else {
                    expect(closure.status).toBe(409);
                    expect(acceptance.status).toBe(200);
                }
                const [space] = await db.query(
                    'SELECT status,version FROM spaces WHERE id=$1',
                    [f.space],
                );
                const members = await db.query(
                    'SELECT id FROM space_members WHERE space_id=$1',
                    [f.space],
                );
                expect(members).toHaveLength(closure.status === 201 ? 1 : 2);
                expect(space.status).toBe(
                    closure.status === 201 ? 'CLOSING' : 'ACTIVE',
                );
                if (acceptance.status === 200) {
                    const result = await f.a
                        .post(f.path, { expectedSpaceVersion: space.version })
                        .expect(201);
                    expect(result.body.spaceStatus).toBe('CLOSING');
                }
            } finally {
                if (gate.isTransactionActive) await gate.rollbackTransaction();
                await gate.release();
                await Promise.allSettled(pending);
            }
        },
    );

    it('reads the diagnosis repeatedly without financial writes or occurrence materialization', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}`;
        await recordSharedObligation(f, 3000);
        await f.a
            .post(
                `${base}/shared-cash-expenses`,
                sharedExpenseInput(f, 5000, 1000),
            )
            .expect(201);
        await f.a
            .post(`${base}/credit-card-purchases`, {
                description: 'Cartão com responsabilidade externa',
                amountInCents: 2000,
                factDate: '2026-10-14',
                expectedSpaceVersion: f.context.version,
                externalLiability: {
                    amountInCents: 2000,
                    holderMemberId: f.ma,
                },
                responsibilitySplit: {
                    mode: 'AMOUNTS',
                    shares: [
                        { memberId: f.ma, amountInCents: 1000 },
                        { memberId: f.mb, amountInCents: 1000 },
                    ],
                },
                settlement: { mode: 'NONE' },
            })
            .expect(201);
        await f.a
            .post(`${base}/recurring-commitments`, {
                scope: 'SHARED',
                kind: 'EXPENSE',
                description: 'Aluguel futuro',
                amountInCents: 10000,
                recurrence: { frequency: 'MONTHLY', dayOfMonth: 20 },
                startsOn: '2026-11-01',
                expectedSpaceVersion: f.context.version,
                expectedMemberId: f.ma,
                distribution: {
                    mode: 'PERCENTAGES',
                    shares: [
                        { memberId: f.ma, basisPoints: 5000 },
                        { memberId: f.mb, basisPoints: 5000 },
                    ],
                },
            })
            .expect(201);
        await f.a
            .post(`${base}/installment-commitments`, {
                scope: 'SHARED',
                description: 'Parcelas futuras da casa',
                count: 2,
                firstDueDate: '2026-11-19',
                cadence: 'MONTHLY',
                totalAmountInCents: 4000,
                expectedSpaceVersion: f.context.version,
                expectedMemberId: f.ma,
                expectedRuleVersion: 0,
                distribution: {
                    mode: 'PERCENTAGES',
                    shares: [
                        { memberId: f.ma, basisPoints: 5000 },
                        { memberId: f.mb, basisPoints: 5000 },
                    ],
                },
            })
            .expect(201);
        const process = (
            await f.a
                .post(closurePath(f.space), {
                    expectedSpaceVersion: f.context.version,
                })
                .expect(201)
        ).body;
        const before = await snapshot(),
            first = await f.a.agent
                .get(`${closurePath(f.space)}/diagnostic`)
                .expect(200),
            second = await f.b.agent
                .get(`${closurePath(f.space)}/diagnostic`)
                .expect(200);
        expect(first.headers['cache-control']).toBe('no-store');
        expect(first.body).toEqual(second.body);
        expect(first.body.closure.processId).toBe(process.processId);
        expect(first.body.finance).toMatchObject({
            financiallyReady: false,
            counts: {
                OPEN_EXTERNAL_LIABILITY: 1,
                ACTIVE_RECURRENCE: 1,
                UNRESOLVED_INSTALLMENT: 2,
            },
        });
        expect(
            first.body.finance.counts.INTER_MEMBER_OBLIGATION,
        ).toBeGreaterThan(0);
        expect(
            first.body.finance.counts.OPEN_ONE_TIME_COMMITMENT,
        ).toBeGreaterThan(0);
        expect(first.body.finance.blockers).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: 'OPEN_EXTERNAL_LIABILITY',
                    amountInCents: '2000',
                    responsibleMemberId: f.ma,
                    action: expect.any(String),
                }),
                expect.objectContaining({
                    type: 'ACTIVE_RECURRENCE',
                    commitmentId: expect.any(String),
                    action: expect.any(String),
                }),
            ]),
        );
        expect(await snapshot()).toEqual(before);
    });

    it('keeps routine and shopping informational while an empty financial diagnosis is ready', async () => {
        const f = await formingSharedSpace(app),
            base = `/v2/spaces/${f.space}`;
        await f.a
            .post(`${base}/tasks`, { description: 'Organizar a casa' })
            .expect(201);
        await f.a
            .post(`${base}/shopping-lists`, { name: 'Mercado' })
            .expect(201);
        await f.a
            .post(f.path, { expectedSpaceVersion: f.context.version })
            .expect(201);
        const before = await snapshot(),
            result = await f.a.agent.get(`${f.path}/diagnostic`).expect(200);
        expect(result.body.finance).toMatchObject({
            financiallyReady: true,
            blockers: [],
            totalCount: 0,
            outstandingAmounts: [],
        });
        expect(result.body.informational).toEqual({
            routine: { pendingTaskCount: 1, activeRecurrenceCount: 0 },
            shopping: { activeListCount: 1 },
            blocksFinancialClosure: false,
        });
        expect(await snapshot()).toEqual(before);
    });

    it('proposes a later cutoff as a new revision while retaining the effective cutoff until approval', async () => {
        const f = await formingSharedSpace(app),
            started = (
                await f.a
                    .post(f.path, { expectedSpaceVersion: f.context.version })
                    .expect(201)
            ).body,
            future = new Date(`${closureDay}T12:00:00Z`);
        future.setUTCDate(future.getUTCDate() + 3);
        const proposedDate = future.toISOString().slice(0, 10),
            input = {
                expectedSpaceVersion: started.spaceVersion,
                expectedPlanRevision: 1,
                cutoffDate: proposedDate,
            },
            key = randomUUID(),
            changed = await f.a
                .post(`${f.path}/cutoff-date`, input, key)
                .expect(200);
        expect(changed.body).toMatchObject({
            processId: started.processId,
            spaceStatus: 'CLOSING',
            planRevision: 2,
            cutoffDate: closureDay,
            proposedCutoffDate: proposedDate,
            approvals: [],
            confirmations: [],
        });
        const before = await snapshot();
        expect(
            (await f.a.post(`${f.path}/cutoff-date`, input, key).expect(200))
                .body,
        ).toEqual(changed.body);
        await f.a.post(`${f.path}/cutoff-date`, input).expect(409);
        await f.a
            .post(`${f.path}/cutoff-date`, {
                ...input,
                expectedSpaceVersion: changed.body.spaceVersion,
                expectedPlanRevision: changed.body.planRevision,
                cutoffDate: '2020-01-01',
            })
            .expect(400);
        expect(await snapshot()).toEqual(before);
    });

    it('paginates process history without duplicate records and rejects a cursor belonging to another space', async () => {
        const f = await formingSharedSpace(app),
            other = await formingSharedSpace(app),
            started = (
                await f.a
                    .post(f.path, { expectedSpaceVersion: f.context.version })
                    .expect(201)
            ).body,
            future = new Date(`${closureDay}T12:00:00Z`);
        future.setUTCDate(future.getUTCDate() + 1);
        await f.a
            .post(`${f.path}/cutoff-date`, {
                expectedSpaceVersion: started.spaceVersion,
                expectedPlanRevision: 1,
                cutoffDate: future.toISOString().slice(0, 10),
            })
            .expect(200);
        const before = await snapshot(),
            first = (
                await f.a.agent.get(`${f.path}/history?limit=1`).expect(200)
            ).body,
            second = (
                await f.a.agent
                    .get(
                        `${f.path}/history?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
                    )
                    .expect(200)
            ).body;
        expect(first.items).toHaveLength(1);
        expect(first.nextCursor).toEqual(expect.any(String));
        expect(second.items).toHaveLength(1);
        expect(second.nextCursor).toBeNull();
        expect(
            new Set(
                [...first.items, ...second.items].map(
                    (item: { id: string }) => item.id,
                ),
            ).size,
        ).toBe(2);
        for (const item of [...first.items, ...second.items])
            expect(item).toMatchObject({
                processId: started.processId,
                actorMemberId: f.memberId,
                recordedAt: expect.any(String),
                snapshot: { processId: started.processId },
            });
        await other.a.agent
            .get(
                `${other.path}/history?cursor=${encodeURIComponent(first.nextCursor)}`,
            )
            .expect(400);
        for (const query of ['limit=0', 'offset=-1', 'cursor=invalid'])
            await f.a.agent.get(`${f.path}/history?${query}`).expect(400);
        expect(await snapshot()).toEqual(before);
    });

    it('blocks new shared financial responsibilities in CLOSING, preserves reading and keeps the personal space usable', async () => {
        const f = await sharedFinance(app),
            path = closurePath(f.space),
            started = (
                await f.a
                    .post(path, { expectedSpaceVersion: f.context.version })
                    .expect(201)
            ).body,
            before = await financeSnapshot(db);
        await f.a
            .post(`/v2/spaces/${f.space}/shared-cash-expenses`, {
                ...sharedExpenseInput(f),
                expectedSpaceVersion: started.spaceVersion,
            })
            .expect(409);
        expect(await financeSnapshot(db)).toEqual(before);
        await f.a.agent.get(`/v2/spaces/${f.space}`).expect(200);
        const today = (
            await f.a.agent.get(`/v2/spaces/${f.space}/today`).expect(200)
        ).body;
        expect(today).toMatchObject({
            spaceStatus: 'CLOSING',
            capabilities: { spaceClosureAttention: 'SUPPORTED' },
            closure: {
                status: 'AVAILABLE',
                data: { processId: started.processId },
            },
        });
        expect(
            today.blocks.find(
                (block: { kind: string }) => block.kind === 'ATTENTION',
            ).items,
        ).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: 'SPACE_CLOSURE',
                    reference: {
                        type: 'SPACE_CLOSURE',
                        processId: started.processId,
                    },
                }),
            ]),
        );
        await f.a
            .post(
                `/v2/spaces/${f.a.context.personalSpace.id}/personal-expenses`,
                {
                    description: 'Despesa pessoal durante encerramento',
                    amountInCents: 500,
                    factDate: '2026-10-19',
                    disbursement: { method: 'PIX', amountInCents: 500 },
                },
            )
            .expect(201);
    });

    it('cuts off new recurring responsibilities while allowing pre-cutoff settlement and retaining future diagnosis blockers', async () => {
        const f = await sharedFinance(app),
            base = `/v2/spaces/${f.space}`,
            reference = new Date(`${closureDay}T12:00:00Z`),
            previousMonth = new Date(
                Date.UTC(
                    reference.getUTCFullYear(),
                    reference.getUTCMonth(),
                    0,
                    12,
                ),
            ),
            previousDate = `${previousMonth.toISOString().slice(0, 7)}-${String(Math.min(reference.getUTCDate(), previousMonth.getUTCDate())).padStart(2, '0')}`,
            root = (
                await f.a
                    .post(`${base}/recurring-commitments`, {
                        scope: 'SHARED',
                        valueMode: 'VARIABLE',
                        kind: 'EXPENSE',
                        description: 'Conta mensal durante encerramento',
                        expectedAmountInCents: 1000,
                        recurrence: {
                            frequency: 'MONTHLY',
                            dayOfMonth: reference.getUTCDate(),
                        },
                        startsOn: previousDate,
                        expectedSpaceVersion: f.context.version,
                        expectedMemberId: f.ma,
                        distribution: {
                            mode: 'PERCENTAGES',
                            shares: [
                                { memberId: f.ma, basisPoints: 5000 },
                                { memberId: f.mb, basisPoints: 5000 },
                            ],
                        },
                    })
                    .expect(201)
            ).body.commitment,
            process = (
                await f.a
                    .post(closurePath(f.space), {
                        expectedSpaceVersion: f.context.version,
                    })
                    .expect(201)
            ).body,
            futurePath = `${base}/recurring-commitments/${root.id}/occurrences/${closureDay}`,
            pastPath = `${base}/recurring-commitments/${root.id}/occurrences/${previousDate}`,
            input = {
                expectedCommitmentVersion: 1,
                expectedOccurrenceVersion: 1,
                expectedSpaceVersion: process.spaceVersion,
                amountInCents: 1000,
            },
            before = await financeSnapshot(db);
        const options = await f.a.agent
            .get(`${futurePath}/options`)
            .expect(409);
        expect(options.body.code).toBe('CLOSURE_CUTOFF_REACHED');
        expect(
            (await f.a.put(`${futurePath}/value`, input).expect(409)).body.code,
        ).toBe('CLOSURE_CUTOFF_REACHED');
        expect(
            (
                await f.a
                    .post(`${futurePath}/disbursements`, {
                        ...input,
                        factDate: closureDay,
                        method: 'PIX',
                        payerMemberId: f.ma,
                        settlement: { mode: 'NONE' },
                    })
                    .expect(409)
            ).body.code,
        ).toBe('CLOSURE_CUTOFF_REACHED');
        expect(await financeSnapshot(db)).toEqual(before);
        await f.a.agent.get(`${pastPath}/options`).expect(200);
        const valued = (await f.a.put(`${pastPath}/value`, input).expect(200))
            .body.occurrence;
        await f.a
            .post(`${pastPath}/disbursements`, {
                ...input,
                expectedOccurrenceVersion: valued.stateVersion,
                factDate: closureDay,
                method: 'PIX',
                payerMemberId: f.ma,
                settlement: { mode: 'NONE' },
            })
            .expect(201);
        const today = (await f.a.agent.get(`${base}/today`).expect(200)).body;
        for (const block of today.blocks)
            for (const item of block.items)
                if (
                    item.reference.type === 'FINANCIAL_COMMITMENT' &&
                    item.reference.commitmentId === root.id
                )
                    expect(item.reference.expectedDate < closureDay).toBe(true);
        const diagnosis = (
            await f.a.agent
                .get(`${closurePath(f.space)}/diagnostic`)
                .expect(200)
        ).body;
        expect(diagnosis.finance).toMatchObject({
            financiallyReady: false,
            counts: { ACTIVE_RECURRENCE: 1 },
        });
        expect(diagnosis.finance.blockers).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: 'ACTIVE_RECURRENCE',
                    commitmentId: root.id,
                }),
            ]),
        );
        expect(
            await db.query(
                'SELECT id FROM financial_occurrences WHERE commitment_id=$1 AND reference_date=$2',
                [root.id, closureDay],
            ),
        ).toEqual([]);
    });

    it.each(['space_closure_history', 'space_closure_audit'])(
        'rolls back space status, invitation cancellation, process and receipt when %s fails',
        async (table) => {
            const f = await formingSharedSpace(app),
                before = await snapshot();
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            await db.query(
                `ALTER TABLE ${table} ADD CONSTRAINT test_reject_closure CHECK (false) NOT VALID`,
            );
            try {
                await f.a
                    .post(f.path, { expectedSpaceVersion: f.context.version })
                    .expect(500);
                expect(await snapshot()).toEqual(before);
            } finally {
                await db.query(
                    `ALTER TABLE ${table} DROP CONSTRAINT test_reject_closure`,
                );
            }
            await f.a
                .post(f.path, { expectedSpaceVersion: f.context.version })
                .expect(201);
        },
    );

    it('requires authentication and CSRF for closure commands', async () => {
        const f = await formingSharedSpace(app),
            before = await snapshot();
        await request(app.getHttpServer()).get(f.path).expect(401);
        await f.a.agent
            .post(f.path)
            .set('Idempotency-Key', randomUUID())
            .send({ expectedSpaceVersion: f.context.version })
            .expect(403);
        expect(await snapshot()).toEqual(before);
    });

    it('does not replace a failed financial diagnosis with empty blockers or financial readiness', async () => {
        const f = await formingSharedSpace(app),
            before = await snapshot();
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        vi.spyOn(
            app.get<FinancialClosureDiagnosticsPort>(
                FINANCIAL_CLOSURE_DIAGNOSTICS_PORT,
            ),
            'read',
        ).mockRejectedValue(new Error('Diagnosis source unavailable'));
        const response = await f.a.agent
            .get(`${f.path}/diagnostic`)
            .expect(500);
        expect(response.body).not.toHaveProperty(
            'finance.financiallyReady',
            true,
        );
        expect(await snapshot()).toEqual(before);
    });

    it('rechecks access after diagnostic sources are read', async () => {
        const f = await formingSharedSpace(app),
            outsider = await financeBrowser(app),
            before = await snapshot(),
            finances = app.get<FinancialClosureDiagnosticsPort>(
                FINANCIAL_CLOSURE_DIAGNOSTICS_PORT,
            ),
            read = finances.read.bind(finances);
        vi.spyOn(finances, 'read').mockImplementationOnce(async (...args) => {
            const result = await read(...args);
            await db.query(
                'UPDATE space_members SET person_id=$2 WHERE id=$1',
                [f.memberId, outsider.context.person.id],
            );
            return result;
        });
        try {
            await f.a.agent.get(`${f.path}/diagnostic`).expect(404);
        } finally {
            await db.query(
                'UPDATE space_members SET person_id=$2 WHERE id=$1',
                [f.memberId, f.a.context.person.id],
            );
        }
        expect(await snapshot()).toEqual(before);
    });

    it('reapplies an empty closure migration and protects persisted closure history from rollback', async () => {
        await migrationSource.initialize();
        try {
            const migration = migrationSource.migrations.find((entry) =>
                (entry.name ?? entry.constructor.name).startsWith(
                    'SharedSpaceClosure',
                ),
            );
            expect(migration).toBeDefined();
            const migrationName =
                migration!.name ?? migration!.constructor.name;
            await rewindFinanceMigrationsTo(migrationSource, migrationName);
            await migrationSource.undoLastMigration();
            expect(
                (
                    await db.query(
                        "SELECT to_regclass('public.space_closure_processes') AS name",
                    )
                )[0].name,
            ).toBeNull();
            await migrationSource.runMigrations();
            const f = await formingSharedSpace(app);
            await f.a
                .post(f.path, { expectedSpaceVersion: f.context.version })
                .expect(201);
            await rewindFinanceMigrationsTo(migrationSource, migrationName);
            const before = await snapshot();
            await expect(migrationSource.undoLastMigration()).rejects.toThrow(
                /histórico|encerramento/i,
            );
            expect(await snapshot()).toEqual(before);
        } finally {
            await migrationSource.runMigrations();
            await migrationSource.destroy();
        }
    });

    it('registers closure request, diagnostic, cutoff and history contracts in executable OpenAPI', () => {
        const paths = createApiOpenApiDocument(false).paths,
            base = '/v2/spaces/{spaceId}/closure';
        expect(paths[base]?.post).toBeDefined();
        expect(paths[base]?.get).toBeDefined();
        expect(paths[`${base}/diagnostic`]?.get).toBeDefined();
        expect(paths[`${base}/cutoff-date`]?.post).toBeDefined();
        expect(paths[`${base}/history`]?.get).toBeDefined();
    });
});
