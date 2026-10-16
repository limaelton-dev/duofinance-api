import { describe, expect, it } from 'vitest';
import { InterMemberObligation } from './inter-member-obligation.js';
import { ObligationWaiver } from './obligation-waiver.js';

const date = '2026-10-16';
const now = '2026-10-16T15:00:00.000Z';
const obligation = () =>
    new InterMemberObligation(
        'obligation',
        'space',
        'expense',
        'payment',
        'debtor',
        'creditor',
        10000,
        'cycle',
        '2026-10-01',
        now,
        'author',
    );
const waiver = (amount: number, reason: string | null = null) =>
    new ObligationWaiver(
        'waiver',
        'obligation',
        'creditor',
        amount,
        date,
        now,
        'creditor-person',
        reason,
    );

describe('Creditor waiver preserves the economic origin', () => {
    it('reduces only the open amount and records a total waiver separately from settlement', () => {
        const paid = obligation().applySettlement('cash-allocation', 2000, 1);
        const partial = paid.waive(waiver(3000), 'creditor', 2);
        const waived = partial.waive(
            waiver(5000, '  decisão do credor  '),
            'creditor',
            3,
        );
        expect(partial).toMatchObject({
            status: 'PARTIALLY_SETTLED',
            remainingAmountInCents: 5000,
            version: 3,
        });
        expect(waived).toMatchObject({
            status: 'WAIVED',
            remainingAmountInCents: 0,
            version: 4,
            waived: true,
            originalAmountInCents: 10000,
            recognizedAmountInCents: 10000,
            originCommitmentId: 'expense',
            originDisbursementId: 'payment',
            factDate: '2026-10-01',
            cycleId: 'cycle',
            appliedAllocationIds: ['cash-allocation'],
        });
        expect(waived.history).toEqual(paid.history);
        expect(paid.remainingAmountInCents).toBe(8000);
        expect(waiver(5000, '  decisão do credor  ').reason).toBe(
            'decisão do credor',
        );
        expect(waiver(1).reason).toBeNull();
        expect(Object.isFrozen(waived)).toBe(true);
    });
    it('permits only the creditor to waive and validates the target identity', () => {
        expect(() => obligation().waive(waiver(1), 'debtor', 1)).toThrowError(
            expect.objectContaining({ code: 'OBLIGATION_CREDITOR_REQUIRED' }),
        );
        const foreign = new ObligationWaiver(
            'waiver',
            'other-obligation',
            'creditor',
            1,
            date,
            now,
            'author',
        );
        expect(() => obligation().waive(foreign, 'creditor', 1)).toThrowError(
            expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        );
    });
    it('rejects stale, excessive and repeated waivers', () => {
        expect(() => obligation().waive(waiver(1), 'creditor', 2)).toThrowError(
            expect.objectContaining({ code: 'CONCURRENT_MODIFICATION' }),
        );
        expect(() =>
            obligation().waive(waiver(10001), 'creditor', 1),
        ).toThrowError(
            expect.objectContaining({ code: 'CONCURRENT_MODIFICATION' }),
        );
        expect(() =>
            obligation()
                .waive(waiver(10000), 'creditor', 1)
                .waive(waiver(1), 'creditor', 2),
        ).toThrowError(
            expect.objectContaining({ code: 'CONCURRENT_MODIFICATION' }),
        );
    });
    it('keeps later cash settlement distinct from a previous partial waiver', () => {
        const partial = obligation().waive(waiver(3000), 'creditor', 1);
        const settled = partial.applySettlement('cash-allocation', 7000, 2);
        expect(settled.status).toBe('SETTLED');
        expect(settled.waived).toBe(false);
    });
    it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
        'rejects invalid waiver amount %s',
        (amount) => {
            expect(() => waiver(amount)).toThrowError(
                expect.objectContaining({ code: 'VALIDATION_ERROR' }),
            );
        },
    );
    it('keeps the creditor reason optional and bounded', () => {
        expect(waiver(1, '   ').reason).toBeNull();
        expect(() => waiver(1, 'a'.repeat(501))).toThrowError(
            expect.objectContaining({
                code: 'VALIDATION_ERROR',
                fields: ['reason'],
            }),
        );
    });
});
