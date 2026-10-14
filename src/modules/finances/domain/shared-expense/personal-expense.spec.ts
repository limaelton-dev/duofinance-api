import { describe, it, expect } from 'vitest';
import {
    FinancialCommitment,
    type PersonalCommitmentVersion,
    type PersonalDisbursement,
} from './financial-commitment.js';
import { Money } from './money.js';
const owner = '00000000-0000-4000-8000-000000000001',
    now = '2026-10-14T15:00:00.000Z';
function expense(
    amount = 12000,
    overrides: Partial<PersonalCommitmentVersion> = {},
    payment: Partial<PersonalDisbursement> = {},
    description = 'Consulta',
) {
    return new FinancialCommitment<PersonalCommitmentVersion>(
        'commitment',
        'space',
        description,
        owner,
        now,
        {
            version: 1,
            ownerPersonId: owner,
            amount: Money.from(amount),
            factDate: '2026-10-14',
            ...overrides,
        },
        {
            id: 'disbursement',
            payerPersonId: owner,
            method: 'PIX',
            amountInCents: amount,
            factDate: '2026-10-14',
            registeredAt: now,
            ...payment,
        },
        '2026-10-14',
    );
}
describe('Personal FinancialCommitment', () => {
    it.each(['PIX', 'DEBIT', 'CASH'] as const)(
        'owns 100%% of the expense and distinct %s disbursement',
        (method) => {
            const c = expense(12000, {}, { method });
            expect(c.initialVersion.amount.amountInCents).toBe(12000);
            expect(c.initialVersion.ownerPersonId).toBe(owner);
            expect(c.disbursement).toMatchObject({
                id: 'disbursement',
                payerPersonId: owner,
                amountInCents: 12000,
                method,
            });
            expect(c.id).not.toBe(c.disbursement.id);
            expect(c.initialVersion).not.toHaveProperty('split');
            expect(c.disbursement).not.toHaveProperty('payerMemberId');
            expect(Object.isFrozen(c)).toBe(true);
        },
    );
    it.each([1, Number.MAX_SAFE_INTEGER])('preserves %s cents', (amount) =>
        expect(expense(amount).initialVersion.amount.amountInCents).toBe(
            amount,
        ),
    );
    it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '12000'])(
        'rejects invalid amount %s',
        (amount) => expect(() => expense(amount as number)).toThrow(),
    );
    it.each(['', ' ', 'a'.repeat(161), ' Consulta '])(
        'rejects invalid normalized description',
        (description) =>
            expect(() => expense(12000, {}, {}, description)).toThrow(),
    );
    it.each(['2026-10-15', '2026-02-30', '14/10/2026', '2026-1-01'])(
        'rejects invalid fact date %s',
        (factDate) =>
            expect(() => expense(12000, { factDate }, { factDate })).toThrow(),
    );
    it('accepts a past civil date distinct from registration', () =>
        expect(
            expense(1, { factDate: '2026-10-13' }, { factDate: '2026-10-13' })
                .registeredAt,
        ).toBe(now));
    it.each([
        { payerPersonId: 'other' },
        { amountInCents: 1 },
        { factDate: '2026-10-13' },
        { method: 'CREDIT' },
        { registeredAt: '2026-10-13T15:00:00Z' },
    ])('rejects incompatible disbursement %j', (payment) =>
        expect(() =>
            expense(12000, {}, payment as Partial<PersonalDisbursement>),
        ).toThrow(),
    );
    it('rejects responsibility owned by another person', () =>
        expect(() => expense(12000, { ownerPersonId: 'other' })).toThrow());
});
