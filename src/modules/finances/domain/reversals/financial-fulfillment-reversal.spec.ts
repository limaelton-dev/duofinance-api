import { describe, expect, it } from 'vitest';
import type { FinancialCorrectionState } from '../corrections/financial-correction.js';
import {
    assertFinancialReversalHistory,
    reversedFinancialAmount,
    validFinancialAmount,
    validateFinancialReversal,
    type FinancialFulfillmentReversal,
    type FinancialFulfillmentReversalState,
} from './financial-fulfillment-reversal.js';

const origin: FinancialCorrectionState = {
    id: 'root',
    spaceId: 'space',
    kind: 'EXPENSE',
    modality: 'ONE_TIME',
    description: 'Compra',
    createdByPersonId: 'person',
    registeredAt: '2026-10-14T15:00:00Z',
    version: 1,
    personal: true,
    targetId: 'root',
    referenceDate: null,
    occurrenceId: null,
    installmentId: null,
    occurrenceVersion: 1,
    economicVersion: 1,
    projected: false,
    cancelled: false,
    resolved: false,
    originalAmountInCents: 50000,
    amountInCents: 50000,
    fulfilledAmountInCents: 50000,
    shares: null,
    distribution: null,
    expectedMemberId: null,
    settlementRuleSnapshot: null,
    settlementRuleSourceVersion: 0,
    facts: [],
    adjustments: [],
    cancellation: null,
    reversals: [],
};
const state = (
    extra: Partial<FinancialFulfillmentReversalState> = {},
): FinancialFulfillmentReversalState => ({
    origin,
    original: {
        id: 'payment',
        kind: 'DISBURSEMENT',
        amountInCents: 50000,
        factDate: '2026-10-14',
        registeredAt: '2026-10-14T15:00:00Z',
        recordedByPersonId: 'person',
        memberId: null,
        personId: 'person',
        externalLiabilityId: null,
        occurrenceId: null,
        installmentId: null,
    },
    reversals: [],
    reversibleAmountInCents: 50000,
    externalLiability: null,
    globalPayoff: null,
    ...extra,
});
const reversal = (
    extra: Partial<FinancialFulfillmentReversal> = {},
): FinancialFulfillmentReversal => ({
    id: 'reversal',
    spaceId: 'space',
    commitmentId: 'root',
    targetId: 'root',
    occurrenceId: null,
    installmentId: null,
    commitmentVersion: 2,
    originalKind: 'DISBURSEMENT',
    originalId: 'payment',
    amountInCents: 10000,
    reason: 'Correção',
    factDate: '2026-10-14',
    actorId: 'person',
    registeredAt: '2026-10-14T15:00:00Z',
    ...extra,
});
const originals = [
    { id: 'payment', kind: 'DISBURSEMENT' as const, amountInCents: 50000 },
];

