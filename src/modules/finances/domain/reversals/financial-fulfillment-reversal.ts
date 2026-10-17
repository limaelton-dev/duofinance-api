import { FinancesError } from '../errors/finances.error.js';
import type { FinancialCorrectionState } from '../corrections/financial-correction.js';
import type { EconomicShare } from '../shared-expense/responsibility-split.js';

export type ReversibleFinancialFactKind =
    'DISBURSEMENT' | 'EXTERNAL_LIABILITY' | 'EXTERNAL_SETTLEMENT' | 'RECEIPT';

export interface FinancialFulfillmentReversal {
    id: string;
    spaceId: string;
    commitmentId: string;
    targetId: string;
    occurrenceId: string | null;
    installmentId: string | null;
    commitmentVersion: number;
    originalKind: ReversibleFinancialFactKind;
    originalId: string;
    amountInCents: number;
    reason: string;
    factDate: string;
    actorId: string;
    registeredAt: string;
}

export interface ReversibleFinancialFact {
    id: string;
    kind: ReversibleFinancialFactKind;
    amountInCents: number;
    factDate: string;
    registeredAt: string;
    recordedByPersonId: string;
    memberId: string | null;
    personId: string | null;
    externalLiabilityId: string | null;
    occurrenceId: string | null;
    installmentId: string | null;
}

export interface FinancialFulfillmentReversalState {
    origin: FinancialCorrectionState;
    original: ReversibleFinancialFact;
    reversals: readonly FinancialFulfillmentReversal[];
    reversibleAmountInCents: number;
    blockingGlobalPayoffId?: string | null;
    externalLiability: {
        id: string;
        originalAmountInCents: number;
        validAmountInCents: number;
        validSettledAmountInCents: number;
        remainingAmountInCents: number;
    } | null;
    globalPayoff: {
        id: string;
        factId: string;
        paidAmountInCents: number;
        adjustmentInCents: number;
        economicShares: readonly EconomicShare[] | null;
        resolutionInstallmentIds: readonly string[];
        fullyReversed: boolean;
    } | null;
}

export function reversedFinancialAmount(
    reversals: readonly FinancialFulfillmentReversal[],
    originalKind: ReversibleFinancialFactKind,
    originalId: string,
): number {
    const total = reversals
        .filter(
            (reversal) =>
                reversal.originalKind === originalKind &&
                reversal.originalId === originalId,
        )
        .reduce((sum, reversal) => sum + BigInt(reversal.amountInCents), 0n);
    if (total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER))
        throw new FinancesError('VALIDATION_ERROR', ['amountInCents']);
    return Number(total);
}

export function validFinancialAmount(
    originalAmount: number,
    reversals: readonly FinancialFulfillmentReversal[],
    originalKind: ReversibleFinancialFactKind,
    originalId: string,
): number {
    const result =
        originalAmount -
        reversedFinancialAmount(reversals, originalKind, originalId);
    if (!Number.isSafeInteger(result) || result < 0)
        throw new FinancesError('VALIDATION_ERROR', ['amountInCents']);
    return result;
}

export function assertFinancialReversalHistory(
    reversals: readonly FinancialFulfillmentReversal[],
    originals: readonly {
        id: string;
        kind: ReversibleFinancialFactKind;
        amountInCents: number;
    }[],
    spaceId: string,
    commitmentId: string,
) {
    if (
        new Set(reversals.map((reversal) => reversal.id)).size !==
        reversals.length
    )
        throw new FinancesError('VALIDATION_ERROR');
    for (const reversal of reversals) {
        const original = originals.find(
            (fact) =>
                fact.id === reversal.originalId &&
                fact.kind === reversal.originalKind,
        );
        if (
            !original ||
            reversal.spaceId !== spaceId ||
            reversal.commitmentId !== commitmentId ||
            !Number.isSafeInteger(reversal.amountInCents) ||
            reversal.amountInCents < 1 ||
            !reversal.actorId ||
            !reversal.reason.trim() ||
            !Number.isFinite(Date.parse(reversal.registeredAt))
        )
            throw new FinancesError('VALIDATION_ERROR');
        validFinancialAmount(
            original.amountInCents,
            reversals,
            original.kind,
            original.id,
        );
    }
}

export function validateFinancialReversal(
    state: FinancialFulfillmentReversalState,
    amountInCents: number,
) {
    if (!Number.isSafeInteger(amountInCents) || amountInCents < 1)
        throw new FinancesError('VALIDATION_ERROR', ['amountInCents']);
    if (amountInCents > state.reversibleAmountInCents)
        throw new FinancesError('FINANCIAL_REVERSAL_EXCEEDS_AVAILABLE');
    if (state.blockingGlobalPayoffId)
        throw new FinancesError('FINANCIAL_REVERSAL_FULL_REQUIRED');
    if (state.globalPayoff && amountInCents !== state.reversibleAmountInCents)
        throw new FinancesError('FINANCIAL_REVERSAL_FULL_REQUIRED');
    const external = state.externalLiability;
    if (
        state.original.kind === 'EXTERNAL_LIABILITY' &&
        external &&
        external.validAmountInCents - amountInCents <
            external.validSettledAmountInCents
    )
        throw new FinancesError('FINANCIAL_REVERSAL_SETTLEMENT_REQUIRED');
    return {
        remainingReversibleAmountInCents:
            state.reversibleAmountInCents - amountInCents,
        externalRemainingAmountInCentsAfter: external
            ? external.remainingAmountInCents +
              (state.original.kind === 'EXTERNAL_SETTLEMENT'
                  ? amountInCents
                  : state.original.kind === 'EXTERNAL_LIABILITY'
                    ? -amountInCents
                    : 0)
            : null,
    };
}
