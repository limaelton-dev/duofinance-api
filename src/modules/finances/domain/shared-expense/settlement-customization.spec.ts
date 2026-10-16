import { describe, expect, it } from 'vitest';
import { IncomeCommitment } from '../income/income-commitment.js';
import { FinancialCommitment } from './financial-commitment.js';
import { InterMemberObligation } from './inter-member-obligation.js';
import { ResponsibilitySplit } from './responsibility-split.js';

const today = '2026-10-16';
const now = '2026-10-16T15:00:00.000Z';
const snapshot = { kind: 'MONTHLY_DAY' as const, dayOfMonth: 31 };
const split = ResponsibilitySplit.create(20000, ['a', 'b'], {
    mode: 'PERCENTAGES',
    shares: [
        { memberId: 'a', basisPoints: 5000 },
        { memberId: 'b', basisPoints: 5000 },
    ],
});
const initialVersion = {
    version: 1 as const,
    split,
    expectedPayerMemberId: 'a',
    factDate: today,
    settlementRuleSnapshot: snapshot,
    settlementRuleSourceVersion: 2,
    suggestedTargetDate: '2026-10-31',
};
const payment = {
    id: 'first',
    sequence: 1,
    payerMemberId: 'a',
    method: 'PIX' as const,
    amountInCents: 5000,
    factDate: today,
    registeredAt: now,
    recordedByPersonId: 'author',
};

function expense(version = 4) {
    return new FinancialCommitment(
        'expense',
        'space',
        'Compra',
        'author',
        now,
        initialVersion,
        payment,
        today,
        version,
    );
}

function obligation() {
    return new InterMemberObligation(
        'obligation',
        'space',
        'expense',
        'card',
        'b',
        'a',
        10000,
        'old-cycle',
        today,
        now,
        'author',
        undefined,
        undefined,
        undefined,
        'EXPENSE',
        undefined,
        undefined,
        null,
        'card',
    );
}

describe('Settlement customization preserves financial facts', () => {
    it('keeps factual sequences contiguous after intervening commitment changes', () => {
        const original = expense();
        const card = original.recordExternalLiability(
            {
                id: 'card',
                holderMemberId: 'b',
                amountInCents: 8000,
                remainingAmountInCents: 8000,
                factDate: today,
                registeredAt: now,
                recordedByPersonId: 'author',
            },
            4,
            today,
        );
        const settled = card.settleExternalLiability(
            'card',
            {
                id: 'card-payment',
                amountInCents: 2000,
                factDate: today,
                registeredAt: now,
                recordedByPersonId: 'author',
            },
            5,
            today,
        );
        const completed = settled.recordDisbursement(
            { ...payment, id: 'last', amountInCents: 7000 },
            6,
            today,
        );

        expect(completed).toMatchObject({
            version: 7,
            supportedAmountInCents: 20000,
            paidAmountInCents: 12000,
            remainingAmountInCents: 0,
            externalOutstandingAmountInCents: 6000,
        });
        expect(completed.fulfillments.map((fact) => fact.sequence)).toEqual([
            1, 2, 4,
        ]);
        expect(completed.externalLiabilities[0].settlements![0].sequence).toBe(
            3,
        );
        expect(completed.initialVersion).toEqual(original.initialVersion);
        expect(original.version).toBe(4);
        expect(original.disbursements).toHaveLength(1);
        expect(() =>
            original.recordDisbursement(
                { ...payment, id: 'stale', amountInCents: 1 },
                1,
                today,
            ),
        ).toThrowError(
            expect.objectContaining({ code: 'CONCURRENT_MODIFICATION' }),
        );
    });

    it('accepts a later income version without changing inherited participation', () => {
        const firstReceipt = {
            id: 'first-receipt',
            amountInCents: 5000,
            factDate: today,
            registeredAt: now,
            recordedByPersonId: 'author',
            recipientPersonId: null,
            recipientMemberId: 'a',
        };
        const income = new IncomeCommitment(
            'income',
            'space',
            'Serviço',
            20000,
            today,
            'author',
            now,
            {
                type: 'SHARED',
                split,
                expectedRecipientMemberId: 'a',
                settlementRuleSnapshot: snapshot,
                settlementRuleSourceVersion: 2,
            },
            firstReceipt,
            4,
        );
        const complete = income.recordReceipt(
            { ...firstReceipt, id: 'last-receipt', amountInCents: 15000 },
            4,
            today,
        );
        expect(complete).toMatchObject({
            version: 5,
            receivedAmountInCents: 20000,
            remainingAmountInCents: 0,
            status: 'RECEIVED',
        });
        expect(complete.participation).toEqual(income.participation);
        expect(complete.participation).toMatchObject({
            settlementRuleSnapshot: { dayOfMonth: 31 },
            settlementRuleSourceVersion: 2,
        });
        expect(complete.receipts).toHaveLength(2);
        expect(income.receipts).toHaveLength(1);
    });

    it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
        'rejects invalid aggregate version %s',
        (version) => {
            expect(() => expense(version)).toThrowError();
        },
    );

    it('moves a partially settled obligation without changing facts or prior allocations', () => {
        const partial = obligation().applySettlement('allocation', 4000, 1);
        const moved = partial.moveToCycle('new-cycle', 2);
        const standalone = moved.moveToCycle(null, 3);

        for (const next of [moved, standalone]) {
            expect(next).toMatchObject({
                originCommitmentId: 'expense',
                originDisbursementId: 'card',
                originExternalLiabilityId: 'card',
                originalAmountInCents: 10000,
                recognizedAmountInCents: 10000,
                remainingAmountInCents: 6000,
                status: 'PARTIALLY_SETTLED',
                factDate: today,
                registeredAt: now,
                appliedAllocationIds: ['allocation'],
                debtorMemberId: 'b',
                creditorMemberId: 'a',
            });
            expect(next.history).toEqual(partial.history);
        }
        expect(moved).toMatchObject({ cycleId: 'new-cycle', version: 3 });
        expect(standalone).toMatchObject({ cycleId: null, version: 4 });
        expect(partial).toMatchObject({ cycleId: 'old-cycle', version: 2 });
        expect(Object.isFrozen(standalone)).toBe(true);
    });

    it('refuses stale moves and moves of obligations with no remaining amount', () => {
        expect(() => obligation().moveToCycle(null, 2)).toThrowError(
            expect.objectContaining({ code: 'CONCURRENT_MODIFICATION' }),
        );
        const settled = obligation().applySettlement('allocation', 10000, 1);
        expect(() => settled.moveToCycle('new-cycle', 2)).toThrowError(
            expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        );
        expect(() => obligation().moveToCycle(' ', 1)).toThrowError(
            expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        );
    });
});
