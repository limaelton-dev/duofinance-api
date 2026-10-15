import { describe, expect, it } from 'vitest';
import {
    FinancialCommitment,
    type ExpenseVersion,
    type ExternalLiabilitySettlement,
} from './financial-commitment.js';
import { Money } from './money.js';
import { ResponsibilitySplit } from './responsibility-split.js';
import { expenseDifference } from './obligation-reconciler.js';
const today = '2026-10-15',
    now = '2026-10-15T15:00:00.000Z';
function create(shared = false, amount = 20000) {
    const version: ExpenseVersion = shared
        ? {
              version: 1,
              split: ResponsibilitySplit.create(20000, ['a', 'b'], {
                  mode: 'AMOUNTS',
                  shares: [
                      { memberId: 'a', amountInCents: 10000 },
                      { memberId: 'b', amountInCents: 10000 },
                  ],
              }),
              expectedPayerMemberId: null,
              factDate: today,
              settlementRuleSnapshot: null,
              settlementRuleSourceVersion: 0,
              suggestedTargetDate: null,
          }
        : {
              version: 1,
              ownerPersonId: 'owner',
              amount: Money.from(20000),
              factDate: today,
          };
    return new FinancialCommitment(
        'expense',
        'space',
        'Purchase',
        'owner',
        now,
        version,
        [],
        today,
        1,
        [
            {
                id: 'card',
                sequence: 1,
                ...(shared
                    ? { holderMemberId: 'b' }
                    : { holderPersonId: 'owner' }),
                amountInCents: amount,
                remainingAmountInCents: amount,
                factDate: today,
                registeredAt: now,
                recordedByPersonId: 'owner',
            },
        ],
    );
}
const payment = (amountInCents = 6000, id = 'payment', factDate = today) => ({
    id,
    amountInCents,
    factDate,
    registeredAt: now,
    recordedByPersonId: 'owner',
});
describe('External liability settlement', () => {
    it.each([false, true])(
        'settles partially then fully without changing support or economic facts (shared %s)',
        (shared) => {
            const c = create(shared),
                partial = c.settleExternalLiability(
                    'card',
                    payment(),
                    1,
                    today,
                ),
                full = partial.settleExternalLiability(
                    'card',
                    payment(14000, 'rest'),
                    2,
                    today,
                );
            expect(partial.externalOutstandingAmountInCents).toBe(14000);
            expect(full.externalOutstandingAmountInCents).toBe(0);
            expect(full.externalSettledAmountInCents).toBe(20000);
            expect(full.externalLiabilities[0].settlements).toHaveLength(2);
            for (const next of [partial, full]) {
                expect(next.version).toBe(next === partial ? 2 : 3);
                expect(next.paidAmountInCents).toBe(0);
                expect(next.supportedAmountInCents).toBe(20000);
                expect(next.assumedAmountInCents).toBe(20000);
                expect(next.remainingAmountInCents).toBe(0);
                expect(next.disbursements).toEqual([]);
                expect(next.fulfillments).toHaveLength(1);
                expect(next.initialVersion).toEqual(c.initialVersion);
            }
            expect(() =>
                full.settleExternalLiability(
                    'card',
                    payment(1, 'extra'),
                    3,
                    today,
                ),
            ).toThrowError(
                expect.objectContaining({
                    code: 'EXTERNAL_LIABILITY_ALREADY_SETTLED',
                }),
            );
            expect(c.externalOutstandingAmountInCents).toBe(20000);
            expect(
                Object.isFrozen(full.externalLiabilities[0].settlements![0]),
            ).toBe(true);
        },
    );
    it('preserves shared difference after prior internal partial or full transfer', () => {
        const c = create(true),
            next = c.settleExternalLiability('card', payment(), 1, today);
        if (!('split' in c.initialVersion)) throw new Error();
        const support = (root: typeof c) =>
            root.externalLiabilities.map((f) => ({
                payerMemberId: 'holderMemberId' in f ? f.holderMemberId : '',
                amountInCents: f.amountInCents,
            }));
        for (const amountInCents of [0, 4000, 10000]) {
            const transfers = amountInCents
                ? [
                      {
                          payerMemberId: 'a',
                          recipientMemberId: 'b',
                          amountInCents,
                      },
                  ]
                : [];
            expect(
                expenseDifference(
                    c.initialVersion.split,
                    support(next),
                    transfers,
                ),
            ).toEqual(
                expenseDifference(
                    c.initialVersion.split,
                    support(c),
                    transfers,
                ),
            );
        }
    });
    it('keeps independent origins and supports subsequent cash/card facts with global CAS sequence', () => {
        const a = create(false, 8001).settleExternalLiability(
            'card',
            payment(101),
            1,
            today,
        );
        const b = a.recordDisbursement(
            {
                id: 'cash',
                payerPersonId: 'owner',
                method: 'PIX',
                amountInCents: 3999,
                factDate: today,
                registeredAt: now,
            },
            2,
            today,
        );
        const c = b.recordExternalLiability(
            {
                id: 'card2',
                holderPersonId: 'owner',
                amountInCents: 8000,
                remainingAmountInCents: 8000,
                factDate: today,
                registeredAt: now,
                recordedByPersonId: 'owner',
            },
            3,
            today,
        );
        const d = c.settleExternalLiability(
            'card2',
            payment(3000, 'p2'),
            4,
            today,
        );
        expect(d.fulfillments.map((f) => f.sequence)).toEqual([1, 3, 4]);
        expect(
            d.externalLiabilities.map((f) => f.remainingAmountInCents),
        ).toEqual([7900, 5000]);
        expect(d.paidAmountInCents).toBe(3999);
        expect(d.supportedAmountInCents).toBe(20000);
        expect(d.version).toBe(5);
    });
    it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 20001, NaN, Infinity])(
        'rejects invalid settlement amount %s',
        (amount) => {
            expect(() =>
                create().settleExternalLiability(
                    'card',
                    payment(amount),
                    1,
                    today,
                ),
            ).toThrowError(
                expect.objectContaining({ code: 'VALIDATION_ERROR' }),
            );
        },
    );
    it.each(['2026-02-30', '2026-10-16', 'invalid'])(
        'rejects invalid or future civil date %s',
        (date) => {
            expect(() =>
                create().settleExternalLiability(
                    'card',
                    payment(1, 'p', date),
                    1,
                    today,
                ),
            ).toThrow();
        },
    );
    it('accepts retroactive dates and rejects stale versions or absent origin', () => {
        expect(
            create().settleExternalLiability(
                'card',
                payment(1, 'p', '2026-01-01'),
                1,
                today,
            ).externalSettledAmountInCents,
        ).toBe(1);
        expect(() =>
            create().settleExternalLiability('card', payment(), 2, today),
        ).toThrowError(
            expect.objectContaining({ code: 'CONCURRENT_MODIFICATION' }),
        );
        expect(() =>
            create().settleExternalLiability('other', payment(), 1, today),
        ).toThrowError(
            expect.objectContaining({ code: 'EXTERNAL_LIABILITY_NOT_FOUND' }),
        );
    });
    it('rejects corrupted persisted totals, holder, identity, sequence and origin', () => {
        const c = create().settleExternalLiability('card', payment(), 1, today),
            f = c.externalLiabilities[0];
        const restore = (
            patch: Partial<ExternalLiabilitySettlement>,
            remaining = 14000,
        ) =>
            new FinancialCommitment(
                c.id,
                c.spaceId,
                c.description,
                c.createdByPersonId,
                c.registeredAt,
                c.initialVersion,
                [],
                today,
                2,
                [
                    {
                        ...f,
                        remainingAmountInCents: remaining,
                        settlements: [{ ...f.settlements![0], ...patch }],
                    },
                ],
            );
        for (const patch of [
            { externalLiabilityId: 'wrong' },
            { holderPersonId: 'other' },
            { recordedByPersonId: 'other' },
            { sequence: 1 },
            { id: 'card' },
        ])
            expect(() => restore(patch)).toThrow();
        expect(() => restore({}, 13999)).toThrow();
    });
});
