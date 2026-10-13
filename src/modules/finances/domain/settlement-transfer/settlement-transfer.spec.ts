import { describe, expect, it } from 'vitest';
import { FinancesError } from '../errors/finances.error.js';
import { InterMemberObligation } from '../shared-expense/inter-member-obligation.js';
import { SettlementTransfer } from './settlement-transfer.js';

const obligation = () =>
    new InterMemberObligation(
        'obligation',
        'space',
        'commitment',
        'disbursement',
        'debtor',
        'creditor',
        20000,
        null,
        '2026-10-01',
        '2026-10-01T10:00:00.000Z',
        'author',
    );
describe('manual settlement transfer domain', () => {
    it('applies a partial then a total transfer while preserving identity and origin', () => {
        const original = obligation();
        const partial = original.applySettlement('allocation-1', 7000, 1);
        const settled = partial.applySettlement('allocation-2', 13000, 2);
        expect(original.remainingAmountInCents).toBe(20000);
        expect(partial).toMatchObject({
            status: 'PARTIALLY_SETTLED',
            remainingAmountInCents: 13000,
            version: 2,
        });
        expect(settled).toMatchObject({
            status: 'SETTLED',
            remainingAmountInCents: 0,
            version: 3,
            originCommitmentId: 'commitment',
            originDisbursementId: 'disbursement',
        });
        expect(settled.appliedAllocationIds).toEqual([
            'allocation-1',
            'allocation-2',
        ]);
    });
    it('rejects reapplication, excess and obsolete version', () => {
        const partial = obligation().applySettlement('allocation-1', 7000, 1);
        expect(() =>
            partial.applySettlement('allocation-1', 1, 2),
        ).toThrowError(FinancesError);
        expect(() =>
            partial.applySettlement('allocation-2', 13001, 2),
        ).toThrowError(FinancesError);
        expect(() =>
            partial.applySettlement('allocation-2', 1, 1),
        ).toThrowError(FinancesError);
    });
    it('requires an exact positive distribution and distinct participants', () => {
        const allocation = (amountInCents: number) => [
            { id: 'a', obligationId: 'o', cycleId: null, amountInCents },
        ];
        expect(
            () =>
                new SettlementTransfer(
                    't',
                    's',
                    'payer',
                    'recipient',
                    7000,
                    '2026-10-01',
                    '2026-10-01T10:00:00.000Z',
                    'actor',
                    allocation(6999),
                ),
        ).toThrowError(FinancesError);
        expect(
            () =>
                new SettlementTransfer(
                    't',
                    's',
                    'payer',
                    'payer',
                    7000,
                    '2026-10-01',
                    '2026-10-01T10:00:00.000Z',
                    'actor',
                    allocation(7000),
                ),
        ).toThrowError(FinancesError);
        expect(
            () =>
                new SettlementTransfer(
                    't',
                    's',
                    'payer',
                    'recipient',
                    0,
                    '2026-10-01',
                    '2026-10-01T10:00:00.000Z',
                    'actor',
                    allocation(0),
                ),
        ).toThrowError(FinancesError);
        expect(
            () =>
                new SettlementTransfer(
                    't',
                    's',
                    'payer',
                    'recipient',
                    7000,
                    '2026-10-01',
                    '2026-10-01T10:00:00.000Z',
                    'actor',
                    [...allocation(3500), ...allocation(3500)],
                ),
        ).toThrowError(FinancesError);
    });
});
