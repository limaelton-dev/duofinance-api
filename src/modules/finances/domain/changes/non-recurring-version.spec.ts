import { describe, expect, it } from 'vitest';
import {
    assessNonRecurringChange,
    type NonRecurringChangeTarget,
} from './non-recurring-version.js';

const members = ['a', 'b'];
function target(
    id: string,
    amount: number,
    a: number,
    b: number,
): NonRecurringChangeTarget {
    return {
        id,
        dueDate: '2026-12-01',
        originalAmountInCents: amount,
        amountInCents: amount,
        economicShares: [
            { memberId: 'a', amountInCents: a },
            { memberId: 'b', amountInCents: b },
        ],
        fulfilledAmountInCents: 0,
        stateVersion: 1,
        resolved: false,
    };
}

describe('non recurring economic changes', () => {
    it('requires acceptance for increasing the other member absolute responsibility', () => {
        const result = assessNonRecurringChange(
            'EXPENSE',
            [target('one', 150000, 90000, 60000)],
            170000,
            members,
            {
                mode: 'PERCENTAGES',
                shares: [
                    { memberId: 'a', basisPoints: 6000 },
                    { memberId: 'b', basisPoints: 4000 },
                ],
            },
            'a',
        );
        expect(
            result.impactByMember.find((share) => share.memberId === 'b'),
        ).toMatchObject({
            currentAmountInCents: '60000',
            proposedAmountInCents: '68000',
            requiresAcceptance: true,
        });
    });

    it('requires acceptance when the relative share increases despite a smaller amount', () => {
        const result = assessNonRecurringChange(
            'EXPENSE',
            [target('one', 10000, 6000, 4000)],
            5000,
            members,
            {
                mode: 'PERCENTAGES',
                shares: [
                    { memberId: 'a', basisPoints: 5000 },
                    { memberId: 'b', basisPoints: 5000 },
                ],
            },
            'a',
        );
        expect(
            result.impactByMember.find((share) => share.memberId === 'b'),
        ).toMatchObject({
            proposedAmountInCents: '2500',
            requiresAcceptance: true,
        });
    });

    it('does not hide an increase in one installment behind a decrease in another', () => {
        const result = assessNonRecurringChange(
            'EXPENSE',
            [target('one', 100, 100, 0), target('two', 100, 0, 100)],
            200,
            members,
            {
                mode: 'PERCENTAGES',
                shares: [
                    { memberId: 'a', basisPoints: 5000 },
                    { memberId: 'b', basisPoints: 5000 },
                ],
            },
            'a',
        );
        expect(
            result.impactByMember.find((share) => share.memberId === 'b'),
        ).toMatchObject({ deltaInCents: '0', requiresAcceptance: true });
    });

    it('preserves exact cents when spreading a total over selected original amounts', () => {
        const result = assessNonRecurringChange(
            'EXPENSE',
            [target('one', 101, 61, 40), target('two', 102, 61, 41)],
            205,
            members,
            {
                mode: 'PERCENTAGES',
                shares: [
                    { memberId: 'a', basisPoints: 6000 },
                    { memberId: 'b', basisPoints: 4000 },
                ],
            },
            'a',
        );
        expect(
            result.proposedTargets.map((item) => item.amountInCents),
        ).toEqual([101, 104]);
        expect(
            result.proposedTargets
                .flatMap((item) => item.economicShares ?? [])
                .reduce((sum, share) => sum + share.amountInCents, 0),
        ).toBe(205);
    });

    it('allows an increase of only the proposer responsibility and protects income reductions', () => {
        const inputs = [target('one', 10000, 6000, 4000)];
        const distribution = {
            mode: 'AMOUNTS' as const,
            shares: [
                { memberId: 'a', amountInCents: 8000 },
                { memberId: 'b', amountInCents: 4000 },
            ],
        };
        expect(
            assessNonRecurringChange(
                'EXPENSE',
                inputs,
                12000,
                members,
                distribution,
                'a',
            ).requiresAcceptance,
        ).toBe(false);
        expect(
            assessNonRecurringChange(
                'INCOME',
                inputs,
                12000,
                members,
                distribution,
                'a',
            ).requiresAcceptance,
        ).toBe(true);
    });
});
