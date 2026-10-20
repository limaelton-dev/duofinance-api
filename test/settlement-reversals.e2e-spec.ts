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
import { TODAY_CLOCK } from '../dist/composition/today/today.clock.js';
import {
    commitmentPath,
    competingFinanceCommands,
    financeBase,
    financeBrowser,
    financeSnapshot,
    obligationPath,
    recordSharedObligation,
    sharedFinance,
    type SharedFinance,
} from './settlement-fixture.js';

type Kind = 'TRANSFER' | 'OFFSET';
type ReversalOptions = {
    allocations: { id: string; amountInCents: number }[];
    obligations: { id: string; version: number }[];
    cycles: { id: string; version: number }[];
};

describe('resolution reversals and settlement journey HTTP/PostgreSQL', () => {
    let app: INestApplication<Server>, db: DataSource, instant: Date;
    const today = () =>
        new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Sao_Paulo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(instant);
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
        instant = new Date('2026-10-14T15:00:00Z');
        const module = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(FINANCES_CLOCK)
            .useValue({ now: () => instant, today })
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
        vi.restoreAllMocks();
        await app?.close();
    });
    const originalPath = (f: SharedFinance, kind: Kind, id: string) =>
        `${financeBase(f.space)}/settlement-${kind === 'TRANSFER' ? 'transfers' : 'offsets'}/${id}`;
    const reversePath = (f: SharedFinance, kind: Kind, id: string) =>
        `${originalPath(f, kind, id)}/reversals`;
    const options = async (f: SharedFinance, kind: Kind, id: string) =>
        (
            await f.a.agent
                .get(`${originalPath(f, kind, id)}/reversal-options`)
                .expect(200)
        ).body;
    async function confirmation(
        f: SharedFinance,
        preview: ReversalOptions,
        correctionCycleId?: string,
    ) {
        const cycles = [...preview.cycles];
        if (
            correctionCycleId &&
            !cycles.some((cycle) => cycle.id === correctionCycleId)
        ) {
            const [cycle] = await db.query(
                'SELECT id,version FROM settlement_cycles WHERE id=$1',
                [correctionCycleId],
            );
            cycles.push(cycle ?? { id: correctionCycleId, version: 1 });
        }
        return {
            expectedSpaceVersion: f.context.version,
            factDate: '2026-10-14',
            expectedObligationVersions: preview.obligations.map((row) => ({
                obligationId: row.id,
                version: row.version,
            })),
            expectedCycleVersions: cycles.map((row) => ({
                cycleId: row.id,
                version: row.version,
            })),
            applications: preview.allocations.map((row) => ({
                allocationId: row.id,
                amountInCents: row.amountInCents,
            })),
            ...(correctionCycleId ? { correctionCycleId } : {}),
        };
    }
    async function emptyCycle(f: SharedFinance, date = '2026-11-10') {
        const id = randomUUID();
        await db.query(
            "INSERT INTO settlement_cycles(id,space_id,target_date,status,version) VALUES($1,$2,$3,'OPEN',1)",
            [id, f.space, date],
        );
        return id;
    }
    const obligations = async (commitment: string) =>
        db.query(
            'SELECT * FROM inter_member_obligations WHERE commitment_id=$1 ORDER BY id',
            [commitment],
        );
    async function transfer(
        f: SharedFinance,
        entries: { id: string; amount: number }[],
        payer = f.ma,
        recipient = f.mb,
    ) {
        const versions: { id: string; version: number }[] = await db.query(
            'SELECT id,version FROM inter_member_obligations WHERE id=ANY($1::uuid[])',
            [entries.map((row) => row.id)],
        );
        return (
            await f.a
                .post(`${financeBase(f.space)}/settlement-transfers`, {
                    expectedSpaceVersion: f.context.version,
                    factDate: '2026-10-14',
                    payerMemberId: payer,
                    recipientMemberId: recipient,
                    amountInCents: entries.reduce(
                        (sum, row) => sum + row.amount,
                        0,
                    ),
                    allocations: entries.map((row) => ({
                        obligationId: row.id,
                        amountInCents: row.amount,
                        expectedObligationVersion: versions.find(
                            (v) => v.id === row.id,
                        )!.version,
                    })),
                })
                .expect(201)
        ).body;
    }
    async function offset(
        f: SharedFinance,
        a: string,
        b: string,
        amount: number,
    ) {
        const rows: { id: string; cycle_id: string | null; version: number }[] =
            await db.query(
                'SELECT id,cycle_id,version FROM inter_member_obligations WHERE id=ANY($1::uuid[]) ORDER BY id',
                [[a, b]],
            );
        const cycleIds = [
            ...new Set(
                rows.flatMap((row) => (row.cycle_id ? [row.cycle_id] : [])),
            ),
        ];
        const cycles: { id: string; version: number }[] = await db.query(
            'SELECT id,version FROM settlement_cycles WHERE id=ANY($1::uuid[])',
            [cycleIds],
        );
        return (
            await f.a
                .post(`${financeBase(f.space)}/settlement-offsets`, {
                    expectedSpaceVersion: f.context.version,
                    factDate: '2026-10-14',
                    scope: {
                        cycleIds,
                        obligationIds: rows
                            .filter((row) => !row.cycle_id)
                            .map((row) => row.id),
                    },
                    expectedCycleVersions: cycles.map((row) => ({
                        cycleId: row.id,
                        version: row.version,
                    })),
                    allocations: rows.map((row) => ({
                        obligationId: row.id,
                        expectedObligationVersion: row.version,
                        amountInCents: amount,
                    })),
                })
                .expect(201)
        ).body;
    }
    async function waive(f: SharedFinance, id: string, amount: number) {
        const [current] = await db.query(
            'SELECT version FROM inter_member_obligations WHERE id=$1',
            [id],
        );
        return (
            await f.b
                .post(`${obligationPath(f.space, id)}/waivers`, {
                    expectedSpaceVersion: f.context.version,
                    expectedObligationVersion: current.version,
                    amountInCents: amount,
                    factDate: '2026-10-14',
                })
                .expect(201)
        ).body;
    }
    async function finalize(f: SharedFinance, id: string) {
        const [cycle] = await db.query(
            'SELECT version FROM settlement_cycles WHERE id=$1',
            [id],
        );
        return (
            await f.a
                .post(
                    `${financeBase(f.space)}/settlement-cycles/${id}/finalize`,
                    {
                        expectedSpaceVersion: f.context.version,
                        expectedCycleVersion: cycle.version,
                    },
                )
                .expect(200)
        ).body;
    }
    async function frozenState(cycleIds: string[]) {
        const cycles = await db.query(
            'SELECT * FROM settlement_cycles WHERE id=ANY($1::uuid[]) ORDER BY id',
            [cycleIds],
        );
        const pending = await db.query(
            'SELECT * FROM inter_member_obligations WHERE cycle_id=ANY($1::uuid[]) ORDER BY id',
            [cycleIds],
        );
        const history = await db.query(
            'SELECT * FROM inter_member_obligation_changes WHERE obligation_id=ANY($1::uuid[]) ORDER BY obligation_id,version',
            [pending.map((row: { id: string }) => row.id)],
        );
        return { cycles, pending, history };
    }

    it.each([false, true])(
        'reverses a transfer in either direction without altering the original fact (opposite=%s)',
        async (opposite) => {
            const f = await sharedFinance(app);
            const original = await recordSharedObligation(
                f,
                10000,
                '2026-10-20',
                opposite ? f.ma : f.mb,
            );
            const recorded = await transfer(
                f,
                [{ id: original.obligation.id, amount: 4000 }],
                opposite ? f.mb : f.ma,
                opposite ? f.ma : f.mb,
            );
            const oldTransfer = await db.query(
                'SELECT * FROM settlement_transfers',
            );
            const oldAllocations = await db.query(
                'SELECT * FROM settlement_allocations',
            );
            const before = await financeSnapshot(db);
            const preview = await options(f, 'TRANSFER', recorded.transfer.id);
            expect(preview).toMatchObject({
                reversibleAmountInCents: 4000,
                canReverse: true,
                requiresCorrectionCycle: false,
            });
            expect(await financeSnapshot(db)).toEqual(before);
            const result = (
                await f.b
                    .post(
                        reversePath(f, 'TRANSFER', recorded.transfer.id),
                        await confirmation(f, preview),
                    )
                    .expect(201)
            ).body;
            expect(result.reversal).toMatchObject({
                originalKind: 'TRANSFER',
                originalId: recorded.transfer.id,
                amountInCents: 4000,
                createdByPersonId: f.b.context.person.id,
            });
            expect(
                (await obligations(original.commitment.id)).filter(
                    (row: { remaining_amount_in_cents: string }) =>
                        BigInt(row.remaining_amount_in_cents) > 0n,
                ),
            ).toEqual([
                expect.objectContaining({
                    debtor_member_id: opposite ? f.mb : f.ma,
                    creditor_member_id: opposite ? f.ma : f.mb,
                    remaining_amount_in_cents: '10000',
                }),
            ]);
            expect(
                await db.query('SELECT * FROM settlement_transfers'),
            ).toEqual(oldTransfer);
            expect(
                await db.query('SELECT * FROM settlement_allocations'),
            ).toEqual(oldAllocations);
            const after = await options(f, 'TRANSFER', recorded.transfer.id);
            expect(after).toMatchObject({
                reversibleAmountInCents: 0,
                canReverse: false,
                reversalBlockReason: 'ALREADY_REVERSED',
            });
            expect(after.previousReversals).toHaveLength(1);
            const detail = (
                await f.a.agent
                    .get(originalPath(f, 'TRANSFER', recorded.transfer.id))
                    .expect(200)
            ).body;
            expect(detail.transfer).toMatchObject({
                amountInCents: 4000,
                reversedAmountInCents: 4000,
                effectiveAmountInCents: 0,
                reversalId: result.reversal.id,
            });
            const cycle = (
                await f.a.agent
                    .get(
                        `${financeBase(f.space)}/settlement-cycles/${original.settlementCycle.id}`,
                    )
                    .expect(200)
            ).body.cycle;
            expect(cycle.totals).toMatchObject({
                transferredAmountInCents: '4000',
                reversedTransferredAmountInCents: '4000',
                effectiveTransferredAmountInCents: '0',
            });
            await f.a
                .post(
                    reversePath(f, 'TRANSFER', recorded.transfer.id),
                    await confirmation(f, after),
                )
                .expect(409);
        },
    );

    it('reverses an offset with equivalent applications and keeps transferred cash zero', async () => {
        const f = await sharedFinance(app);
        const a = await recordSharedObligation(f, 35000, '2026-10-20', f.mb);
        const b = await recordSharedObligation(f, 8000, '2026-10-21', f.ma);
        const recorded = await offset(
            f,
            a.obligation.id,
            b.obligation.id,
            8000,
        );
        const old = await db.query(
            'SELECT * FROM settlement_offset_allocations ORDER BY id',
        );
        const preview = await options(f, 'OFFSET', recorded.offset.id);
        const result = (
            await f.b
                .post(
                    reversePath(f, 'OFFSET', recorded.offset.id),
                    await confirmation(f, preview),
                )
                .expect(201)
        ).body;
        expect(result.reversal.amountInCents).toBe(8000);
        expect(result.applications).toHaveLength(2);
        expect(
            (await obligations(a.commitment.id))[0].remaining_amount_in_cents,
        ).toBe('35000');
        expect(
            (await obligations(b.commitment.id))[0].remaining_amount_in_cents,
        ).toBe('8000');
        expect(
            await db.query(
                'SELECT * FROM settlement_offset_allocations ORDER BY id',
            ),
        ).toEqual(old);
        expect(await db.query('SELECT * FROM settlement_transfers')).toEqual(
            [],
        );
        expect(
            (
                await f.a.agent
                    .get(originalPath(f, 'OFFSET', recorded.offset.id))
                    .expect(200)
            ).body.offset,
        ).toMatchObject({
            amountInCents: 8000,
            reversedAmountInCents: 8000,
            effectiveAmountInCents: 0,
        });
    });

    it('recalculates from later disbursements and creditor waivers instead of restoring an old balance', async () => {
        const f = await sharedFinance(app);
        const initial = await recordSharedObligation(
            f,
            35000,
            '2026-10-20',
            f.mb,
            50000,
        );
        const recorded = await transfer(f, [
            { id: initial.obligation.id, amount: 5000 },
        ]);
        await waive(f, initial.obligation.id, 10000);
        await f.a
            .post(
                `${commitmentPath(f.space, initial.commitment.id)}/disbursements`,
                {
                    expectedSpaceVersion: f.context.version,
                    expectedCommitmentVersion: initial.commitment.version,
                    amountInCents: 15000,
                    factDate: '2026-10-14',
                    payerMemberId: f.mb,
                    method: 'PIX',
                    settlement: { mode: 'NONE' },
                },
            )
            .expect(201);
        const waivers = await db.query(
            'SELECT * FROM obligation_waivers ORDER BY id',
        );
        const facts = await db.query(
            'SELECT * FROM financial_disbursements ORDER BY id',
        );
        const preview = await options(f, 'TRANSFER', recorded.transfer.id);
        await f.b
            .post(
                reversePath(f, 'TRANSFER', recorded.transfer.id),
                await confirmation(f, preview),
            )
            .expect(201);
        const current = await obligations(initial.commitment.id);
        expect(
            current.reduce(
                (sum: bigint, row: { remaining_amount_in_cents: string }) =>
                    sum + BigInt(row.remaining_amount_in_cents),
                0n,
            ),
        ).toBe(40000n);
        expect(
            await db.query('SELECT * FROM obligation_waivers ORDER BY id'),
        ).toEqual(waivers);
        expect(
            await db.query('SELECT * FROM financial_disbursements ORDER BY id'),
        ).toEqual(facts);
    });

    it('eliminates the opposite income debt created by a later receipt when the original transfer is reversed', async () => {
        const f = await sharedFinance(app);
        const income = (
            await f.a
                .post(`${financeBase(f.space)}/incomes`, {
                    description: 'Recebimentos alternados',
                    amountInCents: 20000,
                    expectedReceiptDate: '2026-10-20',
                    expectedSpaceVersion: f.context.version,
                    expectedRecipientMemberId: f.ma,
                    participationSplit: {
                        mode: 'AMOUNTS',
                        shares: [
                            { memberId: f.ma, amountInCents: 10000 },
                            { memberId: f.mb, amountInCents: 10000 },
                        ],
                    },
                    receipt: {
                        recipientMemberId: f.ma,
                        amountInCents: 10000,
                        factDate: '2026-10-14',
                        settlement: { mode: 'DATE', targetDate: '2026-10-20' },
                    },
                })
                .expect(201)
        ).body;
        const recorded = await transfer(f, [
            { id: income.obligation.id, amount: 5000 },
        ]);
        await f.a
            .post(`${commitmentPath(f.space, income.commitment.id)}/receipts`, {
                expectedSpaceVersion: f.context.version,
                expectedCommitmentVersion: income.commitment.version,
                recipientMemberId: f.mb,
                amountInCents: 10000,
                factDate: '2026-10-14',
                settlement: { mode: 'DATE', targetDate: '2026-10-21' },
            })
            .expect(201);
        const before = await obligations(income.commitment.id);
        expect(
            before.find(
                (row: { remaining_amount_in_cents: string }) =>
                    row.remaining_amount_in_cents === '5000',
            ),
        ).toMatchObject({ debtor_member_id: f.mb, creditor_member_id: f.ma });
        const receipts = await db.query(
            'SELECT * FROM financial_receipts ORDER BY id',
        );
        const preview = await options(f, 'TRANSFER', recorded.transfer.id);
        expect(preview.obligations).toHaveLength(2);
        expect(preview.impact).toEqual([
            expect.objectContaining({
                originCommitmentId: income.commitment.id,
                remainingAmountInCents: 0,
            }),
        ]);
        await f.b
            .post(
                reversePath(f, 'TRANSFER', recorded.transfer.id),
                await confirmation(f, preview),
            )
            .expect(201);
        expect(
            (await obligations(income.commitment.id)).every(
                (row: { remaining_amount_in_cents: string }) =>
                    row.remaining_amount_in_cents === '0',
            ),
        ).toBe(true);
        expect(
            await db.query('SELECT * FROM financial_receipts ORDER BY id'),
        ).toEqual(receipts);
        expect(
            (
                await f.a.agent
                    .get(`${financeBase(f.space)}/inter-member-position`)
                    .expect(200)
            ).body.items,
        ).toEqual([]);
    });

    it('corrects a transfer outside a finalized cycle without changing the frozen rows or its historical allocations', async () => {
        const f = await sharedFinance(app);
        const initial = await recordSharedObligation(
            f,
            10000,
            '2026-10-20',
            f.mb,
        );
        const recorded = await transfer(f, [
            { id: initial.obligation.id, amount: 10000 },
        ]);
        await finalize(f, initial.settlementCycle.id);
        const destination = await emptyCycle(f);
        const frozen = await frozenState([initial.settlementCycle.id]);
        const oldAllocations = await db.query(
            'SELECT * FROM settlement_allocations ORDER BY id',
        );
        const preview = await options(f, 'TRANSFER', recorded.transfer.id);
        expect(preview).toMatchObject({
            requiresCorrectionCycle: true,
            canReverse: false,
            reversalBlockReason: 'CORRECTION_CYCLE_REQUIRED',
        });
        await f.a
            .post(
                reversePath(f, 'TRANSFER', recorded.transfer.id),
                await confirmation(f, preview),
            )
            .expect(409);
        const result = (
            await f.b
                .post(
                    reversePath(f, 'TRANSFER', recorded.transfer.id),
                    await confirmation(f, preview, destination),
                )
                .expect(201)
        ).body;
        expect(result.applications).toEqual([
            expect.objectContaining({
                originalAllocationId: recorded.allocations[0].id,
                originalCycleId: initial.settlementCycle.id,
                correctionCycleId: destination,
                amountInCents: 10000,
                debtorMemberId: f.ma,
                creditorMemberId: f.mb,
            }),
        ]);
        const [correction] = await db.query(
            'SELECT * FROM inter_member_obligations WHERE cycle_id=$1',
            [destination],
        );
        expect(correction).toMatchObject({
            debtor_member_id: f.ma,
            creditor_member_id: f.mb,
            remaining_amount_in_cents: '10000',
        });
        expect(result.applications[0].effectObligationId).toBe(correction.id);
        const history = await options(f, 'TRANSFER', recorded.transfer.id);
        expect(history.previousReversals).toEqual([
            expect.objectContaining({
                id: result.reversal.id,
                createdByPersonId: f.b.context.person.id,
                applications: [
                    expect.objectContaining({
                        originalAllocationId: recorded.allocations[0].id,
                        originalCycleId: initial.settlementCycle.id,
                        correctionCycleId: destination,
                        effectObligationId: correction.id,
                    }),
                ],
            }),
        ]);
        expect(await frozenState([initial.settlementCycle.id])).toEqual(frozen);
        expect(
            await db.query('SELECT * FROM settlement_allocations ORDER BY id'),
        ).toEqual(oldAllocations);
    });

    it('atomically reverses offset applications across open and finalized cycles with the required direction per leg', async () => {
        const f = await sharedFinance(app);
        const a = await recordSharedObligation(f, 35000, '2026-10-20', f.mb);
        const b = await recordSharedObligation(f, 8000, '2026-10-21', f.ma);
        const recorded = await offset(
            f,
            a.obligation.id,
            b.obligation.id,
            8000,
        );
        await waive(f, a.obligation.id, 27000);
        await finalize(f, a.settlementCycle.id);
        const destination = await emptyCycle(f);
        const frozen = await frozenState([a.settlementCycle.id]);
        const waivers = await db.query('SELECT * FROM obligation_waivers');
        const preview = await options(f, 'OFFSET', recorded.offset.id);
        const beforeInvalid = await financeSnapshot(db);
        await f.b
            .post(
                reversePath(f, 'OFFSET', recorded.offset.id),
                await confirmation(f, preview, randomUUID()),
            )
            .expect(404);
        expect(await financeSnapshot(db)).toEqual(beforeInvalid);
        const result = (
            await f.b
                .post(
                    reversePath(f, 'OFFSET', recorded.offset.id),
                    await confirmation(f, preview, destination),
                )
                .expect(201)
        ).body;
        expect(result.reversal.amountInCents).toBe(8000);
        expect(
            (await obligations(b.commitment.id)).find(
                (row: { cycle_id: string }) =>
                    row.cycle_id === b.settlementCycle.id,
            ),
        ).toMatchObject({
            debtor_member_id: f.mb,
            creditor_member_id: f.ma,
            remaining_amount_in_cents: '8000',
        });
        expect(
            (
                await db.query(
                    'SELECT * FROM inter_member_obligations WHERE cycle_id=$1',
                    [destination],
                )
            )[0],
        ).toMatchObject({
            debtor_member_id: f.ma,
            creditor_member_id: f.mb,
            remaining_amount_in_cents: '8000',
        });
        expect(await frozenState([a.settlementCycle.id])).toEqual(frozen);
        expect(await db.query('SELECT * FROM obligation_waivers')).toEqual(
            waivers,
        );
        expect(await db.query('SELECT * FROM settlement_transfers')).toEqual(
            [],
        );
    });

    it('rejects missing, foreign, finalized or stale correction destinations without partially applying a mixed reversal', async () => {
        const f = await sharedFinance(app);
        const initial = await recordSharedObligation(
            f,
            1000,
            '2026-10-20',
            f.mb,
        );
        const recorded = await transfer(f, [
            { id: initial.obligation.id, amount: 1000 },
        ]);
        await finalize(f, initial.settlementCycle.id);
        const valid = await emptyCycle(f);
        const closed = await emptyCycle(f, '2026-11-11');
        await finalize(f, closed);
        const otherSpace = (
            await f.a.post('/v2/spaces', { name: 'Outro espaço' }).expect(201)
        ).body.space.id;
        const foreign = await emptyCycle(
            { ...f, space: otherSpace },
            '2026-11-12',
        );
        const preview = await options(f, 'TRANSFER', recorded.transfer.id);
        const before = await financeSnapshot(db);
        for (const [destination, status] of [
            [randomUUID(), 404],
            [foreign, 404],
            [closed, 409],
        ] as const)
            await f.a
                .post(
                    reversePath(f, 'TRANSFER', recorded.transfer.id),
                    await confirmation(f, preview, destination),
                )
                .expect(status);
        const stale = await confirmation(f, preview, valid);
        await f.a
            .post(reversePath(f, 'TRANSFER', recorded.transfer.id), {
                ...stale,
                expectedCycleVersions: stale.expectedCycleVersions.map((row) =>
                    row.cycleId === valid
                        ? { ...row, version: row.version + 1 }
                        : row,
                ),
            })
            .expect(409);
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('replays concurrent retries once and rechecks membership before returning original or reversal data', async () => {
        const f = await sharedFinance(app);
        const initial = await recordSharedObligation(f, 1000, null, f.mb);
        const recorded = await transfer(f, [
            { id: initial.obligation.id, amount: 500 },
        ]);
        const preview = await options(f, 'TRANSFER', recorded.transfer.id);
        const body = await confirmation(f, preview);
        const key = randomUUID();
        const responses = await competingFinanceCommands(db, f.space, () =>
            Promise.all([
                f.a.post(
                    reversePath(f, 'TRANSFER', recorded.transfer.id),
                    body,
                    key,
                ),
                f.a.post(
                    reversePath(f, 'TRANSFER', recorded.transfer.id),
                    body,
                    key,
                ),
            ]),
        );
        expect(responses.map((response) => response.status).sort()).toEqual([
            200, 201,
        ]);
        const created = responses.find(
            (response) => response.status === 201,
        )!.body;
        const before = await financeSnapshot(db);
        await f.a
            .post(
                reversePath(f, 'TRANSFER', recorded.transfer.id),
                { ...body, factDate: '2026-10-13' },
                key,
            )
            .expect(409);
        expect(await financeSnapshot(db)).toEqual(before);
        const outsider = await financeBrowser(app, 'Terceiro');
        await outsider.agent
            .get(
                `${originalPath(f, 'TRANSFER', recorded.transfer.id)}/reversal-options`,
            )
            .expect(404);
        await outsider
            .post(reversePath(f, 'TRANSFER', recorded.transfer.id), body)
            .expect(404);
        await request(app.getHttpServer())
            .get(
                `${originalPath(f, 'TRANSFER', recorded.transfer.id)}/reversal-options`,
            )
            .expect(401);
        await f.a.agent
            .post(reversePath(f, 'TRANSFER', recorded.transfer.id))
            .set('Origin', 'http://localhost:3000')
            .set('Idempotency-Key', randomUUID())
            .send(body)
            .expect(403);
        await db.query("UPDATE spaces SET status='CLOSED' WHERE id=$1", [
            f.space,
        ]);
        expect(
            (
                await f.a
                    .post(
                        reversePath(f, 'TRANSFER', recorded.transfer.id),
                        body,
                        key,
                    )
                    .expect(200)
            ).body,
        ).toEqual({ ...created, replayed: true });
        await db.query('UPDATE space_members SET person_id=$2 WHERE id=$1', [
            f.ma,
            outsider.context.person.id,
        ]);
        await f.a
            .post(reversePath(f, 'TRANSFER', recorded.transfer.id), body, key)
            .expect(404);
    });

    it('serializes reversal against a later creditor waiver and preserves whichever command commits', async () => {
        const f = await sharedFinance(app);
        const initial = await recordSharedObligation(f, 1000, null, f.mb);
        const recorded = await transfer(f, [
            { id: initial.obligation.id, amount: 500 },
        ]);
        const body = await confirmation(
            f,
            await options(f, 'TRANSFER', recorded.transfer.id),
        );
        const responses = await competingFinanceCommands(db, f.space, () =>
            Promise.all([
                f.a.post(
                    reversePath(f, 'TRANSFER', recorded.transfer.id),
                    body,
                ),
                f.b.post(
                    `${obligationPath(f.space, initial.obligation.id)}/waivers`,
                    {
                        expectedSpaceVersion: f.context.version,
                        expectedObligationVersion: 2,
                        factDate: '2026-10-14',
                        amountInCents: 500,
                    },
                ),
            ]),
        );
        expect(responses.map((response) => response.status).sort()).toEqual([
            201, 409,
        ]);
        const [current] = await obligations(initial.commitment.id);
        expect(current.remaining_amount_in_cents).toBe(
            responses[0].status === 201 ? '1000' : '0',
        );
        expect(current.version).toBe(3);
    });

    it('serializes reversal against finalization without reopening a cycle finalized by the competitor', async () => {
        const f = await sharedFinance(app);
        const initial = await recordSharedObligation(
            f,
            1000,
            '2026-10-20',
            f.mb,
        );
        const recorded = await transfer(f, [
            { id: initial.obligation.id, amount: 1000 },
        ]);
        const body = await confirmation(
            f,
            await options(f, 'TRANSFER', recorded.transfer.id),
        );
        const responses = await competingFinanceCommands(db, f.space, () =>
            Promise.all([
                f.a.post(
                    reversePath(f, 'TRANSFER', recorded.transfer.id),
                    body,
                ),
                f.b.post(
                    `${financeBase(f.space)}/settlement-cycles/${initial.settlementCycle.id}/finalize`,
                    {
                        expectedSpaceVersion: f.context.version,
                        expectedCycleVersion: 1,
                    },
                ),
            ]),
        );
        expect(
            responses.filter((response) => response.status === 409),
        ).toHaveLength(1);
        const [cycle] = await db.query(
            'SELECT status FROM settlement_cycles WHERE id=$1',
            [initial.settlementCycle.id],
        );
        const [current] = await obligations(initial.commitment.id);
        if (responses[0].status === 201) {
            expect(cycle.status).toBe('OPEN');
            expect(current.remaining_amount_in_cents).toBe('1000');
        } else {
            expect(responses[1].status).toBe(200);
            expect(cycle.status).toBe('FINALIZED');
            expect(current.remaining_amount_in_cents).toBe('0');
            expect(
                await db.query('SELECT * FROM settlement_reversals'),
            ).toEqual([]);
        }
    });

    it('keeps a later realization correct whether it commits before or after reversal', async () => {
        const f = await sharedFinance(app);
        const initial = await recordSharedObligation(
            f,
            1000,
            '2026-10-20',
            f.mb,
            2000,
        );
        const recorded = await transfer(f, [
            { id: initial.obligation.id, amount: 500 },
        ]);
        const body = await confirmation(
            f,
            await options(f, 'TRANSFER', recorded.transfer.id),
        );
        const responses = await competingFinanceCommands(db, f.space, () =>
            Promise.all([
                f.a.post(
                    reversePath(f, 'TRANSFER', recorded.transfer.id),
                    body,
                ),
                f.b.post(
                    `${commitmentPath(f.space, initial.commitment.id)}/disbursements`,
                    {
                        expectedSpaceVersion: f.context.version,
                        expectedCommitmentVersion: initial.commitment.version,
                        amountInCents: 500,
                        factDate: '2026-10-14',
                        payerMemberId: f.mb,
                        method: 'PIX',
                        settlement: { mode: 'NONE' },
                    },
                ),
            ]),
        );
        expect(responses[1].status).toBe(201);
        expect([201, 409]).toContain(responses[0].status);
        if (responses[0].status === 409)
            await f.a
                .post(
                    reversePath(f, 'TRANSFER', recorded.transfer.id),
                    await confirmation(
                        f,
                        await options(f, 'TRANSFER', recorded.transfer.id),
                    ),
                )
                .expect(201);
        expect(
            (await obligations(initial.commitment.id)).reduce(
                (sum: bigint, row: { remaining_amount_in_cents: string }) =>
                    sum + BigInt(row.remaining_amount_in_cents),
                0n,
            ),
        ).toBe(1500n);
        expect(
            await db.query('SELECT * FROM financial_disbursements'),
        ).toHaveLength(2);
        expect(
            await db.query('SELECT * FROM settlement_reversals'),
        ).toHaveLength(1);
    });

    it('rolls back a reversal and all restored or corrective obligations if audit persistence fails', async () => {
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        const f = await sharedFinance(app);
        const initial = await recordSharedObligation(
            f,
            1000,
            '2026-10-20',
            f.mb,
        );
        const recorded = await transfer(f, [
            { id: initial.obligation.id, amount: 1000 },
        ]);
        await finalize(f, initial.settlementCycle.id);
        const destination = await emptyCycle(f);
        const body = await confirmation(
            f,
            await options(f, 'TRANSFER', recorded.transfer.id),
            destination,
        );
        const key = randomUUID();
        const before = await financeSnapshot(db);
        await db.query(
            "CREATE FUNCTION reject_settlement_reversals_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'settlement-reversals forced audit failure'; END $$",
        );
        await db.query(
            'CREATE TRIGGER reject_settlement_reversals_audit BEFORE INSERT ON financial_settlement_adjustment_audit FOR EACH ROW EXECUTE FUNCTION reject_settlement_reversals_audit()',
        );
        try {
            await f.a
                .post(
                    reversePath(f, 'TRANSFER', recorded.transfer.id),
                    body,
                    key,
                )
                .expect(500);
            expect(await financeSnapshot(db)).toEqual(before);
        } finally {
            await db.query(
                'DROP TRIGGER reject_settlement_reversals_audit ON financial_settlement_adjustment_audit',
            );
            await db.query('DROP FUNCTION reject_settlement_reversals_audit()');
        }
        await f.a
            .post(reversePath(f, 'TRANSFER', recorded.transfer.id), body, key)
            .expect(201);
        expect(
            await db.query('SELECT * FROM settlement_reversals'),
        ).toHaveLength(1);
    });

    it('rejects invalid or incomplete reversal applications and stale origin versions in Portuguese', async () => {
        const f = await sharedFinance(app);
        const a = await recordSharedObligation(f, 1000, null, f.mb);
        const b = await recordSharedObligation(f, 1000, null, f.mb);
        const recorded = await transfer(f, [
            { id: a.obligation.id, amount: 100 },
            { id: b.obligation.id, amount: 100 },
        ]);
        const body = await confirmation(
            f,
            await options(f, 'TRANSFER', recorded.transfer.id),
        );
        const before = await financeSnapshot(db);
        for (const invalid of [
            { applications: [] },
            { applications: body.applications.slice(0, 1) },
            {
                applications: body.applications.map((item) => ({
                    ...item,
                    amountInCents: item.amountInCents - 1,
                })),
            },
            {
                applications: body.applications.map((item) => ({
                    ...item,
                    amountInCents: 0,
                })),
            },
            { unknown: true },
            { factDate: '2026-10-15' },
        ]) {
            const response = await f.a
                .post(reversePath(f, 'TRANSFER', recorded.transfer.id), {
                    ...body,
                    ...invalid,
                })
                .expect(400);
            expect(response.body.code).toBe('VALIDATION_ERROR');
            expect(response.body.message).not.toMatch(
                /Invalid|Expected|must be/,
            );
        }
        await f.a
            .post(reversePath(f, 'TRANSFER', recorded.transfer.id), {
                ...body,
                expectedObligationVersions: body.expectedObligationVersions.map(
                    (row) => ({ ...row, version: row.version + 1 }),
                ),
            })
            .expect(409);
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('preserves exact gross history beyond safe integer after transfer, reversal and repayment', async () => {
        const f = await sharedFinance(app);
        const amount = Number.MAX_SAFE_INTEGER;
        const initial = await recordSharedObligation(
            f,
            amount,
            '2026-10-20',
            f.mb,
        );
        const original = await transfer(f, [
            { id: initial.obligation.id, amount },
        ]);
        await f.a
            .post(
                reversePath(f, 'TRANSFER', original.transfer.id),
                await confirmation(
                    f,
                    await options(f, 'TRANSFER', original.transfer.id),
                ),
            )
            .expect(201);
        const current = (await obligations(initial.commitment.id)).find(
            (row: { remaining_amount_in_cents: string }) =>
                row.remaining_amount_in_cents !== '0',
        );
        expect(current.id).toBe(initial.obligation.id);
        await transfer(f, [{ id: current.id, amount }]);
        const gross = (BigInt(amount) * 2n).toString();
        const detail = (
            await f.a.agent
                .get(commitmentPath(f.space, initial.commitment.id))
                .expect(200)
        ).body;
        expect(detail.obligation).toMatchObject({
            transferredAmountInCents: gross,
            reversedTransferredAmountInCents: String(amount),
            effectiveTransferredAmountInCents: String(amount),
            remainingAmountInCents: 0,
        });
        const cycle = (
            await f.a.agent
                .get(
                    `${financeBase(f.space)}/settlement-cycles/${initial.settlementCycle.id}`,
                )
                .expect(200)
        ).body.cycle;
        expect(cycle.totals).toMatchObject({
            originalAmountInCents: String(amount),
            recognizedAmountInCents: String(amount),
            transferredAmountInCents: gross,
            reversedTransferredAmountInCents: String(amount),
            effectiveTransferredAmountInCents: String(amount),
            remainingAmountInCents: '0',
        });
        const overview = (
            await f.a.agent
                .get(`${financeBase(f.space)}/financial-overview`)
                .query({ month: '2026-10' })
                .expect(200)
        ).body;
        expect(overview.totals).toMatchObject({
            internalTransfersSentAmountInCents: gross,
            internalTransfersReceivedAmountInCents: gross,
            internalTransfersSentReversedAmountInCents: String(amount),
            internalTransfersReceivedReversedAmountInCents: String(amount),
            internalTransfersSentEffectiveAmountInCents: String(amount),
            internalTransfersReceivedEffectiveAmountInCents: String(amount),
        });
        const history = (
            await f.a.agent
                .get(`${financeBase(f.space)}/financial-timeline`)
                .query({ month: '2026-10', view: 'HISTORY' })
                .expect(200)
        ).body;
        expect(
            history.items.filter(
                (item: { type: string }) => item.type === 'INTERNAL_REVERSAL',
            ),
        ).toEqual([expect.objectContaining({ amountInCents: amount })]);
    });

    it('completes the business journey through explicit correction after finalization without double-counting economics', async () => {
        const f = await sharedFinance(app);
        const a = await recordSharedObligation(f, 35000, '2026-10-20', f.mb);
        const b = await recordSharedObligation(f, 8000, '2026-10-21', f.ma);
        const initialOverview = (
            await f.a.agent
                .get(`${financeBase(f.space)}/financial-overview`)
                .query({ month: '2026-10' })
                .expect(200)
        ).body;
        await f.a
            .put(
                `${commitmentPath(f.space, a.commitment.id)}/settlement-rule`,
                {
                    rule: { kind: 'MONTHLY_DAY', dayOfMonth: 31 },
                    expectedSpaceVersion: f.context.version,
                    expectedCommitmentVersion: a.commitment.version,
                },
            )
            .expect(200);
        const moved = (
            await f.a
                .post(
                    `${obligationPath(f.space, a.obligation.id)}/settlement-assignment`,
                    {
                        expectedSpaceVersion: f.context.version,
                        expectedObligationVersion: 1,
                        expectedCycleVersions: [
                            { cycleId: a.settlementCycle.id, version: 1 },
                        ],
                        settlement: { mode: 'DATE', targetDate: '2026-10-22' },
                    },
                )
                .expect(200)
        ).body;
        const cycles = [moved.settlementCycle.id, b.settlementCycle.id];
        instant = new Date('2026-10-23T15:00:00Z');
        const overdue = (
            await f.a.agent
                .get(`${financeBase(f.space)}/settlement-cycles`)
                .query({ view: 'OVERDUE' })
                .expect(200)
        ).body;
        expect(
            overdue.items.map((row: { id: string }) => row.id).sort(),
        ).toEqual([...cycles].sort());
        const selected = (
            await f.a.agent
                .get(`${financeBase(f.space)}/settlement-cycles/summary`)
                .query({ cycleIds: cycles.join(',') })
                .expect(200)
        ).body;
        expect(selected.totals.remainingAmountInCents).toBe('43000');
        await offset(f, a.obligation.id, b.obligation.id, 8000);
        const recorded = await transfer(f, [
            { id: a.obligation.id, amount: 5000 },
        ]);
        await waive(f, a.obligation.id, 22000);
        for (const id of cycles) await finalize(f, id);
        const historical = (
            await f.a.agent
                .get(`${financeBase(f.space)}/settlement-cycles`)
                .query({ view: 'FINALIZED' })
                .expect(200)
        ).body;
        expect(
            historical.items.map((row: { id: string }) => row.id).sort(),
        ).toEqual([...cycles].sort());
        const frozen = await frozenState(cycles);
        const destination = await emptyCycle(f);
        const preview = await options(f, 'TRANSFER', recorded.transfer.id);
        const corrected = (
            await f.b
                .post(
                    reversePath(f, 'TRANSFER', recorded.transfer.id),
                    await confirmation(f, preview, destination),
                )
                .expect(201)
        ).body;
        expect(corrected.applications[0]).toMatchObject({
            originalCycleId: moved.settlementCycle.id,
            correctionCycleId: destination,
            debtorMemberId: f.ma,
            creditorMemberId: f.mb,
            amountInCents: 5000,
        });
        expect(await frozenState(cycles)).toEqual(frozen);
        expect(
            (
                await db.query(
                    'SELECT remaining_amount_in_cents::text AS amount FROM inter_member_obligations WHERE cycle_id=$1',
                    [destination],
                )
            )[0].amount,
        ).toBe('5000');
        const finalOverview = (
            await f.a.agent
                .get(`${financeBase(f.space)}/financial-overview`)
                .query({ month: '2026-10' })
                .expect(200)
        ).body;
        for (const key of [
            'expenseAmountInCents',
            'realizedIncomeAmountInCents',
            'economicResultInCents',
            'paidAmountInCents',
            'receivedAmountInCents',
            'assumedAmountInCents',
            'supportedAmountInCents',
        ])
            expect(finalOverview.totals[key]).toBe(initialOverview.totals[key]);
        expect(
            await db.query('SELECT * FROM financial_disbursements'),
        ).toHaveLength(2);
        expect(
            await db.query('SELECT * FROM settlement_transfers'),
        ).toHaveLength(1);
        expect(await db.query('SELECT * FROM settlement_offsets')).toHaveLength(
            1,
        );
        expect(await db.query('SELECT * FROM obligation_waivers')).toHaveLength(
            1,
        );
        expect(
            await db.query('SELECT * FROM settlement_reversals'),
        ).toHaveLength(1);
    });
    it('rejects zero settlement reversal applications in PostgreSQL without changing financial history', async () => {
        const f = await sharedFinance(app);
        const initial = await recordSharedObligation(f, 1000, null, f.mb);
        const original = await transfer(f, [
            { id: initial.obligation.id, amount: 500 },
        ]);
        await f.a
            .post(
                reversePath(f, 'TRANSFER', original.transfer.id),
                await confirmation(
                    f,
                    await options(f, 'TRANSFER', original.transfer.id),
                ),
            )
            .expect(201);
        const before = await financeSnapshot(db);
        await expect(
            db.query(
                'UPDATE settlement_reversal_applications SET amount_in_cents=0',
            ),
        ).rejects.toMatchObject({ driverError: { code: '23514' } });
        expect(await financeSnapshot(db)).toEqual(before);
    });
});
