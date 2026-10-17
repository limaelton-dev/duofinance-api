import { describe, expect, it } from 'vitest';
import {
    assessFinancialAdjustment,
    type FinancialCorrectionState,
} from './financial-correction.js';

const shared: FinancialCorrectionState = {
    id: 'root',
    spaceId: 'space',
    kind: 'EXPENSE',
    modality: 'ONE_TIME',
    description: 'Aluguel',
    createdByPersonId: 'person',
    registeredAt: '2026-10-17T12:00:00Z',
    version: 1,
    personal: false,
    targetId: 'root',
    referenceDate: '2026-10-20',
    occurrenceId: null,
    installmentId: null,
    occurrenceVersion: 1,
    economicVersion: 1,
    projected: false,
    cancelled: false,
    resolved: false,
    originalAmountInCents: 50000,
    amountInCents: 50000,
    fulfilledAmountInCents: 0,
    shares: [
        { memberId: 'a', amountInCents: 30000 },
        { memberId: 'b', amountInCents: 20000 },
    ],
    distribution: {
        mode: 'PERCENTAGES',
        shares: [
            { memberId: 'a', basisPoints: 6000 },
            { memberId: 'b', basisPoints: 4000 },
        ],
    },
    expectedMemberId: null,
    settlementRuleSnapshot: null,
    settlementRuleSourceVersion: 0,
    facts: [],
    adjustments: [],
    cancellation: null,
};
describe('financial adjustments', () => {
    it('allocates the delta using the original percentages before rounding', () => {
        const result = assessFinancialAdjustment(
            {
                ...shared,
                originalAmountInCents: 3,
                amountInCents: 3,
                shares: [
                    { memberId: 'a', amountInCents: 2 },
                    { memberId: 'b', amountInCents: 1 },
                ],
            },
            'INCREASE',
            4,
            undefined,
            'a',
        );
        expect(result.shareChanges).toEqual([
            { memberId: 'a', amountInCents: 2 },
            { memberId: 'b', amountInCents: 2 },
        ]);
    });
    it('keeps a zero effective total after an integral reduction without inventing fulfillment', () => {
        const result = assessFinancialAdjustment(
            { ...shared, personal: true, shares: null, distribution: null },
            'DECREASE',
            50000,
            undefined,
            null,
        );
        expect(result.proposedAmountInCents).toBe(0);
        expect(shared.fulfilledAmountInCents).toBe(0);
    });
    it('requires acceptance for an increase to the other member and protects receipts in the opposite direction', () => {
        expect(
            assessFinancialAdjustment(shared, 'INCREASE', 1700, undefined, 'a'),
        ).toMatchObject({
            proposedAmountInCents: 51700,
            requiresAcceptance: true,
            recipientMemberId: 'b',
        });
        expect(
            assessFinancialAdjustment(
                { ...shared, kind: 'INCOME' },
                'DECREASE',
                1700,
                undefined,
                'a',
            ).requiresAcceptance,
        ).toBe(true);
    });
    it('rejects reducing below an actual fulfillment and allows increasing a fully fulfilled origin', () => {
        expect(() =>
            assessFinancialAdjustment(
                { ...shared, fulfilledAmountInCents: 30000 },
                'DECREASE',
                21000,
                undefined,
                'a',
            ),
        ).toThrowError(
            expect.objectContaining({
                code: 'FINANCIAL_ADJUSTMENT_BELOW_FULFILLED',
            }),
        );
        expect(
            assessFinancialAdjustment(
                { ...shared, fulfilledAmountInCents: 50000 },
                'INCREASE',
                1700,
                undefined,
                'a',
            ).proposedAmountInCents,
        ).toBe(51700);
    });
    it('allocates an explicit distribution to the difference, retaining previous shares', () => {
        const result = assessFinancialAdjustment(
            shared,
            'INCREASE',
            1700,
            {
                mode: 'AMOUNTS',
                shares: [
                    { memberId: 'a', amountInCents: 1700 },
                    { memberId: 'b', amountInCents: 0 },
                ],
            },
            'a',
        );
        expect(result.economicShares).toEqual([
            { memberId: 'a', amountInCents: 31700 },
            { memberId: 'b', amountInCents: 20000 },
        ]);
        expect(result.requiresAcceptance).toBe(false);
    });

    it('preserves the original state and conserves the total across the resulting member shares', () => {
        const before = structuredClone(shared);
        const result = assessFinancialAdjustment(
            shared,
            'INCREASE',
            1700,
            undefined,
            'a',
        );
        expect(result.economicShares).toEqual([
            { memberId: 'a', amountInCents: 31020 },
            { memberId: 'b', amountInCents: 20680 },
        ]);
        expect(
            result.economicShares!.reduce(
                (sum, share) => sum + share.amountInCents,
                0,
            ),
        ).toBe(result.proposedAmountInCents);
        expect(shared).toEqual(before);
    });

    it('conserves a residual cent independently of member input order', () => {
        const distribution = {
            mode: 'PERCENTAGES' as const,
            shares: [
                { memberId: 'b', basisPoints: 5000 },
                { memberId: 'a', basisPoints: 5000 },
            ],
        };
        const original = {
            ...shared,
            originalAmountInCents: 100,
            amountInCents: 100,
            shares: [
                { memberId: 'b', amountInCents: 50 },
                { memberId: 'a', amountInCents: 50 },
            ],
            distribution,
        };
        const first = assessFinancialAdjustment(
            original,
            'INCREASE',
            1,
            undefined,
            'a',
        );
        const reversed = assessFinancialAdjustment(
            {
                ...original,
                shares: [...original.shares].reverse(),
                distribution: {
                    ...distribution,
                    shares: [...distribution.shares].reverse(),
                },
            },
            'INCREASE',
            1,
            undefined,
            'a',
        );
        for (const result of [first, reversed]) {
            expect(result.proposedAmountInCents).toBe(101);
            expect(result.economicShares).toEqual(
                expect.arrayContaining([
                    { memberId: 'a', amountInCents: 51 },
                    { memberId: 'b', amountInCents: 50 },
                ]),
            );
            expect(
                result.economicShares!.reduce(
                    (sum, share) => sum + share.amountInCents,
                    0,
                ),
            ).toBe(101);
        }
    });

    it('increases a zero effective base using its preserved percentage agreement', () => {
        const original = {
            ...shared,
            amountInCents: 0,
            shares: [
                { memberId: 'a', amountInCents: 0 },
                { memberId: 'b', amountInCents: 0 },
            ],
        };
        const result = assessFinancialAdjustment(
            original,
            'INCREASE',
            1700,
            undefined,
            'a',
        );
        expect(result.proposedAmountInCents).toBe(1700);
        expect(result.economicShares).toEqual([
            { memberId: 'a', amountInCents: 1020 },
            { memberId: 'b', amountInCents: 680 },
        ]);
        expect(result.recipientMemberId).toBe('b');
        expect(original.originalAmountInCents).toBe(50000);
    });

    it('allows an integral shared discount without negative member shares or invented realization', () => {
        const result = assessFinancialAdjustment(
            shared,
            'DECREASE',
            50000,
            undefined,
            'a',
        );
        expect(result.proposedAmountInCents).toBe(0);
        expect(result.economicShares).toEqual([
            { memberId: 'a', amountInCents: 0 },
            { memberId: 'b', amountInCents: 0 },
        ]);
        expect(result.requiresAcceptance).toBe(false);
        expect(shared.originalAmountInCents).toBe(50000);
        expect(shared.facts).toEqual([]);
    });

    it('permits a discount exactly to the realized boundary', () => {
        const result = assessFinancialAdjustment(
            {
                ...shared,
                personal: true,
                shares: null,
                distribution: null,
                fulfilledAmountInCents: 20000,
            },
            'DECREASE',
            30000,
            undefined,
            null,
        );
        expect(result.proposedAmountInCents).toBe(20000);
    });

    it('rejects negative totals, excessive member discounts and unsafe monetary totals', () => {
        const personal = {
            ...shared,
            personal: true,
            shares: null,
            distribution: null,
        };
        expect(() =>
            assessFinancialAdjustment(
                personal,
                'DECREASE',
                50001,
                undefined,
                null,
            ),
        ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
        expect(() =>
            assessFinancialAdjustment(
                shared,
                'DECREASE',
                40000,
                {
                    mode: 'AMOUNTS',
                    shares: [
                        { memberId: 'a', amountInCents: 0 },
                        { memberId: 'b', amountInCents: 40000 },
                    ],
                },
                'a',
            ),
        ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
        expect(() =>
            assessFinancialAdjustment(
                { ...personal, amountInCents: Number.MAX_SAFE_INTEGER },
                'INCREASE',
                1,
                undefined,
                null,
            ),
        ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    });

    it.each([
        {
            kind: 'EXPENSE' as const,
            increase: false,
            a: 1000,
            b: 0,
            onerous: true,
        },
        {
            kind: 'INCOME' as const,
            increase: true,
            a: 1000,
            b: 0,
            onerous: true,
        },
        {
            kind: 'EXPENSE' as const,
            increase: true,
            a: 0,
            b: 1000,
            onerous: true,
        },
        {
            kind: 'INCOME' as const,
            increase: false,
            a: 0,
            b: 1000,
            onerous: true,
        },
        {
            kind: 'EXPENSE' as const,
            increase: true,
            a: 1000,
            b: 0,
            onerous: false,
        },
        {
            kind: 'INCOME' as const,
            increase: false,
            a: 1000,
            b: 0,
            onerous: false,
        },
    ])(
        'detects relative or absolute burden for $kind increase=$increase allocationA=$a allocationB=$b',
        ({ kind, increase, a, b, onerous }) => {
            const result = assessFinancialAdjustment(
                {
                    ...shared,
                    kind,
                    originalAmountInCents: 10000,
                    amountInCents: 10000,
                    shares: [
                        { memberId: 'a', amountInCents: 6000 },
                        { memberId: 'b', amountInCents: 4000 },
                    ],
                },
                increase ? 'INCREASE' : 'DECREASE',
                1000,
                {
                    mode: 'AMOUNTS',
                    shares: [
                        { memberId: 'a', amountInCents: a },
                        { memberId: 'b', amountInCents: b },
                    ],
                },
                'a',
            );
            expect(result.requiresAcceptance).toBe(onerous);
            expect(result.recipientMemberId).toBe(onerous ? 'b' : null);
            expect(
                result.impactByMember.find((member) => member.memberId === 'a')!
                    .requiresAcceptance,
            ).toBe(false);
        },
    );
});