describe('financial fulfillment reversal invariants', () => {
    it('retains the original and sums only compensations for its exact kind and identity', () => {
        const history = [
            reversal(),
            reversal({ id: 'second', amountInCents: 20000 }),
            reversal({
                id: 'other',
                originalId: 'another',
                amountInCents: 30000,
            }),
            reversal({
                id: 'receipt',
                originalKind: 'RECEIPT',
                amountInCents: 40000,
            }),
        ];
        expect(
            reversedFinancialAmount(history, 'DISBURSEMENT', 'payment'),
        ).toBe(30000);
        expect(
            validFinancialAmount(50000, history, 'DISBURSEMENT', 'payment'),
        ).toBe(20000);
        expect(originals[0].amountInCents).toBe(50000);
    });

    it('allows partial and integral compensation while bounding the remaining available amount', () => {
        expect(validateFinancialReversal(state(), 20000)).toEqual({
            remainingReversibleAmountInCents: 30000,
            externalRemainingAmountInCentsAfter: null,
        });
        expect(
            validateFinancialReversal(
                state({ reversibleAmountInCents: 30000 }),
                30000,
            ).remainingReversibleAmountInCents,
        ).toBe(0);
        expect(() =>
            validateFinancialReversal(
                state({ reversibleAmountInCents: 30000 }),
                30001,
            ),
        ).toThrow(
            expect.objectContaining({
                code: 'FINANCIAL_REVERSAL_EXCEEDS_AVAILABLE',
            }),
        );
        expect(() =>
            validateFinancialReversal(state({ reversibleAmountInCents: 0 }), 1),
        ).toThrow(
            expect.objectContaining({
                code: 'FINANCIAL_REVERSAL_EXCEEDS_AVAILABLE',
            }),
        );
    });

    it('never reduces an external principal below its valid settlements', () => {
        const input = state();
        const external = state({
            original: {
                ...input.original,
                kind: 'EXTERNAL_LIABILITY',
                externalLiabilityId: 'payment',
            },
            externalLiability: {
                id: 'payment',
                originalAmountInCents: 50000,
                validAmountInCents: 50000,
                validSettledAmountInCents: 20000,
                remainingAmountInCents: 30000,
            },
        });
        expect(validateFinancialReversal(external, 30000)).toEqual({
            remainingReversibleAmountInCents: 20000,
            externalRemainingAmountInCentsAfter: 0,
        });
        expect(() => validateFinancialReversal(external, 30001)).toThrow(
            expect.objectContaining({
                code: 'FINANCIAL_REVERSAL_SETTLEMENT_REQUIRED',
            }),
        );
        expect(() => validateFinancialReversal(external, 50000)).toThrow(
            expect.objectContaining({
                code: 'FINANCIAL_REVERSAL_SETTLEMENT_REQUIRED',
            }),
        );
    });

    it('reopens the corresponding external balance without mutating realization when a settlement is reversed', () => {
        const input = state();
        const external = state({
            original: {
                ...input.original,
                id: 'settlement',
                kind: 'EXTERNAL_SETTLEMENT',
                amountInCents: 20000,
                externalLiabilityId: 'liability',
            },
            reversibleAmountInCents: 20000,
            externalLiability: {
                id: 'liability',
                originalAmountInCents: 50000,
                validAmountInCents: 50000,
                validSettledAmountInCents: 20000,
                remainingAmountInCents: 30000,
            },
        });
        const result = validateFinancialReversal(external, 20000);
        expect(result.externalRemainingAmountInCentsAfter).toBe(50000);
        expect(external.origin.fulfilledAmountInCents).toBe(50000);
        expect(external.externalLiability!.remainingAmountInCents).toBe(30000);
    });

    it('requires an indivisible global payoff to be compensated in full', () => {
        const global = state({
            globalPayoff: {
                id: 'payoff',
                factId: 'payment',
                paidAmountInCents: 50000,
                adjustmentInCents: -2000,
                economicShares: null,
                resolutionInstallmentIds: ['first', 'second'],
                fullyReversed: false,
            },
        });
        expect(() => validateFinancialReversal(global, 25000)).toThrow(
            expect.objectContaining({
                code: 'FINANCIAL_REVERSAL_FULL_REQUIRED',
            }),
        );
        expect(
            validateFinancialReversal(global, 50000)
                .remainingReversibleAmountInCents,
        ).toBe(0);
        expect(global.globalPayoff!.adjustmentInCents).toBe(-2000);
    });

    it('blocks reversal of a preexisting installment payment while its global payoff resolution is active', () => {
        const resolved = state({ blockingGlobalPayoffId: 'global-payoff' });
        expect(() => validateFinancialReversal(resolved, 1000)).toThrow(
            expect.objectContaining({
                code: 'FINANCIAL_REVERSAL_FULL_REQUIRED',
            }),
        );
        expect(() => validateFinancialReversal(resolved, 50000)).toThrow(
            expect.objectContaining({
                code: 'FINANCIAL_REVERSAL_FULL_REQUIRED',
            }),
        );
        expect(
            validateFinancialReversal(
                state({ blockingGlobalPayoffId: null }),
                1000,
            ).remainingReversibleAmountInCents,
        ).toBe(49000);
    });

    it('rejects duplicate reversal identities and mismatched original kind or identity', () => {
        expect(() =>
            assertFinancialReversalHistory(
                [reversal(), reversal()],
                originals,
                'space',
                'root',
            ),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
        expect(() =>
            assertFinancialReversalHistory(
                [reversal({ originalId: 'missing' })],
                originals,
                'space',
                'root',
            ),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
        expect(() =>
            assertFinancialReversalHistory(
                [reversal({ originalKind: 'RECEIPT' })],
                originals,
                'space',
                'root',
            ),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    });

    it('isolates history by commitment and space and rejects cumulative overcompensation', () => {
        expect(() =>
            assertFinancialReversalHistory(
                [reversal({ spaceId: 'another' })],
                originals,
                'space',
                'root',
            ),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
        expect(() =>
            assertFinancialReversalHistory(
                [reversal({ commitmentId: 'another' })],
                originals,
                'space',
                'root',
            ),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
        expect(() =>
            assertFinancialReversalHistory(
                [
                    reversal({ amountInCents: 30000 }),
                    reversal({ id: 'second', amountInCents: 20001 }),
                ],
                originals,
                'space',
                'root',
            ),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
        expect(() =>
            assertFinancialReversalHistory(
                [
                    reversal({ amountInCents: 30000 }),
                    reversal({ id: 'second', amountInCents: 20000 }),
                ],
                originals,
                'space',
                'root',
            ),
        ).not.toThrow();
    });

    it.each([
        0,
        -1,
        0.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
    ])('rejects invalid cents %s', (amount) => {
        expect(() => validateFinancialReversal(state(), amount)).toThrow(
            expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        );
        expect(() =>
            assertFinancialReversalHistory(
                [reversal({ amountInCents: amount })],
                originals,
                'space',
                'root',
            ),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    });

    it('keeps arithmetic exact at the safe integer boundary and rejects aggregate overflow', () => {
        expect(
            validateFinancialReversal(
                state({ reversibleAmountInCents: Number.MAX_SAFE_INTEGER }),
                Number.MAX_SAFE_INTEGER,
            ).remainingReversibleAmountInCents,
        ).toBe(0);
        const maximum = reversal({ amountInCents: Number.MAX_SAFE_INTEGER });
        expect(
            reversedFinancialAmount([maximum], 'DISBURSEMENT', 'payment'),
        ).toBe(Number.MAX_SAFE_INTEGER);
        expect(() =>
            reversedFinancialAmount(
                [maximum, reversal({ id: 'second', amountInCents: 1 })],
                'DISBURSEMENT',
                'payment',
            ),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    });
});
