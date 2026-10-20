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

describe('creditor waivers HTTP/PostgreSQL', () => {
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
        await app?.close();
    });
    const path = (f: SharedFinance, id: string) =>
        `${obligationPath(f.space, id)}/waivers`;
    const body = (f: SharedFinance, version: number, amount: number) => ({
        expectedSpaceVersion: f.context.version,
        expectedObligationVersion: version,
        amountInCents: amount,
        factDate: '2026-10-14',
    });
    const record = (
        f: SharedFinance,
        amount = 10000,
        date: string | null = null,
        total = amount,
    ) => recordSharedObligation(f, amount, date, f.mb, total);
    const read = async (id: string) =>
        (
            await db.query(
                'SELECT * FROM inter_member_obligations WHERE id=$1',
                [id],
            )
        )[0];

    it('allows only the authenticated creditor and exposes the reason to the debtor without permitting delegation', async () => {
        const f = await sharedFinance(app);
        const initial = await record(f);
        const id = initial.obligation.id as string;
        const optionsPath = `${obligationPath(f.space, id)}/waiver-options`;
        const before = await financeSnapshot(db);
        expect(
            (await f.b.agent.get(optionsPath).expect(200)).body,
        ).toMatchObject({
            canWaive: true,
            waiverBlockReason: null,
            obligation: { id, remainingAmountInCents: 10000 },
        });
        expect(
            (await f.a.agent.get(optionsPath).expect(200)).body,
        ).toMatchObject({
            canWaive: false,
            waiverBlockReason: 'CREDITOR_REQUIRED',
        });
        const forbidden = await f.a
            .post(path(f, id), body(f, 1, 1000))
            .expect(403);
        expect(forbidden.body.code).toBe('OBLIGATION_CREDITOR_REQUIRED');
        const outsider = await financeBrowser(app, 'Terceiro');
        await outsider.agent.get(optionsPath).expect(404);
        await outsider.agent.get(path(f, id)).expect(404);
        await outsider.post(path(f, id), body(f, 1, 1000)).expect(404);
        await request(app.getHttpServer()).get(optionsPath).expect(401);
        await request(app.getHttpServer()).get(path(f, id)).expect(401);
        await f.b.agent
            .post(path(f, id))
            .set('Origin', 'http://localhost:3000')
            .set('Idempotency-Key', randomUUID())
            .send(body(f, 1, 1000))
            .expect(403);
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('preserves prior transfer and offset amounts while waiving the remainder and enabling finalization', async () => {
        const f = await sharedFinance(app);
        const initial = await record(f, 35000, '2026-10-20');
        const reverse = await recordSharedObligation(
            f,
            8000,
            '2026-10-21',
            f.ma,
        );
        const id = initial.obligation.id as string;
        await f.a
            .post(`${financeBase(f.space)}/settlement-transfers`, {
                expectedSpaceVersion: f.context.version,
                payerMemberId: f.ma,
                recipientMemberId: f.mb,
                amountInCents: 5000,
                factDate: '2026-10-14',
                allocations: [
                    {
                        obligationId: id,
                        expectedObligationVersion: 1,
                        amountInCents: 5000,
                    },
                ],
            })
            .expect(201);
        const cycles = [initial.settlementCycle.id, reverse.settlementCycle.id];
        await f.a
            .post(`${financeBase(f.space)}/settlement-offsets`, {
                expectedSpaceVersion: f.context.version,
                factDate: '2026-10-14',
                scope: { cycleIds: cycles, obligationIds: [] },
                expectedCycleVersions: cycles.map((cycleId) => ({
                    cycleId,
                    version: 1,
                })),
                allocations: [
                    {
                        obligationId: id,
                        expectedObligationVersion: 2,
                        amountInCents: 8000,
                    },
                    {
                        obligationId: reverse.obligation.id,
                        expectedObligationVersion: 1,
                        amountInCents: 8000,
                    },
                ],
            })
            .expect(201);
        const before = await financeSnapshot(db);
        const overviewPath = `${financeBase(f.space)}/financial-overview`;
        const economic = (
            await f.a.agent
                .get(overviewPath)
                .query({ month: '2026-10' })
                .expect(200)
        ).body;
        const partial = (
            await f.b.post(path(f, id), body(f, 3, 2000)).expect(201)
        ).body;
        expect(partial.waiver).toMatchObject({
            obligationId: id,
            creditorMemberId: f.mb,
            amountInCents: 2000,
            createdByPersonId: f.b.context.person.id,
            reason: null,
        });
        expect(partial.obligation).toMatchObject({
            status: 'PARTIALLY_SETTLED',
            remainingAmountInCents: 20000,
            version: 4,
        });
        const final = (
            await f.b
                .post(path(f, id), {
                    ...body(f, 4, 20000),
                    reason: 'Decisão do credor',
                })
                .expect(201)
        ).body;
        expect(final.obligation).toMatchObject({
            id,
            status: 'WAIVED',
            remainingAmountInCents: 0,
            version: 5,
        });
        const detail = (
            await f.a.agent
                .get(commitmentPath(f.space, initial.commitment.id))
                .expect(200)
        ).body;
        expect(detail.obligation).toMatchObject({
            status: 'WAIVED',
            transferredAmountInCents: 5000,
            compensatedAmountInCents: 8000,
            waivedAmountInCents: 22000,
            remainingAmountInCents: 0,
        });
        expect(
            detail.obligation.history.filter(
                (item: { type: string }) => item.type === 'WAIVED',
            ),
        ).toHaveLength(2);
        const summary = (
            await f.a.agent
                .get(`${financeBase(f.space)}/settlement-cycles/summary`)
                .query({ cycleIds: cycles.join(',') })
                .expect(200)
        ).body;
        expect(summary.totals).toMatchObject({
            originalAmountInCents: '43000',
            resolvedAmountInCents: '43000',
            remainingAmountInCents: '0',
            transferredAmountInCents: '5000',
            compensatedAmountInCents: '16000',
            waivedAmountInCents: '22000',
        });
        expect(summary.position.net).toEqual({
            direction: 'BALANCED',
            amountInCents: '0',
        });
        const today = (
            await f.a.agent.get(`${financeBase(f.space)}/today`).expect(200)
        ).body;
        expect(today.finance.data.settlements.nextCycle.totals).toMatchObject({
            waivedAmountInCents: '22000',
            remainingAmountInCents: '0',
        });
        expect(
            (
                await f.a.agent
                    .get(overviewPath)
                    .query({ month: '2026-10' })
                    .expect(200)
            ).body,
        ).toEqual(economic);
        const timeline = (
            await f.a.agent
                .get(`${financeBase(f.space)}/financial-timeline`)
                .query({ month: '2026-10', view: 'HISTORY' })
                .expect(200)
        ).body;
        expect(
            timeline.items
                .filter(
                    (item: { type: string }) => item.type === 'INTERNAL_WAIVER',
                )
                .map((item: { amountInCents: number }) => item.amountInCents)
                .sort((a: number, b: number) => a - b),
        ).toEqual([2000, 20000]);
        const after = await financeSnapshot(db);
        for (const table of [
            'financial_commitments',
            'financial_disbursements',
            'financial_receipts',
            'financial_commitment_shares',
            'settlement_transfers',
            'settlement_allocations',
            'settlement_offsets',
            'settlement_offset_allocations',
        ])
            expect(after[table]).toEqual(before[table]);
        const history = (await f.a.agent.get(path(f, id)).expect(200)).body;
        expect(history.items).toHaveLength(2);
        for (const cycleId of cycles)
            await f.a
                .post(
                    `${financeBase(f.space)}/settlement-cycles/${cycleId}/finalize`,
                    {
                        expectedSpaceVersion: f.context.version,
                        expectedCycleVersion: 1,
                    },
                )
                .expect(200);
        const frozen = await financeSnapshot(db);
        await f.b.post(path(f, id), body(f, 5, 1)).expect(409);
        expect(await financeSnapshot(db)).toEqual(frozen);
    });

    it.each([1, Number.MAX_SAFE_INTEGER])(
        'waives the exact safe boundary amount %s without requiring a reason',
        async (amount) => {
            const f = await sharedFinance(app);
            const initial = await record(f, amount);
            const result = (
                await f.b
                    .post(path(f, initial.obligation.id), body(f, 1, amount))
                    .expect(201)
            ).body;
            expect(result.waiver).toMatchObject({
                amountInCents: amount,
                reason: null,
            });
            expect(result.obligation).toMatchObject({
                remainingAmountInCents: 0,
                status: 'WAIVED',
            });
        },
    );

    it('replays concurrent identical waivers once and preserves authorization in CLOSED', async () => {
        const f = await sharedFinance(app);
        const initial = await record(f);
        const input = body(f, 1, 1000);
        const key = randomUUID();
        const duplicates = await competingFinanceCommands(db, f.space, () =>
            Promise.all([
                f.b.post(path(f, initial.obligation.id), input, key),
                f.b.post(path(f, initial.obligation.id), input, key),
            ]),
        );
        expect(duplicates.map((response) => response.status).sort()).toEqual([
            200, 201,
        ]);
        const first = duplicates.find(
            (response) => response.status === 201,
        )!.body;
        for (const response of duplicates) {
            expect(response.headers.location).toBeUndefined();
            expect(response.body).toEqual({
                ...first,
                replayed: response.status === 200,
            });
        }
        const before = await financeSnapshot(db);
        await f.b
            .post(
                path(f, initial.obligation.id),
                { ...input, amountInCents: 2000 },
                key,
            )
            .expect(409);
        expect(await financeSnapshot(db)).toEqual(before);
        await db.query("UPDATE spaces SET status='CLOSED' WHERE id=$1", [
            f.space,
        ]);
        expect(
            (
                await f.b
                    .post(path(f, initial.obligation.id), input, key)
                    .expect(200)
            ).body,
        ).toEqual({ ...first, replayed: true });
        await f.b
            .post(path(f, initial.obligation.id), body(f, 2, 1000))
            .expect(409);
        const outsider = await financeBrowser(app, 'Novo vínculo');
        await db.query('UPDATE space_members SET person_id=$2 WHERE id=$1', [
            f.mb,
            outsider.context.person.id,
        ]);
        await f.b.post(path(f, initial.obligation.id), input, key).expect(404);
        expect(
            await db.query(
                'SELECT * FROM obligation_waivers WHERE obligation_id=$1',
                [initial.obligation.id],
            ),
        ).toHaveLength(1);
    });

    it.each(['transfer', 'movement'] as const)(
        'serializes waiver against %s using current obligation versions',
        async (kind) => {
            const f = await sharedFinance(app);
            const initial = await record(f, 10000, '2026-10-20');
            const id = initial.obligation.id as string;
            const other =
                kind === 'transfer'
                    ? f.a.post(`${financeBase(f.space)}/settlement-transfers`, {
                          expectedSpaceVersion: f.context.version,
                          payerMemberId: f.ma,
                          recipientMemberId: f.mb,
                          amountInCents: 1000,
                          factDate: '2026-10-14',
                          allocations: [
                              {
                                  obligationId: id,
                                  expectedObligationVersion: 1,
                                  amountInCents: 1000,
                              },
                          ],
                      })
                    : f.a.post(
                          `${obligationPath(f.space, id)}/settlement-assignment`,
                          {
                              expectedSpaceVersion: f.context.version,
                              expectedObligationVersion: 1,
                              expectedCycleVersions: [
                                  {
                                      cycleId: initial.settlementCycle.id,
                                      version: 1,
                                  },
                              ],
                              settlement: {
                                  mode: 'DATE',
                                  targetDate: '2026-10-21',
                              },
                          },
                      );
            const responses = await competingFinanceCommands(db, f.space, () =>
                Promise.all([f.b.post(path(f, id), body(f, 1, 10000)), other]),
            );
            expect(
                responses.filter((response) => response.status === 409),
            ).toHaveLength(1);
            const current = await read(id);
            expect(current.version).toBe(2);
            if (responses[0].status === 201)
                expect(current).toMatchObject({
                    status: 'WAIVED',
                    remaining_amount_in_cents: '0',
                });
            else
                expect(current.remaining_amount_in_cents).toBe(
                    kind === 'transfer' ? '9000' : '10000',
                );
        },
    );

    it('does not resurrect the waived amount when the same origin is realized again', async () => {
        const f = await sharedFinance(app);
        const initial = await record(f, 5000, '2026-10-20', 10000);
        await f.b
            .post(path(f, initial.obligation.id), body(f, 1, 5000))
            .expect(201);
        const before = await db.query(
            'SELECT * FROM obligation_waivers ORDER BY id',
        );
        const next = (
            await f.a
                .post(
                    `${commitmentPath(f.space, initial.commitment.id)}/disbursements`,
                    {
                        expectedSpaceVersion: f.context.version,
                        expectedCommitmentVersion: initial.commitment.version,
                        amountInCents: 5000,
                        factDate: '2026-10-14',
                        payerMemberId: f.mb,
                        method: 'PIX',
                        settlement: { mode: 'NONE' },
                    },
                )
                .expect(201)
        ).body;
        expect(
            next.obligations.reduce(
                (sum: number, obligation: { remainingAmountInCents: number }) =>
                    sum + obligation.remainingAmountInCents,
                0,
            ),
        ).toBe(5000);
        expect(
            next.obligations.find(
                (obligation: { id: string }) =>
                    obligation.id === initial.obligation.id,
            ),
        ).toMatchObject({
            status: 'WAIVED',
            waivedAmountInCents: 5000,
            remainingAmountInCents: 0,
        });
        expect(
            await db.query('SELECT * FROM obligation_waivers ORDER BY id'),
        ).toEqual(before);
        expect(await db.query('SELECT * FROM settlement_transfers')).toEqual(
            [],
        );
    });

    it('rejects invalid amounts, future dates and stale confirmation without changing facts', async () => {
        const f = await sharedFinance(app);
        const initial = await record(f);
        const id = initial.obligation.id as string;
        const before = await financeSnapshot(db);
        for (const invalid of [
            { amountInCents: 0 },
            { amountInCents: -1 },
            { amountInCents: 0.5 },
            { amountInCents: Number.MAX_SAFE_INTEGER + 1 },
            { factDate: '2026-10-15' },
            { unknown: true },
        ]) {
            const response = await f.b
                .post(path(f, id), { ...body(f, 1, 1000), ...invalid })
                .expect(400);
            expect(response.body.code).toBe('VALIDATION_ERROR');
            expect(response.body.message).not.toMatch(
                /Invalid|Expected|must be/,
            );
        }
        await f.b.post(path(f, id), body(f, 2, 1000)).expect(409);
        await f.b.post(path(f, id), body(f, 1, 10001)).expect(409);
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('pages immutable waiver facts with the current obligation in every history item', async () => {
        const f = await sharedFinance(app);
        const initial = await record(f, 1000);
        const id = initial.obligation.id as string;
        const ids: string[] = [];
        for (let index = 0; index < 21; index++)
            ids.push(
                (await f.b.post(path(f, id), body(f, index + 1, 1)).expect(201))
                    .body.waiver.id,
            );
        const before = await financeSnapshot(db);
        const first = (await f.a.agent.get(path(f, id)).expect(200)).body;
        expect(first.items).toHaveLength(20);
        const second = (
            await f.a.agent
                .get(path(f, id))
                .query({ cursor: first.page.nextCursor })
                .expect(200)
        ).body;
        expect(second.items).toHaveLength(1);
        expect(second.page.nextCursor).toBeNull();
        expect(
            [...first.items, ...second.items]
                .map((item: { waiver: { id: string } }) => item.waiver.id)
                .sort(),
        ).toEqual(ids.sort());
        for (const historical of [...first.items, ...second.items])
            expect(historical).toMatchObject({
                waiver: {
                    amountInCents: 1,
                    createdByPersonId: f.b.context.person.id,
                },
                obligation: {
                    version: 22,
                    remainingAmountInCents: 979,
                    status: 'PARTIALLY_SETTLED',
                },
            });
        await f.a.agent.get(`${path(f, id)}/${ids[0]}`).expect(404);
        await f.b.agent
            .get(path(f, id))
            .query({ cursor: first.page.nextCursor })
            .expect(400);
        expect(await financeSnapshot(db)).toEqual(before);
    });

    it('rolls waiver, history, receipt and balance back when audit persistence fails', async () => {
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        const f = await sharedFinance(app);
        const initial = await record(f);
        const key = randomUUID();
        const before = await financeSnapshot(db);
        await db.query(
            "CREATE FUNCTION reject_obligation_waivers_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'obligation-waivers forced audit failure'; END $$",
        );
        await db.query(
            'CREATE TRIGGER reject_obligation_waivers_audit BEFORE INSERT ON financial_settlement_adjustment_audit FOR EACH ROW EXECUTE FUNCTION reject_obligation_waivers_audit()',
        );
        try {
            await f.b
                .post(path(f, initial.obligation.id), body(f, 1, 1000), key)
                .expect(500);
            expect(await financeSnapshot(db)).toEqual(before);
        } finally {
            await db.query(
                'DROP TRIGGER reject_obligation_waivers_audit ON financial_settlement_adjustment_audit',
            );
            await db.query('DROP FUNCTION reject_obligation_waivers_audit()');
        }
        await f.b
            .post(path(f, initial.obligation.id), body(f, 1, 1000), key)
            .expect(201);
        expect(
            await db.query(
                'SELECT * FROM financial_settlement_adjustment_audit WHERE idempotency_key=$1',
                [key],
            ),
        ).toHaveLength(1);
    });
    it('rejects zero creditor waivers in PostgreSQL without changing financial history', async () => {
        const f = await sharedFinance(app);
        const initial = await record(f);
        await f.b
            .post(path(f, initial.obligation.id), body(f, 1, 1000))
            .expect(201);
        const before = await financeSnapshot(db);
        await expect(
            db.query('UPDATE obligation_waivers SET amount_in_cents=0'),
        ).rejects.toMatchObject({ driverError: { code: '23514' } });
        expect(await financeSnapshot(db)).toEqual(before);
    });
});
