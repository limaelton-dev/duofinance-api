import { describe, expect, it } from 'vitest';
import {
    FinancialCommitment,
    type PersonalCommitmentVersion,
} from './financial-commitment.js';
import { ResponsibilitySplit } from './responsibility-split.js';
import { Money } from './money.js';
import {
    expenseDifference,
    planObligationReconciliation,
} from './obligation-reconciler.js';
import {
    IncomeCommitment,
    incomeDifference,
} from '../income/income-commitment.js';
import { InterMemberObligation } from './inter-member-obligation.js';
const a = 'a',
    b = 'b',
    today = '2026-10-15',
    now = '2026-10-15T12:00:00.000Z';
function split(total = 50000) {
    return ResponsibilitySplit.create(total, [a, b], {
        mode: 'PERCENTAGES',
        shares: [
            { memberId: a, basisPoints: 6000 },
            { memberId: b, basisPoints: 4000 },
        ],
    });
}
function receipt(id: string, member: string, amountInCents: number) {
    return {
        id,
        amountInCents,
        factDate: today,
        registeredAt: now,
        recordedByPersonId: 'author',
        recipientPersonId: null,
        recipientMemberId: member,
    };
}
function income(total = 100000) {
    return new IncomeCommitment(
        'income',
        'space',
        'Serviço',
        total,
        today,
        'author',
        now,
        {
            type: 'SHARED',
            split: split(total),
            expectedRecipientMemberId: b,
            settlementRuleSnapshot: null,
            settlementRuleSourceVersion: 0,
        },
    );
}
function personal() {
    return new FinancialCommitment<PersonalCommitmentVersion>(
        'expense',
        'space',
        'Consulta',
        'owner',
        now,
        {
            version: 1,
            ownerPersonId: 'owner',
            amount: Money.from(100000),
            factDate: today,
        },
        {
            id: 'one',
            amountInCents: 30000,
            payerPersonId: 'owner',
            method: 'PIX',
            factDate: today,
            registeredAt: now,
        },
        today,
    );
}
describe('Partial financial fulfillment', () => {
    it('plans closing the old episode before creating an opposite residual', () => {
        const old = new InterMemberObligation(
            'old',
            'space',
            'income',
            'one',
            a,
            b,
            20000,
            null,
            today,
            now,
            'author',
        );
        const difference = {
            debtorMemberId: b,
            creditorMemberId: a,
            amountInCents: 10000,
        };
        expect(planObligationReconciliation([old], difference)).toEqual({
            reusedObligation: null,
            changes: [{ obligation: old, remainingAmountInCents: 0 }],
            newDifference: difference,
        });
    });
    it('plans same-direction growth by reusing the original episode', () => {
        const old = new InterMemberObligation(
            'old',
            'space',
            'income',
            'one',
            a,
            b,
            10000,
            'cycle',
            today,
            now,
            'author',
        );
        expect(
            planObligationReconciliation([old], {
                debtorMemberId: a,
                creditorMemberId: b,
                amountInCents: 20000,
            }),
        ).toEqual({
            reusedObligation: old,
            changes: [{ obligation: old, remainingAmountInCents: 20000 }],
            newDifference: null,
        });
    });
    it('plans closure when the accumulated position reaches zero', () => {
        const old = new InterMemberObligation(
            'old',
            'space',
            'income',
            'one',
            a,
            b,
            10000,
            null,
            today,
            now,
            'author',
        );
        expect(planObligationReconciliation([old], null)).toEqual({
            reusedObligation: null,
            changes: [{ obligation: old, remainingAmountInCents: 0 }],
            newDifference: null,
        });
    });
    it('reuses a settled same-direction episode but preserves a reconciled historical episode', () => {
        const old = new InterMemberObligation(
            'old',
            'space',
            'income',
            'one',
            a,
            b,
            10000,
            null,
            today,
            now,
            'author',
        );
        const difference = {
            debtorMemberId: a,
            creditorMemberId: b,
            amountInCents: 5000,
        };
        const settled = old.applySettlement('allocation', 10000, 1);
        expect(
            planObligationReconciliation([settled], difference)
                .reusedObligation,
        ).toBe(settled);
        const reconciled = old.reconcile(0, 'author', 'two', now);
        expect(planObligationReconciliation([reconciled], difference)).toEqual({
            reusedObligation: null,
            changes: [],
            newDifference: difference,
        });
    });
    it('refuses to merge different origins or reconcile simultaneous open episodes', () => {
        const first = new InterMemberObligation(
            'first',
            'space',
            'income',
            'one',
            a,
            b,
            10000,
            null,
            today,
            now,
            'author',
        );
        const other = new InterMemberObligation(
            'other',
            'space',
            'different',
            'two',
            b,
            a,
            10000,
            null,
            today,
            now,
            'author',
        );
        expect(() =>
            planObligationReconciliation([first, other], null),
        ).toThrow();
        expect(() =>
            planObligationReconciliation([first, first], null),
        ).toThrow();
        expect(planObligationReconciliation([], null)).toEqual({
            reusedObligation: null,
            changes: [],
            newDifference: null,
        });
    });
    it('preserves the original income participation and rule snapshot independently of mutable input', () => {
        const snapshot = { kind: 'MONTHLY_DAY' as const, dayOfMonth: 20 };
        const participation = {
            type: 'SHARED' as const,
            split: split(100000),
            expectedRecipientMemberId: b,
            settlementRuleSnapshot: snapshot,
            settlementRuleSourceVersion: 1,
        };
        const pending = new IncomeCommitment(
            'income',
            'space',
            'Receita',
            100000,
            today,
            'author',
            now,
            participation,
        );
        participation.expectedRecipientMemberId = a;
        snapshot.dayOfMonth = 30;
        const received = pending.recordReceipt(
            receipt('one', a, 50000),
            1,
            today,
        );
        expect(received.participation).toMatchObject({
            expectedRecipientMemberId: b,
            settlementRuleSnapshot: { dayOfMonth: 20 },
        });
        expect(Object.isFrozen(received.participation)).toBe(true);
    });
    it('preserves the original commitment while accumulating personal payments and retroactive facts', () => {
        const first = personal();
        const second = first.recordDisbursement(
            {
                ...first.disbursement!,
                id: 'two',
                amountInCents: 20000,
                factDate: '2026-10-13',
            },
            1,
            today,
        );
        const last = second.recordDisbursement(
            { ...first.disbursement!, id: 'three', amountInCents: 50000 },
            2,
            today,
        );
        expect(first.remainingAmountInCents).toBe(70000);
        expect(second).toMatchObject({
            paidAmountInCents: 50000,
            remainingAmountInCents: 50000,
            status: 'PARTIALLY_PAID',
            version: 2,
        });
        expect(last).toMatchObject({
            paidAmountInCents: 100000,
            remainingAmountInCents: 0,
            status: 'PAID',
            version: 3,
        });
        expect(last.initialVersion).toEqual(first.initialVersion);
        expect(last.disbursements.map((f) => f.id)).toEqual([
            'one',
            'two',
            'three',
        ]);
        expect(last.disbursements[1].factDate).toBe('2026-10-13');
        expect(last.disbursement!.id).toBe('one');
        expect(
            last.disbursements.every((f) => f.recordedByPersonId === 'owner'),
        ).toBe(true);
        expect(() =>
            last.recordDisbursement(
                { ...first.disbursement!, id: 'four', amountInCents: 1 },
                3,
                today,
            ),
        ).toThrow();
    });
    it.each([0, -1, 0.5, 70001, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
        'rejects invalid payment %s',
        (amountInCents) => {
            const first = personal();
            expect(() =>
                first.recordDisbursement(
                    { ...first.disbursement!, id: 'two', amountInCents },
                    1,
                    today,
                ),
            ).toThrow();
        },
    );
    it('rejects a stale version, future fact, duplicate identity and another personal payer', () => {
        const first = personal(),
            payment = { ...first.disbursement!, id: 'two', amountInCents: 1 };
        expect(() => first.recordDisbursement(payment, 2, today)).toThrow();
        expect(() =>
            first.recordDisbursement(
                { ...payment, factDate: '2026-10-16' },
                1,
                today,
            ),
        ).toThrow();
        expect(() =>
            first.recordDisbursement({ ...payment, id: 'one' }, 1, today),
        ).toThrow();
        expect(() =>
            first.recordDisbursement(
                { ...payment, payerPersonId: 'other' },
                1,
                today,
            ),
        ).toThrow();
    });
    it.each([
        [10000, 0],
        [30000, 0],
        [40000, 10000],
        [50000, 20000],
    ])(
        'compares accumulated support %s against original responsibility',
        (paid, owed) => {
            expect(
                expenseDifference(split(), [
                    { payerMemberId: a, amountInCents: paid },
                ]),
            ).toEqual(
                owed
                    ? {
                          debtorMemberId: b,
                          creditorMemberId: a,
                          amountInCents: owed,
                      }
                    : null,
            );
        },
    );
    it('considers both payers and previous settlements without scaling original responsibility', () => {
        expect(
            expenseDifference(split(), [
                { payerMemberId: a, amountInCents: 35000 },
                { payerMemberId: b, amountInCents: 15000 },
            ])?.amountInCents,
        ).toBe(5000);
        expect(
            expenseDifference(
                split(),
                [{ payerMemberId: a, amountInCents: 50000 }],
                [
                    {
                        payerMemberId: b,
                        recipientMemberId: a,
                        amountInCents: 4000,
                    },
                ],
            )?.amountInCents,
        ).toBe(16000);
    });
    it('recomputes revenue over the accumulated receipts and inverts direction', () => {
        const first = income().recordReceipt(
            receipt('one', a, 50000),
            1,
            today,
        );
        expect(first).toMatchObject({
            receivedAmountInCents: 50000,
            remainingAmountInCents: 50000,
            status: 'PARTIALLY_RECEIVED',
        });
        expect(incomeDifference(first)).toEqual({
            debtorMemberId: a,
            creditorMemberId: b,
            amountInCents: 20000,
        });
        const last = first.recordReceipt(receipt('two', b, 50000), 2, today);
        expect(incomeDifference(last)).toEqual({
            debtorMemberId: b,
            creditorMemberId: a,
            amountInCents: 10000,
        });
        expect(last.receipt!.id).toBe('one');
        expect(last.receipts).toHaveLength(2);
        expect(
            incomeDifference(last, [
                { payerMemberId: a, recipientMemberId: b, amountInCents: 5000 },
            ])?.amountInCents,
        ).toBe(15000);
        expect(
            incomeDifference(last, [
                {
                    payerMemberId: a,
                    recipientMemberId: b,
                    amountInCents: 20000,
                },
            ])?.amountInCents,
        ).toBe(30000);
    });
    it('allows personal income in three receipts without a fictitious member', () => {
        let c = new IncomeCommitment(
            'personal',
            'space',
            'Receita',
            100000,
            today,
            'owner',
            now,
            { type: 'PERSONAL', ownerPersonId: 'owner' },
        );
        for (const [i, amount] of [30000, 20000, 50000].entries())
            c = c.recordReceipt(
                {
                    ...receipt(`r${i}`, a, amount),
                    recordedByPersonId: 'owner',
                    recipientPersonId: 'owner',
                    recipientMemberId: null,
                },
                i + 1,
                today,
            );
        expect(c).toMatchObject({
            status: 'RECEIVED',
            receivedAmountInCents: 100000,
            remainingAmountInCents: 0,
            version: 4,
        });
        expect(incomeDifference(c)).toBeNull();
    });
    it('does not create a revenue debt when received matches participation', () => {
        const first = income().recordReceipt(
            receipt('one', a, 60000),
            1,
            today,
        );
        expect(
            incomeDifference(
                first.recordReceipt(receipt('two', b, 40000), 2, today),
            ),
        ).toBeNull();
    });
    it.each([1, 3, 101, Number.MAX_SAFE_INTEGER])(
        'allocates %s cents precisely using original weights',
        (total) => {
            for (const mode of ['PERCENTAGES', 'AMOUNTS'] as const) {
                const initial = split(total);
                const allocation =
                    mode === 'PERCENTAGES'
                        ? initial
                        : ResponsibilitySplit.create(total, [a, b], {
                              mode,
                              shares: initial.shares.map((s) => ({ ...s })),
                          });
                for (const realized of [0, 1, Math.floor(total / 2), total]) {
                    const shares = allocation.realizedShares(realized);
                    expect(
                        shares.reduce(
                            (sum, s) => sum + BigInt(s.amountInCents),
                            0n,
                        ),
                    ).toBe(BigInt(realized));
                    if (realized === total)
                        expect(shares).toEqual(allocation.shares);
                }
            }
        },
    );
    it('rounds revenue participation once for the accumulated total', () => {
        const c = income(3)
            .recordReceipt(receipt('one', a, 1), 1, today)
            .recordReceipt(receipt('two', a, 1), 2, today);
        expect(
            c.participation.type === 'SHARED' &&
                c.participation.split
                    .realizedShares(2)
                    .map((s) => s.amountInCents),
        ).toEqual([1, 1]);
        expect(incomeDifference(c)?.amountInCents).toBe(1);
    });
    it('grows and reconciles an obligation without changing original amount or creating transfers', () => {
        const obligation = new InterMemberObligation(
            'o',
            'space',
            'income',
            'one',
            a,
            b,
            20000,
            'cycle',
            today,
            now,
            'author',
            undefined,
            undefined,
            undefined,
            'INCOME',
        );
        const settled = obligation.applySettlement('allocation', 5000, 1);
        const grown = settled.reconcile(25000, 'other', 'two', now);
        expect(grown).toMatchObject({
            originalAmountInCents: 20000,
            recognizedAmountInCents: 30000,
            remainingAmountInCents: 25000,
            cycleId: 'cycle',
            status: 'PARTIALLY_SETTLED',
            appliedAllocationIds: ['allocation'],
        });
        const closed = grown.reconcile(0, 'author', 'three', now);
        expect(closed).toMatchObject({
            status: 'RECONCILED',
            recognizedAmountInCents: 5000,
            remainingAmountInCents: 0,
        });
        expect(closed.reconciliation).toMatchObject({
            causeFulfillmentId: 'three',
            previousRemainingAmountInCents: 25000,
            remainingAmountInCents: 0,
        });
        expect(Object.isFrozen(closed.reconciliation)).toBe(true);
    });
});
