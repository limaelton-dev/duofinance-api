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
import { TODAY_CLOCK } from '../dist/composition/today/today.clock.js';
import migrationSource from '../dist/shared/technical/database/typeorm/data-source.js';
import { FINANCES_CLOCK } from '../dist/modules/finances/application/ports/private/shared-expense.repositories.js';
import { EntityManagerProvider } from '../dist/shared/technical/database/typeorm/entity-manager.provider.js';
import {
    commitmentPath,
    financeBase,
    financeBrowser,
    financeSnapshot,
    recordSharedObligation,
    sharedFinance,
    type SharedFinance,
} from './settlement-fixture.js';

type Scope = { cycleIds: string[]; obligationIds: string[] };

describe('CARD-020 explicit settlement offsets HTTP/PostgreSQL', () => {
    let app: INestApplication<Server>, db: DataSource;
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
            .useValue({
                now: () => new Date('2026-10-14T15:00:00Z'),
                today: () => '2026-10-14',
            })
            .overrideProvider(TODAY_CLOCK)
            .useValue({ now: () => new Date('2026-10-14T15:00:00Z') })
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
    const path = (f: SharedFinance) =>
        `${financeBase(f.space)}/settlement-offsets`;
    const record = (
        f: SharedFinance,
        amount: number,
        date: string | null = null,
        payer = f.mb,
        total = amount,
    ) => recordSharedObligation(f, amount, date, payer, total);
    const options = async (
        f: SharedFinance,
        scope: Scope,
        extra: object = {},
    ) =>
        (
            await f.a.agent
                .get(`${path(f)}/options`)
                .query({
                    ...(scope.cycleIds.length
                        ? { cycleIds: scope.cycleIds.join(',') }
                        : {}),
                    ...(scope.obligationIds.length
                        ? { obligationIds: scope.obligationIds.join(',') }
                        : {}),
                    ...extra,
                })
                .expect(200)
        ).body;
    const obligations = () =>
        db.query('SELECT * FROM inter_member_obligations ORDER BY id');
    async function command(
        f: SharedFinance,
        scope: Scope,
        entries: { id: string; amount: number }[],
    ) {
        const rows: { id: string; version: number }[] = await db.query(
            'SELECT id,version FROM inter_member_obligations WHERE space_id=$1 AND id=ANY($2::uuid[])',
            [f.space, entries.map((item) => item.id)],
        );
        const cycles: { id: string; version: number }[] = await db.query(
            'SELECT id,version FROM settlement_cycles WHERE space_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',
            [f.space, scope.cycleIds],
        );
        return {
            scope,
            expectedSpaceVersion: f.context.version,
            factDate: '2026-10-14',
            expectedCycleVersions: cycles.map((item) => ({
                cycleId: item.id,
                version: item.version,
            })),
            allocations: entries.map((item) => ({
                obligationId: item.id,
                expectedObligationVersion: rows.find(
                    (row) => row.id === item.id,
                )!.version,
                amountInCents: item.amount,
            })),
        };
    }
    async function pair(
        f: SharedFinance,
        payable = 35000,
        receivable = 8000,
        dated = true,
    ) {
        const a = await record(f, payable, dated ? '2026-10-20' : null);
        const b = await record(
            f,
            receivable,
            dated ? '2026-10-21' : null,
            f.ma,
        );
        const scope: Scope = dated
            ? {
                  cycleIds: [a.settlementCycle.id, b.settlementCycle.id],
                  obligationIds: [],
              }
            : {
                  cycleIds: [],
                  obligationIds: [a.obligation.id, b.obligation.id],
              };
        return { a, b, scope };
    }

    it('explicitly offsets 8000 in each direction of 35000/8000 and preserves cash and economic facts', async () => {
        const f = await sharedFinance(app);
        const p = await pair(f);
        const before = await financeSnapshot(db);
        const overviewPath = `${financeBase(f.space)}/financial-overview`;
        const economicOverview = (
            await f.a.agent
                .get(overviewPath)
                .query({ month: '2026-10' })
                .expect(200)
        ).body;
        const preview = await options(f, p.scope);
        expect(preview.maximumAmountInCents).toBe('8000');
        expect(preview.preview).toMatchObject({
            amountInCents: '8000',
            complete: true,
        });
        expect(await financeSnapshot(db)).toEqual(before);
        const body = await command(f, p.scope, [
            { id: p.a.obligation.id, amount: 8000 },
            { id: p.b.obligation.id, amount: 8000 },
        ]);
        const result = (await f.a.post(path(f), body).expect(201)).body;
        expect(result.offset).toMatchObject({
            amountInCents: 8000,
            factDate: '2026-10-14',
            createdByPersonId: f.a.context.person.id,
        });
        expect(result.allocations).toHaveLength(2);
        expect(result.affectedCycleIds.sort()).toEqual(
            [...p.scope.cycleIds].sort(),
        );
        const current = await obligations();
        expect(
            current.find((o: { id: string }) => o.id === p.a.obligation.id),
        ).toMatchObject({
            remaining_amount_in_cents: '27000',
            status: 'PARTIALLY_SETTLED',
            version: 2,
        });
        expect(
            current.find((o: { id: string }) => o.id === p.b.obligation.id),
        ).toMatchObject({ remaining_amount_in_cents: '0', version: 2 });
        const after = await financeSnapshot(db);
        for (const table of [
            'financial_commitments',
            'financial_commitment_versions',
            'financial_commitment_shares',
            'financial_disbursements',
            'financial_receipts',
            'financial_external_liabilities',
            'settlement_transfers',
            'settlement_allocations',
        ])
            expect(after[table]).toEqual(before[table]);
        const position = (
            await f.a.agent
                .get(`${financeBase(f.space)}/inter-member-position`)
                .expect(200)
        ).body;
        expect(position.summary).toEqual({
            payableAmountInCents: '27000',
            receivableAmountInCents: '0',
            net: { direction: 'PAYABLE', amountInCents: '27000' },
        });
        const selected = (
            await f.a.agent
                .get(`${financeBase(f.space)}/settlement-cycles/summary`)
                .query({ cycleIds: p.scope.cycleIds.join(',') })
                .expect(200)
        ).body;
        expect(selected.totals).toMatchObject({
            resolvedAmountInCents: '16000',
            compensatedAmountInCents: '16000',
            remainingAmountInCents: '27000',
            transferredAmountInCents: '0',
        });
        const originDetail = (
            await f.a.agent
                .get(commitmentPath(f.space, p.a.commitment.id))
                .expect(200)
        ).body;
        expect(originDetail.obligation).toMatchObject({
            transferredAmountInCents: 0,
            compensatedAmountInCents: 8000,
            remainingAmountInCents: 27000,
        });
        expect(
            (
                await f.a.agent
                    .get(overviewPath)
                    .query({ month: '2026-10' })
                    .expect(200)
            ).body,
        ).toEqual(economicOverview);
        const timeline = (
            await f.a.agent
                .get(`${financeBase(f.space)}/financial-timeline`)
                .query({ month: '2026-10', view: 'HISTORY' })
                .expect(200)
        ).body;
        expect(
            timeline.items.filter(
                (item: { type: string }) => item.type === 'INTERNAL_OFFSET',
            ),
        ).toEqual([
            expect.objectContaining({
                id: result.offset.id,
                amountInCents: 8000,
            }),
        ]);
        const today = (
            await f.a.agent.get(`${financeBase(f.space)}/today`).expect(200)
        ).body;
        expect(today.finance.data.settlements.nextCycle.totals).toMatchObject({
            compensatedAmountInCents: '8000',
            transferredAmountInCents: '0',
            remainingAmountInCents: '27000',
        });
        const detail = (
            await f.b.agent.get(`${path(f)}/${result.offset.id}`).expect(200)
        ).body;
        expect(detail.offset).toEqual(result.offset);
        expect(
            detail.allocations
                .map(
                    (item: { origin: { commitmentId: string } }) =>
                        item.origin.commitmentId,
                )
                .sort(),
        ).toEqual([p.a.commitment.id, p.b.commitment.id].sort());
        expect(
            (
                await f.a.agent
                    .get(`${path(f)}`)
                    .query({ cycleId: p.scope.cycleIds[0] })
                    .expect(200)
            ).body.items[0],
        ).toMatchObject({
            offset: { amountInCents: 8000 },
            appliedAmountInCentsInFilter: '8000',
        });
    });

    it('honors multiple origins, cycles and explicitly included undated obligations without touching excluded debt', async () => {
        const f = await sharedFinance(app);
        const first = await record(f, 10000, '2026-10-20');
        const loose = await record(f, 5000);
        const reverse = await record(f, 20000, '2026-10-21', f.ma);
        const outside = await record(f, 100000, '2026-10-22');
        const scope: Scope = {
            cycleIds: [first.settlementCycle.id, reverse.settlementCycle.id],
            obligationIds: [loose.obligation.id],
        };
        const beforeOutside = (await obligations()).find(
            (row: { id: string }) => row.id === outside.obligation.id,
        );
        const result = (
            await f.b
                .post(
                    path(f),
                    await command(f, scope, [
                        { id: first.obligation.id, amount: 10000 },
                        { id: loose.obligation.id, amount: 2000 },
                        { id: reverse.obligation.id, amount: 12000 },
                    ]),
                )
                .expect(201)
        ).body;
        expect(result.offset.amountInCents).toBe(12000);
        const rows = await obligations();
        expect(
            rows.find((o: { id: string }) => o.id === first.obligation.id)
                .remaining_amount_in_cents,
        ).toBe('0');
        expect(
            rows.find((o: { id: string }) => o.id === loose.obligation.id)
                .remaining_amount_in_cents,
        ).toBe('3000');
        expect(
            rows.find((o: { id: string }) => o.id === reverse.obligation.id)
                .remaining_amount_in_cents,
        ).toBe('8000');
        expect(
            rows.find((o: { id: string }) => o.id === outside.obligation.id),
        ).toEqual(beforeOutside);
        expect(
            result.allocations.find(
                (a: { obligationId: string }) =>
                    a.obligationId === loose.obligation.id,
            ).cycleId,
        ).toBeNull();
        const historical = await db.query(
            'SELECT * FROM settlement_offset_allocations ORDER BY id',
        );
        await f.a
            .post(
                `${financeBase(f.space)}/inter-member-obligations/${loose.obligation.id}/settlement-assignment`,
                {
                    expectedSpaceVersion: f.context.version,
                    expectedObligationVersion: 2,
                    expectedCycleVersions: [],
                    settlement: { mode: 'DATE', targetDate: '2026-11-10' },
                },
            )
            .expect(200);
        expect(
            await db.query(
                'SELECT * FROM settlement_offset_allocations ORDER BY id',
            ),
        ).toEqual(historical);
        const secondScope: Scope = {
            cycleIds: [],
            obligationIds: [loose.obligation.id, reverse.obligation.id],
        };
        const afterMove = await options(f, secondScope);
        expect(afterMove.maximumAmountInCents).toBe('3000');
    });

    it('requires reciprocity, explicit scope, positive equivalent applications and current versions', async () => {
        const f = await sharedFinance(app);
        const one = await record(f, 10000);
        const unilateral: Scope = {
            cycleIds: [],
            obligationIds: [one.obligation.id],
        };
        const preview = await options(f, unilateral);
        expect(preview.maximumAmountInCents).toBe('0');
        expect(preview.reason).toEqual(expect.any(String));
        const reverse = await record(f, 10000, null, f.ma);
        const scope: Scope = {
            cycleIds: [],
            obligationIds: [one.obligation.id, reverse.obligation.id],
        };
        const valid = await command(f, scope, [
            { id: one.obligation.id, amount: 1000 },
            { id: reverse.obligation.id, amount: 1000 },
        ]);
        const before = await financeSnapshot(db);
        const invalid = [
            {
                ...valid,
                allocations: valid.allocations.map((a) => ({
                    ...a,
                    amountInCents: 0,
                })),
            },
            {
                ...valid,
                allocations: valid.allocations.map((a, i) => ({
                    ...a,
                    amountInCents: i ? 2000 : 1000,
                })),
            },
            {
                ...valid,
                allocations: [valid.allocations[0], valid.allocations[0]],
            },
            { ...valid, scope: unilateral },
        ];
        for (const body of invalid) {
            const response = await f.a.post(path(f), body).expect(400);
            expect(response.body.code).toBe('VALIDATION_ERROR');
            expect(response.body.message).not.toMatch(
                /Invalid|Expected|must be|Too (small|big)/,
            );
        }
        await f.a
            .post(path(f), {
                ...valid,
                allocations: valid.allocations.map((a) => ({
                    ...a,
                    amountInCents: 10001,
                })),
            })
            .expect(409);
        await f.a
            .post(path(f), {
                ...valid,
                allocations: valid.allocations.map((a) => ({
                    ...a,
                    expectedObligationVersion: a.expectedObligationVersion + 1,
                })),
            })
            .expect(409);
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('replays once, rejects key reuse and rechecks membership before replay or historic reads', async () => {
        const f = await sharedFinance(app);
        const p = await pair(f);
        const body = await command(f, p.scope, [
            { id: p.a.obligation.id, amount: 8000 },
            { id: p.b.obligation.id, amount: 8000 },
        ]);
        const key = randomUUID();
        const duplicates = await concurrent(f.space, () =>
            Promise.all([
                f.a.post(path(f), body, key),
                f.a.post(path(f), body, key),
            ]),
        );
        expect(duplicates.map((response) => response.status).sort()).toEqual([
            200, 201,
        ]);
        const created = duplicates.find(
            (response) => response.status === 201,
        )!.body;
        const before = await financeSnapshot(db);
        expect((await f.a.post(path(f), body, key).expect(200)).body).toEqual({
            ...created,
            replayed: true,
        });
        await f.a
            .post(
                path(f),
                {
                    ...body,
                    allocations: body.allocations.map((a) => ({
                        ...a,
                        amountInCents: 1000,
                    })),
                },
                key,
            )
            .expect(409);
        expect(await financeSnapshot(db)).toEqual(before);
        expect(
            await db.query(
                'SELECT * FROM settlement_offset_audit WHERE idempotency_key=$1',
                [key],
            ),
        ).toHaveLength(1);
        const outsider = await financeBrowser(app, 'Terceiro');
        await request(app.getHttpServer())
            .get(`${path(f)}/${created.offset.id}`)
            .expect(401);
        await outsider.agent.get(`${path(f)}/${created.offset.id}`).expect(404);
        await outsider.post(path(f), body).expect(404);
        await f.a.agent
            .post(path(f))
            .set('Origin', 'http://localhost:3000')
            .set('Idempotency-Key', randomUUID())
            .send(body)
            .expect(403);
        await db.query('UPDATE space_members SET person_id=$2 WHERE id=$1', [
            f.ma,
            outsider.context.person.id,
        ]);
        await f.a.post(path(f), body, key).expect(404);
        await f.a.agent.get(`${path(f)}/${created.offset.id}`).expect(404);
        await db.query("UPDATE spaces SET status='CLOSED' WHERE id=$1", [
            f.space,
        ]);
        await f.b.agent.get(`${path(f)}/${created.offset.id}`).expect(200);
        await f.b.post(path(f), body).expect(409);
    });

    it('serializes an offset against a manual transfer and preserves the successful resolution', async () => {
        const f = await sharedFinance(app);
        const p = await pair(f);
        const body = await command(f, p.scope, [
            { id: p.a.obligation.id, amount: 8000 },
            { id: p.b.obligation.id, amount: 8000 },
        ]);
        const responses = await concurrent(f.space, () =>
            Promise.all([
                f.a.post(path(f), body),
                f.b.post(`${financeBase(f.space)}/settlement-transfers`, {
                    expectedSpaceVersion: f.context.version,
                    payerMemberId: f.ma,
                    recipientMemberId: f.mb,
                    amountInCents: 1000,
                    factDate: '2026-10-14',
                    allocations: [
                        {
                            obligationId: p.a.obligation.id,
                            expectedObligationVersion: 1,
                            amountInCents: 1000,
                        },
                    ],
                }),
            ]),
        );
        expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
        const rows = await obligations();
        if (responses[0].status === 201) {
            expect(
                rows.find((o: { id: string }) => o.id === p.a.obligation.id)
                    .remaining_amount_in_cents,
            ).toBe('27000');
            expect(
                rows.find((o: { id: string }) => o.id === p.b.obligation.id)
                    .remaining_amount_in_cents,
            ).toBe('0');
            expect(
                await db.query('SELECT * FROM settlement_transfers'),
            ).toEqual([]);
        } else {
            expect(
                rows.find((o: { id: string }) => o.id === p.a.obligation.id)
                    .remaining_amount_in_cents,
            ).toBe('34000');
            expect(
                rows.find((o: { id: string }) => o.id === p.b.obligation.id)
                    .remaining_amount_in_cents,
            ).toBe('8000');
            expect(await db.query('SELECT * FROM settlement_offsets')).toEqual(
                [],
            );
        }
    });

    it('rolls back offsets, allocations, history and receipt when audit insertion fails', async () => {
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        const f = await sharedFinance(app);
        const p = await pair(f);
        const body = await command(f, p.scope, [
            { id: p.a.obligation.id, amount: 8000 },
            { id: p.b.obligation.id, amount: 8000 },
        ]);
        const key = randomUUID();
        const before = await financeSnapshot(db);
        await db.query(
            "CREATE FUNCTION reject_card020_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'CARD-020 forced audit failure'; END $$",
        );
        await db.query(
            'CREATE TRIGGER reject_card020_audit BEFORE INSERT ON settlement_offset_audit FOR EACH ROW EXECUTE FUNCTION reject_card020_audit()',
        );
        try {
            await f.a.post(path(f), body, key).expect(500);
            expect(await financeSnapshot(db)).toEqual(before);
        } finally {
            await db.query(
                'DROP TRIGGER reject_card020_audit ON settlement_offset_audit',
            );
            await db.query('DROP FUNCTION reject_card020_audit()');
        }
        await f.a.post(path(f), body, key).expect(201);
        expect(
            await db.query(
                'SELECT * FROM settlement_offset_command_receipts WHERE idempotency_key=$1',
                [key],
            ),
        ).toHaveLength(1);
    });

    it('keeps the offset effective when a later disbursement increases the same origin', async () => {
        const f = await sharedFinance(app);
        const first = await record(f, 35000, '2026-10-20', f.mb, 50000);
        const reverse = await record(f, 8000, '2026-10-21', f.ma);
        const scope: Scope = {
            cycleIds: [first.settlementCycle.id, reverse.settlementCycle.id],
            obligationIds: [],
        };
        await f.a
            .post(
                path(f),
                await command(f, scope, [
                    { id: first.obligation.id, amount: 8000 },
                    { id: reverse.obligation.id, amount: 8000 },
                ]),
            )
            .expect(201);
        const allocations = await db.query(
            'SELECT * FROM settlement_offset_allocations ORDER BY id',
        );
        const realized = (
            await f.a
                .post(
                    `${commitmentPath(f.space, first.commitment.id)}/disbursements`,
                    {
                        expectedCommitmentVersion: first.commitment.version,
                        expectedSpaceVersion: f.context.version,
                        amountInCents: 15000,
                        factDate: '2026-10-14',
                        payerMemberId: f.mb,
                        method: 'PIX',
                        settlement: { mode: 'NONE' },
                    },
                )
                .expect(201)
        ).body;
        expect(realized.obligation.id).toBe(first.obligation.id);
        expect(realized.obligation.remainingAmountInCents).toBe(42000);
        expect(realized.obligation.cycleId).toBe(first.settlementCycle.id);
        expect(
            await db.query(
                'SELECT * FROM settlement_offset_allocations ORDER BY id',
            ),
        ).toEqual(allocations);
        expect(
            (await obligations()).find(
                (o: { id: string }) => o.id === reverse.obligation.id,
            ).remaining_amount_in_cents,
        ).toBe('0');
        expect(await db.query('SELECT * FROM settlement_transfers')).toEqual(
            [],
        );
    });

    it('rejects stale cycle confirmations and finalized scope without applying any compensation', async () => {
        const f = await sharedFinance(app);
        const p = await pair(f);
        const body = await command(f, p.scope, [
            { id: p.a.obligation.id, amount: 8000 },
            { id: p.b.obligation.id, amount: 8000 },
        ]);
        await db.query(
            'UPDATE settlement_cycles SET version=version+1 WHERE id=$1',
            [p.scope.cycleIds[0]],
        );
        const stale = await financeSnapshot(db);
        await f.a.post(path(f), body).expect(409);
        expect(await financeSnapshot(db)).toEqual(stale);
        await db.query(
            "UPDATE settlement_cycles SET status='FINALIZED',finalized_at=now() WHERE id=$1",
            [p.scope.cycleIds[0]],
        );
        const before = await financeSnapshot(db);
        const preview = await options(f, p.scope);
        expect(preview.reason).toBe('SETTLEMENT_CYCLE_FINALIZED');
        await f.a
            .post(
                path(f),
                await command(f, p.scope, [
                    { id: p.a.obligation.id, amount: 8000 },
                    { id: p.b.obligation.id, amount: 8000 },
                ]),
            )
            .expect(409);
        await f.a.agent
            .get(`${path(f)}/options`)
            .query({ cycleIds: [p.scope.cycleIds[1], randomUUID()].join(',') })
            .expect(404);
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('pages offset history by stable keys and preserves amounts for an obligation filter', async () => {
        const f = await sharedFinance(app);
        const p = await pair(f, 1000, 1000, false);
        const ids: string[] = [];
        for (let index = 0; index < 21; index++) {
            const result = (
                await f.a
                    .post(
                        path(f),
                        await command(f, p.scope, [
                            { id: p.a.obligation.id, amount: 1 },
                            { id: p.b.obligation.id, amount: 1 },
                        ]),
                    )
                    .expect(201)
            ).body;
            ids.push(result.offset.id);
        }
        const before = await financeSnapshot(db);
        const first = (
            await f.a.agent
                .get(path(f))
                .query({ obligationId: p.a.obligation.id })
                .expect(200)
        ).body;
        expect(first.items).toHaveLength(20);
        expect(
            first.items.every(
                (item: {
                    offset: { amountInCents: number };
                    appliedAmountInCentsInFilter: string;
                }) =>
                    item.offset.amountInCents === 1 &&
                    item.appliedAmountInCentsInFilter === '1',
            ),
        ).toBe(true);
        const second = (
            await f.a.agent
                .get(path(f))
                .query({
                    obligationId: p.a.obligation.id,
                    cursor: first.page.nextCursor,
                })
                .expect(200)
        ).body;
        expect(second.items).toHaveLength(1);
        expect(second.page.nextCursor).toBeNull();
        expect(
            [...first.items, ...second.items]
                .map((item: { offset: { id: string } }) => item.offset.id)
                .sort(),
        ).toEqual(ids.sort());
        await f.a.agent
            .get(path(f))
            .query({
                obligationId: p.b.obligation.id,
                cursor: first.page.nextCursor,
            })
            .expect(400);
        await f.b.agent
            .get(path(f))
            .query({
                obligationId: p.a.obligation.id,
                cursor: first.page.nextCursor,
            })
            .expect(400);
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('keeps an options preview coherent while a real offset commits on another connection', async () => {
        const f = await sharedFinance(app);
        const p = await pair(f, 1000, 1000, false);
        const body = await command(f, p.scope, [
            { id: p.a.obligation.id, amount: 500 },
            { id: p.b.obligation.id, amount: 500 },
        ]);
        const provider = app.get(EntityManagerProvider);
        const snapshot = provider.readSnapshot.bind(provider);
        let committed = false;
        vi.spyOn(provider, 'readSnapshot').mockImplementationOnce(
            async <T>(work: () => Promise<T>): Promise<T> =>
                snapshot(async () => {
                    await provider
                        .get()
                        .query(
                            'SELECT version FROM inter_member_obligations WHERE id=$1',
                            [p.a.obligation.id],
                        );
                    await f.a.post(path(f), body).expect(201);
                    committed = true;
                    return work();
                }),
        );
        const before = await options(f, p.scope);
        expect(committed).toBe(true);
        expect(before.maximumAmountInCents).toBe('1000');
        expect(before.preview.amountInCents).toBe('1000');
        expect(
            before.items.every(
                (item: { version: number }) => item.version === 1,
            ),
        ).toBe(true);
        const after = await options(f, p.scope);
        expect(after.maximumAmountInCents).toBe('500');
        expect(
            after.items.every(
                (item: { version: number }) => item.version === 2,
            ),
        ).toBe(true);
    });

    it('keeps the global offset maximum when the bounded preview needs more than twenty origins', async () => {
        const f = await sharedFinance(app);
        let firstCycle = '';
        for (let index = 0; index < 21; index++)
            firstCycle = (await record(f, 1, '2026-10-20')).settlementCycle.id;
        const reverse = await record(f, 21, '2026-10-21', f.ma);
        const scope: Scope = {
            cycleIds: [firstCycle, reverse.settlementCycle.id],
            obligationIds: [],
        };
        const before = await financeSnapshot(db);
        const preview = await options(f, scope);
        expect(preview.maximumAmountInCents).toBe('21');
        expect(preview.preview).toMatchObject({
            amountInCents: '20',
            complete: false,
        });
        expect(preview.items).toHaveLength(20);
        expect(preview.page.nextCursor).toEqual(expect.any(String));
        const next = await options(f, scope, {
            cursor: preview.page.nextCursor,
        });
        expect(next.items).toHaveLength(2);
        expect(next.maximumAmountInCents).toBe('21');
        expect(next.page.nextCursor).toBeNull();
        await f.a.agent
            .get(`${path(f)}/options`)
            .query({
                cycleIds: scope.cycleIds.join(','),
                cursor: preview.page.nextCursor,
                direction: 'RECEIVABLE',
            })
            .expect(400);
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('round-trips the migration on legacy facts and refuses to discard new offset history', async () => {
        const f = await sharedFinance(app);
        const p = await pair(f);
        const legacy = await db.query(
            'SELECT * FROM financial_commitments ORDER BY id',
        );
        const body = await command(f, p.scope, [
            { id: p.a.obligation.id, amount: 8000 },
            { id: p.b.obligation.id, amount: 8000 },
        ]);
        await migrationSource.initialize();
        const [migration] = await migrationSource.query(
            "SELECT name FROM migrations WHERE name ILIKE '%Offset%' ORDER BY id LIMIT 1",
        );
        expect(migration?.name).toEqual(expect.any(String));
        while (
            (
                await migrationSource.query(
                    'SELECT name FROM migrations ORDER BY id DESC LIMIT 1',
                )
            )[0].name !== migration.name
        )
            await migrationSource.undoLastMigration();
        await migrationSource.undoLastMigration();
        expect(
            (
                await db.query(
                    "SELECT to_regclass('settlement_offsets') AS name",
                )
            )[0].name,
        ).toBeNull();
        await migrationSource.runMigrations();
        expect(
            await db.query('SELECT * FROM financial_commitments ORDER BY id'),
        ).toEqual(legacy);
        expect(await db.query('SELECT * FROM settlement_offsets')).toEqual([]);
        await f.a.post(path(f), body).expect(201);
        while (
            (
                await migrationSource.query(
                    'SELECT name FROM migrations ORDER BY id DESC LIMIT 1',
                )
            )[0].name !== migration.name
        )
            await migrationSource.undoLastMigration();
        const before = await financeSnapshot(db);
        const migrations = await db.query(
            'SELECT * FROM migrations ORDER BY id',
        );
        await expect(migrationSource.undoLastMigration()).rejects.toThrow();
        expect(await db.query('SELECT * FROM migrations ORDER BY id')).toEqual(
            migrations,
        );
        await expect(
            db.query(
                'UPDATE settlement_offset_allocations SET amount_in_cents=0',
            ),
        ).rejects.toThrow();
        expect(await financeSnapshot(db)).toEqual(before);
    });

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
