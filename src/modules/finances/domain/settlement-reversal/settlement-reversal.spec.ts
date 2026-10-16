import { describe, expect, it } from 'vitest';
import { InterMemberObligation } from '../shared-expense/inter-member-obligation.js';
import {
    SettlementReversal,
    planSettlementReversal,
    type ReversalAllocation,
} from './settlement-reversal.js';

const allocation = (
    patch: Partial<ReversalAllocation> = {},
): ReversalAllocation => ({
    id: 'app',
    originalAllocationId: 'allocation',
    obligationId: 'original',
    debtorMemberId: 'a',
    creditorMemberId: 'b',
    amountInCents: 5000,
    originalCycleId: 'old',
    correctionCycleId: null,
    ...patch,
});
const obligation = (
    id = 'original',
    debtor = 'a',
    creditor = 'b',
    remaining = 0,
    cycle = 'old',
) =>
    new InterMemberObligation(
        id,
        'space',
        'origin',
        'receipt',
        debtor,
        creditor,
        10000,
        cycle,
        '2026-10-14',
        '2026-10-14T15:00:00Z',
        'actor',
        remaining,
        2,
        ['allocation'],
        'INCOME',
        10000,
    );
const reversal = (
    allocations: ReversalAllocation[],
    kind: 'TRANSFER' | 'OFFSET' = 'TRANSFER',
) =>
    new SettlementReversal(
        'reversal',
        'space',
        kind,
        'fact',
        '2026-10-14',
        '2026-10-14T15:00:00Z',
        'actor',
        allocations,
    );

describe('Settlement reversal facts and current origin position', () => {
    it('keeps immutable allocation provenance and the original transfer amount', () => {
        const apps = [allocation()];
        const fact = reversal(apps);
        apps[0].amountInCents = 1;
        expect(fact.amountInCents).toBe(5000);
        expect(fact.allocations[0].amountInCents).toBe(5000);
        expect(Object.isFrozen(fact)).toBe(true);
        expect(Object.isFrozen(fact.allocations[0])).toBe(true);
    });
    it('counts an offset once while requiring equal reciprocal applications', () => {
        const backwards = allocation({
            id: 'app-b',
            originalAllocationId: 'allocation-b',
            obligationId: 'other',
            debtorMemberId: 'b',
            creditorMemberId: 'a',
        });
        expect(
            reversal([allocation(), backwards], 'OFFSET').amountInCents,
        ).toBe(5000);
        expect(() =>
            reversal(
                [allocation(), { ...backwards, amountInCents: 4999 }],
                'OFFSET',
            ),
        ).toThrow();
        expect(() => reversal([allocation(), backwards])).toThrow();
    });
    it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
        'rejects invalid cent amount %s',
        (amountInCents) => {
            expect(() => reversal([allocation({ amountInCents })])).toThrow();
        },
    );
    it('rejects duplicate original allocations, unrelated members and overflow', () => {
        expect(() =>
            reversal([allocation(), allocation({ id: 'second' })]),
        ).toThrow();
        expect(() =>
            reversal([
                allocation(),
                allocation({
                    id: 'second',
                    originalAllocationId: 'second',
                    creditorMemberId: 'c',
                }),
            ]),
        ).toThrow();
        expect(() =>
            reversal([
                allocation({ amountInCents: Number.MAX_SAFE_INTEGER }),
                allocation({ id: 'second', originalAllocationId: 'second' }),
            ]),
        ).toThrow();
    });
    it('restores only the reversed resolution and retains a later waiver', () => {
        const before = new InterMemberObligation(
            'original',
            'space',
            'origin',
            'receipt',
            'a',
            'b',
            10000,
            'old',
            '2026-10-14',
            '2026-10-14T15:00:00Z',
            'actor',
            0,
            3,
            ['allocation'],
            'INCOME',
            10000,
            false,
            null,
            null,
            true,
        );
        const plan = planSettlementReversal([before], [allocation()], []);
        const change = plan.changes[0];
        const after = before.reverseResolution(
            change.remainingAmountInCents,
            change.reversedAmountInCents,
            3,
        );
        expect(after.remainingAmountInCents).toBe(5000);
        expect(after.recognizedAmountInCents).toBe(10000);
        expect(after.status).toBe('PARTIALLY_SETTLED');
        expect(after.originalAmountInCents).toBe(10000);
        expect(before.status).toBe('WAIVED');
    });
    it('uses the current net after subsequent income changes direction', () => {
        const old = obligation();
        const later = obligation('later', 'b', 'a', 5000, 'current');
        const plan = planSettlementReversal([old, later], [allocation()], []);
        expect(plan.newDifference).toBeNull();
        expect(plan.reusedObligation).toBeNull();
        expect(
            plan.changes.map((c) => [
                c.obligation.id,
                c.remainingAmountInCents,
                c.reversedAmountInCents,
            ]),
        ).toEqual([
            ['original', 0, 5000],
            ['later', 0, 0],
        ]);
        const after = old.reverseResolution(0, 5000, 2);
        expect(after.recognizedAmountInCents).toBe(5000);
        expect(after.status).toBe('RECONCILED');
    });
    it('retains later realized amounts and other valid settlements', () => {
        const current = obligation('original', 'a', 'b', 3000);
        const plan = planSettlementReversal([current], [allocation()], []);
        const after = current.reverseResolution(
            plan.changes[0].remainingAmountInCents,
            5000,
            2,
        );
        expect(after.remainingAmountInCents).toBe(8000);
        expect(after.recognizedAmountInCents).toBe(10000);
        expect(after.version).toBe(3);
    });
    it('creates a correction for finalized composition without changing it', () => {
        const old = obligation();
        const plan = planSettlementReversal(
            [old],
            [allocation({ correctionCycleId: 'correction' })],
            ['old'],
        );
        expect(plan.changes).toEqual([]);
        expect(plan.reusedObligation).toBeNull();
        expect(plan.newDifference).toEqual({
            debtorMemberId: 'a',
            creditorMemberId: 'b',
            amountInCents: 5000,
        });
        expect(old.version).toBe(2);
        expect(old.remainingAmountInCents).toBe(0);
    });
    it('rejects stale versions, excess resolution and unrelated origin applications', () => {
        expect(() => obligation().reverseResolution(5000, 5000, 1)).toThrow();
        expect(() =>
            obligation('original', 'a', 'b', 9000).reverseResolution(
                10000,
                5000,
                2,
            ),
        ).toThrow();
        expect(() =>
            planSettlementReversal(
                [obligation()],
                [allocation({ obligationId: 'foreign' })],
                [],
            ),
        ).toThrow();
    });
});
