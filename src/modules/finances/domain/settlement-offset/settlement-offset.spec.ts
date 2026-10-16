import { describe, expect, it } from 'vitest';
import {
    SettlementOffset,
    type SettlementOffsetAllocation,
} from './settlement-offset.js';
import { InterMemberObligation } from '../shared-expense/inter-member-obligation.js';

const now = '2026-10-16T15:00:00.000Z';
const date = '2026-10-16';
function allocation(
    id: string,
    debtor: string,
    creditor: string,
    amountInCents: number,
): SettlementOffsetAllocation {
    return {
        id,
        obligationId: id + '-obligation',
        cycleId: id + '-cycle',
        debtorMemberId: debtor,
        creditorMemberId: creditor,
        amountInCents,
    };
}
function offset(allocations: SettlementOffsetAllocation[]) {
    return new SettlementOffset(
        'offset',
        'space',
        date,
        now,
        'author',
        allocations,
    );
}
describe('Explicit reciprocal settlement offset', () => {
    it('reduces reciprocal obligations equally without creating a cash fact', () => {
        const first = new InterMemberObligation(
            'one',
            'space',
            'expense',
            'payment',
            'a',
            'b',
            35000,
            'cycle-one',
            date,
            now,
            'author',
        );
        const second = new InterMemberObligation(
            'two',
            'space',
            'income',
            'receipt',
            'b',
            'a',
            8000,
            'cycle-two',
            date,
            now,
            'author',
            undefined,
            undefined,
            undefined,
            'INCOME',
        );
        const fact = offset([
            {
                ...allocation('allocation-one', 'a', 'b', 8000),
                obligationId: first.id,
                cycleId: first.cycleId,
            },
            {
                ...allocation('allocation-two', 'b', 'a', 8000),
                obligationId: second.id,
                cycleId: second.cycleId,
            },
        ]);
        const reduced = [first, second].map((obligation, index) =>
            obligation.applySettlement(
                fact.allocations[index].id,
                fact.allocations[index].amountInCents,
                1,
            ),
        );
        expect(fact.amountInCents).toBe(8000);
        expect(reduced.map((o) => o.remainingAmountInCents)).toEqual([
            27000, 0,
        ]);
        expect(reduced.map((o) => o.originCommitmentId)).toEqual([
            'expense',
            'income',
        ]);
        expect(first.remainingAmountInCents).toBe(35000);
        expect(second.remainingAmountInCents).toBe(8000);
    });
    it('preserves distinct origins and accepts partial compensation across cycles', () => {
        const input = [
            allocation('one', 'a', 'b', 2000),
            allocation('two', 'a', 'b', 3000),
            allocation('three', 'b', 'a', 5000),
        ];
        const fact = offset(input);
        input[0].amountInCents = 1;
        expect(fact.amountInCents).toBe(5000);
        expect(fact.allocations.map((a) => a.amountInCents)).toEqual([
            2000, 3000, 5000,
        ]);
        expect(Object.isFrozen(fact.allocations[0])).toBe(true);
    });
    it.each([
        [],
        [allocation('one', 'a', 'b', 1)],
        [allocation('one', 'a', 'b', 8000), allocation('two', 'b', 'a', 7999)],
        [allocation('one', 'a', 'b', 8000), allocation('two', 'a', 'b', 8000)],
        [allocation('one', 'a', 'b', 8000), allocation('two', 'b', 'c', 8000)],
        [allocation('one', 'a', 'a', 8000), allocation('two', 'a', 'a', 8000)],
        [allocation('one', 'a', 'b', 0), allocation('two', 'b', 'a', 0)],
        [allocation('one', 'a', 'b', -1), allocation('two', 'b', 'a', -1)],
        [allocation('one', 'a', 'b', 1.5), allocation('two', 'b', 'a', 1.5)],
        [
            allocation('one', 'a', 'b', Number.MAX_SAFE_INTEGER),
            allocation('two', 'a', 'b', 1),
            allocation('three', 'b', 'a', Number.MAX_SAFE_INTEGER),
            allocation('four', 'b', 'a', 1),
        ],
        [allocation('same', 'a', 'b', 1), allocation('same', 'b', 'a', 1)],
        [
            allocation('one', 'a', 'b', 1),
            {
                ...allocation('two', 'b', 'a', 1),
                obligationId: 'one-obligation',
            },
        ],
    ])('rejects invalid or ambiguous applications %#', (...allocations) => {
        expect(() => offset(allocations)).toThrowError(
            expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        );
    });
    it('keeps the maximum safe reciprocal amount exact', () => {
        const maximum = Number.MAX_SAFE_INTEGER;
        expect(
            offset([
                allocation('one', 'a', 'b', maximum),
                allocation('two', 'b', 'a', maximum),
            ]).amountInCents,
        ).toBe(maximum);
    });
});
