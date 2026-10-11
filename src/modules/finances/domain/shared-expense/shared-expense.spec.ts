import { describe, expect, it } from 'vitest';
import {
    Money,
    ResponsibilitySplit,
    reconcileInitialObligation,
    SettlementCycle,
    FinancialCommitment,
    InterMemberObligation,
    civilDate,
} from './shared-expense.js';

const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
describe('Shared cash expense invariants', () => {
    it('validates civil date boundaries without generating a suggestion', () => {
        expect(civilDate('9999-12-31')).toBe('9999-12-31');
        expect(civilDate('0001-01-01')).toBe('0001-01-01');
        expect(civilDate('2028-02-29')).toBe('2028-02-29');
        expect(() => civilDate('0000-01-01')).toThrow();
        expect(() => civilDate('2026-02-29')).toThrow();
    });
    const create = (
        factDate = '2026-10-09',
        expected: string | null = a,
        paid = 50000,
    ) => {
        const snapshot = { kind: 'MONTHLY_DAY' as const, dayOfMonth: 31 };
        const version = {
            version: 1 as const,
            split: ResponsibilitySplit.create(50000, [a, b], {
                mode: 'AMOUNTS',
                shares: [
                    { memberId: a, amountInCents: 20000 },
                    { memberId: b, amountInCents: 30000 },
                ],
            }),
            expectedPayerMemberId: expected,
            factDate,
            settlementRuleSnapshot: snapshot,
            settlementRuleSourceVersion: 3,
            suggestedTargetDate: '2026-10-31',
        };
        const commitment = new FinancialCommitment(
            'origin',
            'space',
            'Mercado',
            'author',
            '2026-10-10T12:00:00.000Z',
            version,
            {
                id: 'payment',
                payerMemberId: b,
                method: 'DEBIT',
                amountInCents: paid,
                factDate,
                registeredAt: '2026-10-10T12:00:00.000Z',
            },
            '2026-10-10',
        );
        return { commitment, snapshot, version };
    };
    it('preserves expected payer, author and independent dates with a rule value snapshot', () => {
        const { commitment, snapshot, version } = create();
        snapshot.dayOfMonth = 10;
        version.expectedPayerMemberId = b;
        expect(
            commitment.initialVersion.settlementRuleSnapshot?.dayOfMonth,
        ).toBe(31);
        expect(commitment.initialVersion.expectedPayerMemberId).toBe(a);
        expect(commitment.disbursement.payerMemberId).toBe(b);
        expect(commitment.createdByPersonId).toBe('author');
        expect(commitment.initialVersion.factDate).toBe('2026-10-09');
        expect(Object.isFrozen(snapshot)).toBe(false);
    });
    it('preserves no expected payer without changing the disbursement', () => {
        const { commitment } = create('2026-10-09', null);
        expect(commitment.initialVersion.expectedPayerMemberId).toBeNull();
        expect(commitment.disbursement.payerMemberId).toBe(b);
    });
    it('rejects future/impossible dates, foreign planned payer and partial payments', () => {
        expect(() => create('2026-10-11')).toThrow();
        expect(() => create('2026-02-30')).toThrow();
        expect(() => create('2026-10-09', 'foreign')).toThrow();
        expect(() => create('2026-10-09', a, 20000)).toThrow();
    });
    it('keeps distinct obligations per origin with initial history', () => {
        const first = new InterMemberObligation(
            'one',
            'space',
            'origin1',
            'payment1',
            a,
            b,
            20000,
            null,
            '2026-10-09',
            '2026-10-10T12:00:00.000Z',
            'author',
        );
        const second = new InterMemberObligation(
            'two',
            'space',
            'origin2',
            'payment2',
            a,
            b,
            20000,
            null,
            '2026-10-09',
            '2026-10-10T12:00:00.000Z',
            'author',
        );
        expect(first.originCommitmentId).not.toBe(second.originCommitmentId);
        expect(first.history.type).toBe('CREATED');
        expect(first.remainingAmountInCents).toBe(20000);
        expect(
            () =>
                new InterMemberObligation(
                    'bad',
                    'space',
                    'o',
                    'p',
                    a,
                    a,
                    1,
                    null,
                    '2026-10-09',
                    'now',
                    'actor',
                ),
        ).toThrow();
    });
    it.each([
        [a, b, a, 30000],
        [b, a, b, 20000],
    ])(
        'reconciles payer %s independently of expected payer',
        (payer, debtor, creditor, amount) => {
            const split = ResponsibilitySplit.create(50000, [a, b], {
                mode: 'AMOUNTS',
                shares: [
                    { memberId: a, amountInCents: 20000 },
                    { memberId: b, amountInCents: 30000 },
                ],
            });
            expect(reconcileInitialObligation(split, payer)).toEqual({
                debtorMemberId: debtor,
                creditorMemberId: creditor,
                amountInCents: amount,
            });
        },
    );
    it.each([1, 101, Number.MAX_SAFE_INTEGER])(
        'allocates %s cents exactly with deterministic largest remainder',
        (total) => {
            const input = {
                mode: 'PERCENTAGES' as const,
                shares: [
                    { memberId: b, basisPoints: 5000 },
                    { memberId: a, basisPoints: 5000 },
                ],
            };
            const split = ResponsibilitySplit.create(total, [a, b], input);
            expect(split.shares[0].amountInCents).toBe(Math.ceil(total / 2));
            expect(split.shares[1].amountInCents).toBe(Math.floor(total / 2));
            expect(split.original).toEqual({
                ...input,
                shares: [...input.shares].reverse(),
            });
        },
    );
    it('allows a sole member and zero shares without fictitious debt', () => {
        const sole = ResponsibilitySplit.create(50000, [a], {
            mode: 'AMOUNTS',
            shares: [{ memberId: a, amountInCents: 50000 }],
        });
        expect(reconcileInitialObligation(sole, a)).toBeNull();
        const split = ResponsibilitySplit.create(50000, [a, b], {
            mode: 'AMOUNTS',
            shares: [
                { memberId: a, amountInCents: 50000 },
                { memberId: b, amountInCents: 0 },
            ],
        });
        expect(reconcileInitialObligation(split, a)).toBeNull();
        expect(reconcileInitialObligation(split, b)?.amountInCents).toBe(50000);
    });
    it('rejects unsafe money, overflow and malformed distributions', () => {
        expect(() => Money.from(Number.MAX_SAFE_INTEGER + 1)).toThrow();
        expect(() =>
            Money.from(Number.MAX_SAFE_INTEGER).add(Money.from(1)),
        ).toThrow();
        for (const shares of [
            [{ memberId: a, amountInCents: 10 }],
            [
                { memberId: a, amountInCents: 5 },
                { memberId: a, amountInCents: 5 },
            ],
            [
                { memberId: a, amountInCents: 4 },
                { memberId: b, amountInCents: 5 },
            ],
        ]) {
            expect(() =>
                ResponsibilitySplit.create(10, [a, b], {
                    mode: 'AMOUNTS',
                    shares,
                }),
            ).toThrow();
        }
    });
    it('protects finalized cycle composition', () => {
        expect(() =>
            new SettlementCycle(
                'id',
                'space',
                '2026-10-10',
                'FINALIZED',
                1,
            ).assertOpen(),
        ).toThrow();
        expect(
            () => new SettlementCycle('id', 'space', '2026-02-30', 'OPEN', 1),
        ).toThrow();
    });
});
