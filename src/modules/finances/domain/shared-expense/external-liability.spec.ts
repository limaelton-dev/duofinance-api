import { describe, expect, it } from 'vitest';
import {
    FinancialCommitment,
    type ExternalLiability,
    type PersonalCommitmentVersion,
} from './financial-commitment.js';
import { ResponsibilitySplit } from './responsibility-split.js';
import { expenseDifference } from './obligation-reconciler.js';
import { Money } from './money.js';
const today = '2026-10-15',
    now = '2026-10-15T15:00:00.000Z';
const split = ResponsibilitySplit.create(20000, ['a', 'b'], {
    mode: 'AMOUNTS',
    shares: [
        { memberId: 'a', amountInCents: 10000 },
        { memberId: 'b', amountInCents: 10000 },
    ],
});
const version = {
    version: 1 as const,
    split,
    expectedPayerMemberId: null,
    factDate: today,
    settlementRuleSnapshot: null,
    settlementRuleSourceVersion: 0,
    suggestedTargetDate: null,
};
const liability = (
    id = 'card',
    amountInCents = 20000,
    holderMemberId = 'b',
): ExternalLiability => ({
    id,
    amountInCents,
    remainingAmountInCents: amountInCents,
    holderMemberId,
    factDate: today,
    registeredAt: now,
    recordedByPersonId: 'author',
});
const create = (amount = 20000) =>
    new FinancialCommitment(
        'expense',
        'space',
        'Purchase',
        'author',
        now,
        version,
        [],
        today,
        undefined,
        [liability('card', amount)],
    );
const support = (c: FinancialCommitment) => [
    ...c.disbursements,
    ...c.externalLiabilities.map((f) => ({
        payerMemberId: f.holderMemberId,
        amountInCents: f.amountInCents,
    })),
];
describe('External liability expense support', () => {
    it('realizes a shared purchase without a cash disbursement', () => {
        const c = create();
        expect(c.disbursements).toEqual([]);
        expect(c.paidAmountInCents).toBe(0);
        expect(c.assumedAmountInCents).toBe(20000);
        expect(c.externalOutstandingAmountInCents).toBe(20000);
        expect(c.supportedAmountInCents).toBe(20000);
        expect(c.remainingAmountInCents).toBe(0);
        expect(c.fulfillmentStatus).toBe('FULFILLED');
        expect(expenseDifference(split, support(c))).toEqual({
            debtorMemberId: 'a',
            creditorMemberId: 'b',
            amountInCents: 10000,
        });
        expect(c.initialVersion.expectedPayerMemberId).toBeNull();
    });
    it('owns a personal liability without members or internal settlement', () => {
        const c = new FinancialCommitment<PersonalCommitmentVersion>(
            'personal',
            'space',
            'Purchase',
            'owner',
            now,
            {
                version: 1,
                ownerPersonId: 'owner',
                amount: Money.from(20000),
                factDate: today,
            },
            [],
            today,
            undefined,
            [
                {
                    id: 'personal-card',
                    holderPersonId: 'owner',
                    amountInCents: 20000,
                    remainingAmountInCents: 20000,
                    factDate: today,
                    registeredAt: now,
                    recordedByPersonId: 'owner',
                },
            ],
        );
        expect(c.externalLiabilities[0]).not.toHaveProperty('holderMemberId');
        expect(c.fulfillmentStatus).toBe('FULFILLED');
    });
    it('accumulates partial card and cash facts in one deterministic sequence', () => {
        const first = create(5000);
        expect(expenseDifference(split, support(first))).toBeNull();
        const second = first.recordDisbursement(
            {
                id: 'cash',
                payerMemberId: 'a',
                method: 'PIX',
                amountInCents: 10000,
                factDate: '2026-10-14',
                registeredAt: now,
            },
            1,
            today,
        );
        const third = second.recordExternalLiability(
            liability('card-2', 5000),
            2,
            today,
        );
        expect(third.fulfillments.map((f) => [f.id, f.sequence])).toEqual([
            ['card', 1],
            ['cash', 2],
            ['card-2', 3],
        ]);
        expect(third.paidAmountInCents).toBe(10000);
        expect(third.assumedAmountInCents).toBe(10000);
        expect(third.remainingAmountInCents).toBe(0);
        expect(third.initialVersion.split.total.amountInCents).toBe(20000);
        expect(expenseDifference(split, support(third))).toBeNull();
        const restored = new FinancialCommitment(
            third.id,
            third.spaceId,
            third.description,
            third.createdByPersonId,
            third.registeredAt,
            third.initialVersion,
            third.disbursements,
            today,
            third.version,
            third.externalLiabilities,
        );
        expect(restored.fulfillments).toEqual(third.fulfillments);
    });
    it('combines cash first then card and preserves settled amounts in inversion', () => {
        const c = new FinancialCommitment(
            'expense',
            'space',
            'Purchase',
            'author',
            now,
            version,
            {
                id: 'cash',
                payerMemberId: 'a',
                method: 'PIX',
                amountInCents: 12000,
                factDate: today,
                registeredAt: now,
            },
            today,
        );
        const next = c.recordExternalLiability(
            liability('card', 8000, 'b'),
            1,
            today,
        );
        expect(next.paidAmountInCents).toBe(12000);
        expect(next.externalOutstandingAmountInCents).toBe(8000);
        expect(
            expenseDifference(split, support(next), [
                {
                    payerMemberId: 'b',
                    recipientMemberId: 'a',
                    amountInCents: 2000,
                },
            ]),
        ).toBeNull();
    });
    it.each([0, -1, 0.5, 20001, Number.MAX_SAFE_INTEGER + 1])(
        'rejects invalid assumed amount %s',
        (amount) => expect(() => create(amount)).toThrow(),
    );
    it('rejects stale versions, repeated identity, foreign holder and fulfillment after completion', () => {
        const c = create(5000);
        expect(() =>
            c.recordExternalLiability(liability('second', 5000), 0, today),
        ).toThrow();
        expect(() =>
            c.recordExternalLiability(liability('card', 5000), 1, today),
        ).toThrow();
        expect(() =>
            c.recordExternalLiability(
                liability('second', 5000, 'foreign'),
                1,
                today,
            ),
        ).toThrow();
        expect(() =>
            create().recordExternalLiability(liability('second', 1), 1, today),
        ).toThrow();
    });
});
