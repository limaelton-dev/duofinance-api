import { describe, expect, it, vi } from 'vitest';
import {
    IncomeCommitment,
    type IncomeReceipt,
} from '../../domain/income/income-commitment.js';
import { FinancialCommitment } from '../../domain/shared-expense/financial-commitment.js';
import { ResponsibilitySplit } from '../../domain/shared-expense/responsibility-split.js';
import { SettlementCycle } from '../../domain/shared-expense/settlement-cycle.js';
import type { InterMemberObligation } from '../../domain/shared-expense/inter-member-obligation.js';
import type { OriginSettlement } from '../../domain/shared-expense/obligation-reconciler.js';
import type {
    InterMemberObligationRepository,
    SettlementCycleRepository,
} from '../ports/private/shared-expense.repositories.js';
import { ReconcileFinancialOrigin } from './reconcile-financial-origin.js';
import type { SettlementAdjustmentRepository } from '../ports/private/settlement-adjustment.repository.js';
const a = 'a',
    b = 'b',
    today = '2026-10-15',
    now = '2026-10-15T12:00:00.000Z';
function split(total: number) {
    return ResponsibilitySplit.create(total, [a, b], {
        mode: 'PERCENTAGES',
        shares: [
            { memberId: a, basisPoints: 6000 },
            { memberId: b, basisPoints: 4000 },
        ],
    });
}
function receipt(
    id: string,
    member: string,
    amountInCents: number,
): IncomeReceipt {
    return {
        id,
        amountInCents,
        factDate: today,
        registeredAt: now,
        recordedByPersonId: 'author',
        recipientPersonId: null,
        recipientMemberId: member,
    };
}
function pending() {
    return new IncomeCommitment(
        'income',
        'space',
        'Receita',
        100000,
        today,
        'author',
        now,
        {
            type: 'SHARED',
            split: split(100000),
            expectedRecipientMemberId: b,
            settlementRuleSnapshot: { kind: 'MONTHLY_DAY', dayOfMonth: 20 },
            settlementRuleSourceVersion: 2,
        },
    );
}
function setup() {
    const obligations: InterMemberObligation[] = [],
        settlements: OriginSettlement[] = [];
    const repo: InterMemberObligationRepository = {
        originState: vi.fn(async () => ({
            obligations: [...obligations],
            settlements,
        })),
        lockOrigin: vi.fn(async () => ({
            obligations: [...obligations],
            settlements,
        })),
        save: vi.fn(async (o) => {
            obligations.push(o);
        }),
        saveReconciliation: vi.fn(async (before, after) => {
            obligations[obligations.findIndex((o) => o.id === before.id)] =
                after;
        }),
        history: vi.fn(),
    };
    const cycles: SettlementCycleRepository = {
        lockExisting: vi.fn(
            async (s, id) => new SettlementCycle(id, s, today, 'OPEN', 1),
        ),
        lockForDate: vi.fn(
            async (s, date) =>
                new SettlementCycle(`cycle-${date}`, s, date, 'OPEN', 1),
        ),
        listOpen: vi.fn(),
    };
    const adjustments: SettlementAdjustmentRepository = {
        readSnapshot: async <T>(work: () => Promise<T>) => work(),
        findReceipt: vi.fn(),
        saveReceipt: vi.fn(),
        commitment: vi.fn(),
        saveRule: vi.fn(),
        effectiveRule: vi.fn<SettlementAdjustmentRepository['effectiveRule']>(
            async (_space, _commitment, rule, version) => ({
                source: 'INHERITED',
                rule,
                version,
            }),
        ),
        cycle: vi.fn(),
        cycleForDate: vi.fn(),
        createCycleForDate: vi.fn(),
        lockCycles: vi.fn(),
        saveAssignment: vi.fn(),
        options: vi.fn(),
    };
    return {
        service: new ReconcileFinancialOrigin(repo, cycles, adjustments),
        repo,
        cycles,
        adjustments,
        obligations,
        settlements,
    };
}
describe('ReconcileFinancialOrigin application', () => {
    it('closes the previous direction by reconciliation before storing the opposite episode', async () => {
        const f = setup(),
            first = pending().recordReceipt(receipt('one', a, 50000), 1, today);
        await f.service.execute(first, { mode: 'NONE' }, 'author', today, now);
        const original = f.obligations[0];
        await f.service.execute(
            first.recordReceipt(receipt('two', b, 50000), 2, today),
            { mode: 'NONE' },
            'other',
            today,
            now,
        );
        expect(f.obligations).toHaveLength(2);
        expect(f.obligations[0]).toMatchObject({
            id: original.id,
            status: 'RECONCILED',
            originalAmountInCents: 20000,
            recognizedAmountInCents: 0,
            remainingAmountInCents: 0,
        });
        expect(f.obligations[0].reconciliation).toMatchObject({
            causeFulfillmentId: 'two',
            actorId: 'other',
        });
        expect(f.obligations[1]).toMatchObject({
            debtorMemberId: b,
            creditorMemberId: a,
            remainingAmountInCents: 10000,
            originDisbursementId: 'two',
        });
        expect(
            vi.mocked(f.repo.saveReconciliation).mock.invocationCallOrder[0],
        ).toBeLessThan(vi.mocked(f.repo.save).mock.invocationCallOrder[1]);
    });
    it.each([5000, 20000])(
        'preserves %s cents transferred before the reversal',
        async (amountInCents) => {
            const f = setup(),
                first = pending().recordReceipt(
                    receipt('one', a, 50000),
                    1,
                    today,
                );
            await f.service.execute(
                first,
                { mode: 'NONE' },
                'author',
                today,
                now,
            );
            f.obligations[0] = f.obligations[0].applySettlement(
                'allocation',
                amountInCents,
                1,
            );
            f.settlements.push({
                payerMemberId: a,
                recipientMemberId: b,
                amountInCents,
            });
            await f.service.execute(
                first.recordReceipt(receipt('two', b, 50000), 2, today),
                { mode: 'NONE' },
                'other',
                today,
                now,
            );
            expect(f.obligations[0].remainingAmountInCents).toBe(0);
            expect(f.obligations[0].appliedAllocationIds).toEqual([
                'allocation',
            ]);
            expect(f.obligations[1].remainingAmountInCents).toBe(
                10000 + amountInCents,
            );
        },
    );
    it('preserves every episode after multiple inversions', async () => {
        const f = setup();
        let c = pending();
        for (const [i, member] of [a, b, a, b].entries()) {
            c = c.recordReceipt(
                receipt(`fact-${i}`, member, 25000),
                c.version,
                today,
            );
            await f.service.execute(c, { mode: 'NONE' }, 'author', today, now);
        }
        expect(f.obligations).toHaveLength(4);
        expect(
            f.obligations.slice(0, 3).every((o) => o.status === 'RECONCILED'),
        ).toBe(true);
        expect(
            f.obligations.filter((o) => o.remainingAmountInCents > 0),
        ).toHaveLength(1);
        expect(f.obligations.at(-1)).toMatchObject({
            debtorMemberId: b,
            remainingAmountInCents: 10000,
        });
    });
    it('retains the existing cycle and original amount when a same-direction obligation grows', async () => {
        const f = setup(),
            first = pending().recordReceipt(receipt('one', a, 25000), 1, today);
        await f.service.execute(
            first,
            { mode: 'DATE', targetDate: '2026-10-20' },
            'author',
            today,
            now,
        );
        const original = f.obligations[0];
        vi.mocked(f.cycles.lockForDate).mockClear();
        await f.service.execute(
            first.recordReceipt(receipt('two', a, 25000), 2, today),
            { mode: 'DATE', targetDate: '2026-10-21' },
            'author',
            today,
            now,
        );
        expect(f.obligations).toHaveLength(1);
        expect(f.obligations[0]).toMatchObject({
            id: original.id,
            originalAmountInCents: 10000,
            recognizedAmountInCents: 20000,
            remainingAmountInCents: 20000,
            cycleId: 'cycle-2026-10-20',
        });
        expect(f.cycles.lockForDate).not.toHaveBeenCalled();
    });
    it('reopens the settled episode in its original direction without charging already transferred money again', async () => {
        const f = setup(),
            first = pending().recordReceipt(receipt('one', a, 25000), 1, today);
        await f.service.execute(first, { mode: 'NONE' }, 'author', today, now);
        const original = f.obligations[0];
        f.obligations[0] = original.applySettlement('allocation', 10000, 1);
        f.settlements.push({
            payerMemberId: a,
            recipientMemberId: b,
            amountInCents: 10000,
        });
        await f.service.execute(
            first.recordReceipt(receipt('two', a, 25000), 2, today),
            { mode: 'NONE' },
            'author',
            today,
            now,
        );
        expect(f.obligations).toHaveLength(1);
        expect(f.obligations[0]).toMatchObject({
            id: original.id,
            originalAmountInCents: 10000,
            recognizedAmountInCents: 20000,
            remainingAmountInCents: 10000,
            status: 'PARTIALLY_SETTLED',
        });
    });
    it('does not create a cycle for partial expense support below the original responsibility', async () => {
        const f = setup(),
            c = new FinancialCommitment(
                'expense',
                'space',
                'Despesa',
                'author',
                now,
                {
                    version: 1,
                    split: split(50000),
                    expectedPayerMemberId: b,
                    factDate: today,
                    settlementRuleSnapshot: null,
                    settlementRuleSourceVersion: 0,
                    suggestedTargetDate: null,
                },
                {
                    id: 'one',
                    payerMemberId: a,
                    method: 'PIX',
                    amountInCents: 10000,
                    factDate: today,
                    registeredAt: now,
                },
                today,
            );
        await f.service.execute(
            c,
            { mode: 'DATE', targetDate: '2026-10-20' },
            'author',
            today,
            now,
        );
        expect(f.obligations).toEqual([]);
        expect(f.cycles.lockForDate).not.toHaveBeenCalled();
    });
    it('refuses assigning a new residual to a finalized cycle before writing obligation history', async () => {
        const f = setup();
        vi.mocked(f.cycles.lockExisting).mockResolvedValue(
            new SettlementCycle('closed', 'space', today, 'FINALIZED', 2),
        );
        await expect(
            f.service.execute(
                pending().recordReceipt(receipt('one', a, 50000), 1, today),
                { mode: 'CYCLE', cycleId: 'closed' },
                'author',
                today,
                now,
            ),
        ).rejects.toMatchObject({ code: 'SETTLEMENT_CYCLE_FINALIZED' });
        expect(f.repo.save).not.toHaveBeenCalled();
        expect(f.repo.saveReconciliation).not.toHaveBeenCalled();
    });
    it('refuses reconciling a finalized cycle when a later receipt eliminates the difference', async () => {
        const f = setup();
        const first = pending().recordReceipt(
            receipt('one', a, 60000),
            1,
            today,
        );
        await f.service.execute(
            first,
            { mode: 'CYCLE', cycleId: 'closed' },
            'author',
            today,
            now,
        );
        const original = f.obligations[0];
        vi.mocked(f.repo.save).mockClear();
        vi.mocked(f.cycles.lockExisting).mockResolvedValue(
            new SettlementCycle('closed', 'space', today, 'FINALIZED', 2),
        );

        await expect(
            f.service.execute(
                first.recordReceipt(receipt('two', b, 40000), 2, today),
                { mode: 'NONE' },
                'author',
                today,
                now,
            ),
        ).rejects.toMatchObject({ code: 'SETTLEMENT_CYCLE_FINALIZED' });
        expect(f.repo.save).not.toHaveBeenCalled();
        expect(f.repo.saveReconciliation).not.toHaveBeenCalled();
        expect(f.obligations).toEqual([original]);
        expect(original).toMatchObject({
            cycleId: 'closed',
            remainingAmountInCents: 24000,
            status: 'OPEN',
        });
    });
    it('creates a later residual in the explicitly selected open cycle instead of reusing a finalized settled root', async () => {
        const f = setup();
        const first = pending().recordReceipt(
            receipt('one', a, 50000),
            1,
            today,
        );
        await f.service.execute(
            first,
            { mode: 'CYCLE', cycleId: 'closed' },
            'author',
            today,
            now,
        );
        const before = f.obligations[0].applySettlement('transfer', 20000, 1);
        f.obligations[0] = before;
        f.settlements.push({
            payerMemberId: a,
            recipientMemberId: b,
            amountInCents: 20000,
        });
        vi.mocked(f.adjustments.cycle).mockResolvedValue({
            id: 'closed',
            version: 2,
            status: 'FINALIZED',
            targetDate: today,
        });
        vi.mocked(f.cycles.lockExisting).mockImplementation(
            async (space, id) =>
                new SettlementCycle(
                    id,
                    space,
                    today,
                    id === 'closed' ? 'FINALIZED' : 'OPEN',
                    id === 'closed' ? 2 : 1,
                ),
        );
        const next = first.recordReceipt(receipt('two', a, 25000), 2, today);
        await expect(
            f.service.execute(next, { mode: 'NONE' }, 'author', today, now),
        ).rejects.toMatchObject({ code: 'SETTLEMENT_CYCLE_FINALIZED' });
        await f.service.execute(
            next,
            { mode: 'CYCLE', cycleId: 'correction' },
            'author',
            today,
            now,
        );
        expect(f.obligations[0]).toBe(before);
        expect(f.obligations[1]).toMatchObject({
            cycleId: 'correction',
            remainingAmountInCents: 10000,
        });
    });
    it('locks existing destination and origin cycles in ID order before obligation writes', async () => {
        const f = setup();
        const first = pending().recordReceipt(
            receipt('one', a, 50000),
            1,
            today,
        );
        await f.service.execute(
            first,
            { mode: 'CYCLE', cycleId: 'z-cycle' },
            'author',
            today,
            now,
        );
        vi.mocked(f.cycles.lockExisting).mockClear();
        vi.mocked(f.repo.lockOrigin).mockClear();
        vi.mocked(f.adjustments.cycleForDate).mockResolvedValue({
            id: 'a-cycle',
            targetDate: '2026-10-20',
            status: 'OPEN',
            version: 1,
        });

        await f.service.execute(
            first.recordReceipt(receipt('two', b, 50000), 2, today),
            { mode: 'DATE', targetDate: '2026-10-20' },
            'author',
            today,
            now,
        );
        expect(vi.mocked(f.cycles.lockExisting).mock.calls).toEqual([
            ['space', 'a-cycle'],
            ['space', 'z-cycle'],
        ]);
        expect(f.cycles.lockForDate).not.toHaveBeenCalled();
        expect(
            vi.mocked(f.cycles.lockExisting).mock.invocationCallOrder[1],
        ).toBeLessThan(
            vi.mocked(f.repo.lockOrigin).mock.invocationCallOrder[0],
        );
        expect(f.obligations).toMatchObject([
            { cycleId: 'z-cycle', status: 'RECONCILED' },
            { cycleId: 'a-cycle', remainingAmountInCents: 10000 },
        ]);
    });
    it('uses the original settlement snapshot with a current civil-date reference', async () => {
        const f = setup();
        await f.service.execute(
            pending().recordReceipt(receipt('one', a, 50000), 1, today),
            { mode: 'SUGGESTED', referenceDate: today, expectedRuleVersion: 2 },
            'author',
            today,
            now,
        );
        expect(f.cycles.lockForDate).toHaveBeenCalledWith(
            'space',
            '2026-10-20',
        );
    });
    it('rejects a stale suggestion without creating a cycle', async () => {
        const f = setup();
        await expect(
            f.service.execute(
                pending().recordReceipt(receipt('one', a, 50000), 1, today),
                {
                    mode: 'SUGGESTED',
                    referenceDate: '2026-10-14',
                    expectedRuleVersion: 2,
                },
                'author',
                today,
                now,
            ),
        ).rejects.toMatchObject({ code: 'INCOME_OPTIONS_CHANGED' });
        expect(f.cycles.lockForDate).not.toHaveBeenCalled();
    });
    it('uses the specific rule for a new residual while preserving the inherited snapshot', async () => {
        const f = setup();
        const origin = pending().recordReceipt(
            receipt('one', a, 50000),
            1,
            today,
        );
        vi.mocked(f.adjustments.effectiveRule).mockResolvedValue({
            source: 'SPECIFIC',
            rule: { kind: 'MONTHLY_DAY', dayOfMonth: 31 },
            version: 3,
        });
        await f.service.execute(
            origin,
            { mode: 'SUGGESTED', referenceDate: today, expectedRuleVersion: 3 },
            'author',
            today,
            now,
        );
        expect(f.cycles.lockForDate).toHaveBeenCalledWith(
            'space',
            '2026-10-31',
        );
        expect(origin.participation).toMatchObject({
            settlementRuleSnapshot: { dayOfMonth: 20 },
            settlementRuleSourceVersion: 2,
        });
    });
    it('rejects a superseded rule version before persisting the residual', async () => {
        const f = setup();
        vi.mocked(f.adjustments.effectiveRule).mockResolvedValue({
            source: 'SPECIFIC',
            rule: { kind: 'MONTHLY_DAY', dayOfMonth: 31 },
            version: 3,
        });
        await expect(
            f.service.execute(
                pending().recordReceipt(receipt('one', a, 50000), 1, today),
                {
                    mode: 'SUGGESTED',
                    referenceDate: today,
                    expectedRuleVersion: 2,
                },
                'author',
                today,
                now,
            ),
        ).rejects.toMatchObject({ code: 'INCOME_OPTIONS_CHANGED' });
        expect(f.cycles.lockForDate).not.toHaveBeenCalled();
        expect(f.repo.save).not.toHaveBeenCalled();
        expect(f.repo.saveReconciliation).not.toHaveBeenCalled();
    });
});
