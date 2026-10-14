import { describe, expect, it } from 'vitest';
import { IncomeCommitment, incomeDifference } from './income-commitment.js';
import { ResponsibilitySplit } from '../shared-expense/responsibility-split.js';

const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const receiptId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const incomeId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const registeredAt = '2026-10-14T12:00:00.000Z';

function shared() {
    return new IncomeCommitment(
        incomeId,
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        'Serviço',
        100000,
        '2026-10-20',
        a,
        registeredAt,
        {
            type: 'SHARED',
            split: ResponsibilitySplit.create(100000, [a, b], {
                mode: 'PERCENTAGES',
                shares: [
                    { memberId: a, basisPoints: 6000 },
                    { memberId: b, basisPoints: 4000 },
                ],
            }),
            expectedRecipientMemberId: b,
            settlementRuleSnapshot: null,
            settlementRuleSourceVersion: 0,
        },
    );
}

function receivedBy(memberId: string) {
    return {
        id: receiptId,
        amountInCents: 100000,
        factDate: '2026-10-14',
        registeredAt,
        recordedByPersonId: a,
        recipientPersonId: null,
        recipientMemberId: memberId,
    };
}

describe('income commitment', () => {
    it('keeps a future shared income distinct from realization and debt', () => {
        const income = shared();
        expect(income.receipt).toBeNull();
        expect(incomeDifference(income)).toBeNull();
        expect(income.expectedReceiptDate).toBe('2026-10-20');
    });

    it('owes the other member only after full receipt, independently of expectation', () => {
        const first = shared().recordReceipt(receivedBy(a), 1, '2026-10-14');
        expect(incomeDifference(first)).toEqual({
            debtorMemberId: a,
            creditorMemberId: b,
            amountInCents: 40000,
        });
        const second = shared().recordReceipt(receivedBy(b), 1, '2026-10-14');
        expect(incomeDifference(second)).toEqual({
            debtorMemberId: b,
            creditorMemberId: a,
            amountInCents: 60000,
        });
        expect(second.participation).toEqual(shared().participation);
    });

    it('rejects duplicate, stale, partial and future realizations', () => {
        const income = shared();
        const received = income.recordReceipt(receivedBy(a), 1, '2026-10-14');
        expect(() =>
            received.recordReceipt(receivedBy(a), 2, '2026-10-14'),
        ).toThrowError();
        expect(() =>
            income.recordReceipt(receivedBy(a), 2, '2026-10-14'),
        ).toThrowError();
        expect(() =>
            income.recordReceipt(
                { ...receivedBy(a), amountInCents: 50000 },
                1,
                '2026-10-14',
            ),
        ).toThrowError();
        expect(() =>
            income.recordReceipt(
                { ...receivedBy(a), factDate: '2026-10-15' },
                1,
                '2026-10-14',
            ),
        ).toThrowError();
    });
});
