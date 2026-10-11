import { describe, it, expect, vi } from 'vitest';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work.js';
import { RecordSharedCashExpenseHandler } from './record-shared-cash-expense.handler.js';
import type {
    RecordSharedCashExpenseCommand,
    SharedCashExpenseResult,
} from '../models/shared-cash-expense.js';
import type {
    FinancialCommitmentRepository,
    InterMemberObligationRepository,
    SettlementCycleRepository,
    ExpenseCommandReceipts,
} from '../ports/private/shared-expense.repositories.js';
import { ExpenseReceiptRaceError } from '../ports/private/shared-expense.repositories.js';
import type { DefaultSettlementRuleRepository } from '../ports/private/default-settlement-rule.repository.js';
import { DefaultSettlementRule } from '../../domain/default-settlement-rule/default-settlement-rule.js';
import { SettlementRule } from '../../domain/settlement-rule/settlement-rule.js';
import { SettlementCycle } from '../../domain/shared-expense/settlement-cycle.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type {
    SpaceFinancialContextPort,
    SpaceFinancialContext,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import { SpacesDomainError } from '../../../spaces/domain/errors/spaces-domain.error.js';
const actor = '00000000-0000-4000-8000-000000000001',
    a = '00000000-0000-4000-8000-000000000002',
    b = '00000000-0000-4000-8000-000000000003',
    space = '00000000-0000-4000-8000-000000000004';
const command = (): RecordSharedCashExpenseCommand => ({
    actorId: PersonId.from(actor),
    spaceId: SpaceId.from(space),
    idempotencyKey: '00000000-0000-4000-8000-000000000005',
    expectedSpaceVersion: 2,
    description: 'Mercado',
    amountInCents: 50000,
    factDate: '2026-10-09',
    responsibilitySplit: {
        mode: 'PERCENTAGES',
        shares: [
            { memberId: a, basisPoints: 4000 },
            { memberId: b, basisPoints: 6000 },
        ],
    },
    expectedPayerMemberId: a,
    disbursement: { payerMemberId: b, method: 'DEBIT' },
    settlement: { mode: 'NONE' },
});
function setup() {
    let saved: SharedCashExpenseResult | null = null,
        rule: DefaultSettlementRule | null = null,
        today = '2026-10-10';
    const context: SpaceFinancialContext = {
        spaceId: space,
        type: 'SHARED',
        status: 'ACTIVE',
        version: 2,
        actorMemberId: a,
        members: [
            { memberId: a, personId: actor, displayName: 'A' },
            { memberId: b, personId: 'personB', displayName: 'B' },
        ],
    };
    const access: SpaceFinancialContextPort = {
        read: vi.fn(async () => context),
        lockForWrite: vi.fn(async () => {
            if (context.status !== 'ACTIVE')
                throw new SpacesDomainError('SPACE_NOT_ACTIVE');
            return context;
        }),
    };
    const rules: DefaultSettlementRuleRepository = {
        find: vi.fn(async () => rule),
        save: vi.fn(),
    };
    const commitments: FinancialCommitmentRepository = {
        save: vi.fn(async () => {}),
        detail: vi.fn(async () => null),
    };
    const obligations: InterMemberObligationRepository = {
        save: vi.fn(async () => {}),
    };
    const cycles: SettlementCycleRepository = {
        lockForDate: vi.fn(
            async (s, d) => new SettlementCycle('cycle', s, d, 'OPEN', 1),
        ),
        lockExisting: vi.fn(
            async () =>
                new SettlementCycle('cycle', space, '2026-09-01', 'OPEN', 1),
        ),
        listOpen: vi.fn(async () => []),
    };
    const receipts: ExpenseCommandReceipts = {
        find: vi.fn(async () => saved),
        save: vi.fn(async (_c, r) => {
            saved = r;
        }),
    };
    const uow: UnitOfWork = {
        execute: async <T>(work: () => Promise<T>) => work(),
    };
    vi.spyOn(uow, 'execute');
    const handler = new RecordSharedCashExpenseHandler(
        uow,
        access,
        rules,
        commitments,
        obligations,
        cycles,
        receipts,
        { now: () => new Date('2026-10-10T15:00:00Z'), today: () => today },
    );
    return {
        handler,
        access,
        rules,
        commitments,
        obligations,
        cycles,
        receipts,
        uow,
        context,
        setRule: (value: DefaultSettlementRule | null) => {
            rule = value;
        },
        setToday: (value: string) => {
            today = value;
        },
        setReceipt: (value: SharedCashExpenseResult | null) => {
            saved = value;
        },
    };
}
describe('Record shared cash expense orchestration', () => {
    it.each([
        [b, a, b, 20000],
        [a, b, a, 30000],
    ])(
        'reconciles payer %s and persists roots synchronously',
        (payer, debtor, creditor, amount) => {
            const f = setup(),
                c = command();
            return f.handler
                .execute({
                    ...c,
                    disbursement: { ...c.disbursement, payerMemberId: payer },
                })
                .then((r) => {
                    expect(r.obligation).toMatchObject({
                        debtorMemberId: debtor,
                        creditorMemberId: creditor,
                        originalAmountInCents: amount,
                    });
                    expect(r.commitment.expectedPayerMemberId).toBe(a);
                    expect(r.commitment.createdByPersonId).toBe(actor);
                    expect(f.obligations.save).toHaveBeenCalledOnce();
                    expect(f.cycles.lockForDate).not.toHaveBeenCalled();
                });
        },
    );
    it('records no expected payer without changing the obligation', async () => {
        const f = setup();
        const r = await f.handler.execute({
            ...command(),
            expectedPayerMemberId: null,
        });
        expect(r.commitment.expectedPayerMemberId).toBeNull();
        expect(r.obligation?.originalAmountInCents).toBe(20000);
        expect(r.disbursement.payerMemberId).toBe(b);
    });
    it('records sole creator with no rule, obligation or empty cycle', async () => {
        const f = setup();
        f.context.members = f.context.members.slice(0, 1);
        const c = command(),
            r = await f.handler.execute({
                ...c,
                responsibilitySplit: {
                    mode: 'AMOUNTS',
                    shares: [{ memberId: a, amountInCents: 50000 }],
                },
                disbursement: { payerMemberId: a, method: 'CASH' },
            });
        expect(r.obligation).toBeNull();
        expect(r.settlementCycle).toBeNull();
        expect(r.commitment.settlementRuleSnapshot).toBeNull();
        expect(f.cycles.lockForDate).not.toHaveBeenCalled();
        expect(f.obligations.save).not.toHaveBeenCalled();
    });
    it('authorizes before receipt lookup and locks context only for a new write', async () => {
        const f = setup();
        const r = await f.handler.execute(command());
        f.context.status = 'CLOSED';
        expect((await f.handler.execute(command())).replayed).toBe(true);
        expect(f.access.lockForWrite).toHaveBeenCalledTimes(1);
        expect(
            vi.mocked(f.access.read).mock.invocationCallOrder[0],
        ).toBeLessThan(vi.mocked(f.receipts.find).mock.invocationCallOrder[0]);
        f.setReceipt(null);
        await expect(f.handler.execute(command())).rejects.toMatchObject({
            code: 'SPACE_NOT_ACTIVE',
        });
        expect(r.commitment.registeredAt).toBe('2026-10-10T15:00:00.000Z');
    });
    it('never exposes a historical receipt after access is revoked', async () => {
        const f = setup();
        await f.handler.execute(command());
        vi.mocked(f.access.read).mockRejectedValue(
            new SpacesDomainError('SPACE_NOT_FOUND'),
        );
        await expect(f.handler.execute(command())).rejects.toMatchObject({
            code: 'SPACE_NOT_FOUND',
        });
        expect(f.receipts.find).toHaveBeenCalledTimes(1);
    });
    it.each(['expectedPayerMemberId', 'payerMemberId', 'shares'])(
        'rejects foreign member in %s before financial writes',
        async (role) => {
            const f = setup(),
                c = command();
            if (role === 'expectedPayerMemberId')
                c.expectedPayerMemberId = 'foreign';
            else if (role === 'payerMemberId')
                c.disbursement.payerMemberId = 'foreign';
            else c.responsibilitySplit.shares[0].memberId = 'foreign';
            await expect(f.handler.execute(c)).rejects.toMatchObject({
                code: 'VALIDATION_ERROR',
            });
            expect(f.commitments.save).not.toHaveBeenCalled();
        },
    );
    it('rejects stale participant version and future fact date', async () => {
        const f = setup();
        await expect(
            f.handler.execute({ ...command(), expectedSpaceVersion: 1 }),
        ).rejects.toMatchObject({ code: 'EXPENSE_OPTIONS_CHANGED' });
        await expect(
            f.handler.execute({ ...command(), factDate: '2026-10-11' }),
        ).rejects.toMatchObject({
            code: 'VALIDATION_ERROR',
            fields: ['factDate'],
        });
        expect(f.commitments.save).not.toHaveBeenCalled();
    });
    it('preserves rule value, source version and suggestion independently of fact/date choice', async () => {
        const f = setup();
        f.setRule(
            DefaultSettlementRule.create(
                space,
                SettlementRule.from({ kind: 'MONTHLY_DAY', dayOfMonth: 31 }),
                new Date(),
            ),
        );
        const r = await f.handler.execute({
            ...command(),
            settlement: { mode: 'DATE', targetDate: '2026-11-02' },
        });
        expect(r.commitment.settlementRuleSnapshot).toEqual({
            kind: 'MONTHLY_DAY',
            dayOfMonth: 31,
        });
        expect(r.commitment.settlementRuleSourceVersion).toBe(1);
        expect(r.commitment.suggestedTargetDate).toBe('2026-10-31');
        expect(r.settlementCycle?.targetDate).toBe('2026-11-02');
        f.setRule(null);
        expect(
            (await f.handler.execute(command())).commitment
                .settlementRuleSnapshot,
        ).toEqual({ kind: 'MONTHLY_DAY', dayOfMonth: 31 });
    });
    it('requires fresh explicit suggested reference and rule version', async () => {
        const f = setup();
        f.setRule(
            DefaultSettlementRule.create(
                space,
                SettlementRule.from({ kind: 'MONTHLY_DAY', dayOfMonth: 10 }),
                new Date(),
            ),
        );
        await expect(
            f.handler.execute({
                ...command(),
                settlement: {
                    mode: 'SUGGESTED',
                    referenceDate: '2026-10-09',
                    expectedRuleVersion: 1,
                },
            }),
        ).rejects.toMatchObject({ code: 'EXPENSE_OPTIONS_CHANGED' });
        await expect(
            f.handler.execute({
                ...command(),
                settlement: {
                    mode: 'SUGGESTED',
                    referenceDate: '2026-10-10',
                    expectedRuleVersion: 2,
                },
            }),
        ).rejects.toMatchObject({ code: 'EXPENSE_OPTIONS_CHANGED' });
        const r = await f.handler.execute({
            ...command(),
            settlement: {
                mode: 'SUGGESTED',
                referenceDate: '2026-10-10',
                expectedRuleVersion: 1,
            },
        });
        expect(r.settlementCycle?.targetDate).toBe('2026-10-10');
    });
    it('selects an existing overdue OPEN cycle without changing its date', async () => {
        const f = setup(),
            r = await f.handler.execute({
                ...command(),
                settlement: { mode: 'CYCLE', cycleId: 'cycle' },
            });
        expect(r.settlementCycle?.targetDate).toBe('2026-09-01');
        expect(f.cycles.lockForDate).not.toHaveBeenCalled();
    });
    it('rejects missing/finalized cycles and contradictory zero-difference selection', async () => {
        const f = setup();
        vi.mocked(f.cycles.lockExisting)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(
                new SettlementCycle(
                    'cycle',
                    space,
                    '2026-10-10',
                    'FINALIZED',
                    1,
                ),
            );
        const c = {
            ...command(),
            settlement: { mode: 'CYCLE' as const, cycleId: 'cycle' },
        };
        await expect(f.handler.execute(c)).rejects.toMatchObject({
            code: 'SETTLEMENT_CYCLE_NOT_FOUND',
        });
        await expect(f.handler.execute(c)).rejects.toMatchObject({
            code: 'SETTLEMENT_CYCLE_FINALIZED',
        });
        await expect(
            f.handler.execute({
                ...c,
                responsibilitySplit: {
                    mode: 'AMOUNTS',
                    shares: [
                        { memberId: a, amountInCents: 0 },
                        { memberId: b, amountInCents: 50000 },
                    ],
                },
            }),
        ).rejects.toMatchObject({
            code: 'VALIDATION_ERROR',
            fields: ['settlement.mode'],
        });
    });
    it('recovers only a known receipt race in a fresh UnitOfWork', async () => {
        const f = setup();
        vi.mocked(f.receipts.save).mockImplementationOnce(async (_c, r) => {
            f.setReceipt(r);
            throw new ExpenseReceiptRaceError();
        });
        expect((await f.handler.execute(command())).replayed).toBe(true);
        expect(f.uow.execute).toHaveBeenCalledTimes(2);
        const g = setup();
        vi.mocked(g.receipts.save).mockRejectedValue(
            new Error('arbitrary failure'),
        );
        await expect(g.handler.execute(command())).rejects.toThrow(
            'arbitrary failure',
        );
        expect(g.uow.execute).toHaveBeenCalledTimes(1);
    });
});
