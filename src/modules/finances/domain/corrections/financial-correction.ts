import { FinancesError } from '../errors/finances.error.js';
import { Money } from '../shared-expense/money.js';
import {
    ResponsibilitySplit,
    type EconomicShare,
    type SplitInput,
} from '../shared-expense/responsibility-split.js';
import type { SettlementRuleSnapshot } from '../settlement-rule/settlement-rule.js';
import type { OccurrenceFact } from '../recurrence/financial-occurrence.js';

export interface FinancialAdjustment {
    id: string;
    spaceId: string;
    commitmentId: string;
    targetId: string;
    occurrenceId: string | null;
    installmentId: string | null;
    commitmentVersion: number;
    direction: 'INCREASE' | 'DECREASE';
    amountInCents: number;
    reason: string;
    factDate: string;
    actorId: string;
    registeredAt: string;
    previousAmountInCents: number;
    resultingAmountInCents: number;
    economicShares: readonly EconomicShare[] | null;
    shareChanges: readonly { memberId: string; amountInCents: number }[] | null;
    proposalId: string | null;
}

export interface FinancialCancellation {
    id: string;
    spaceId: string;
    commitmentId: string;
    commitmentVersion: number;
    reason: string;
    factDate: string;
    actorId: string;
    registeredAt: string;
}

export interface FinancialCorrectionState {
    id: string;
    spaceId: string;
    kind: 'EXPENSE' | 'INCOME';
    modality: 'ONE_TIME' | 'RECURRING' | 'INSTALLMENT';
    description: string;
    createdByPersonId: string;
    registeredAt: string;
    version: number;
    personal: boolean;
    targetId: string;
    referenceDate: string | null;
    occurrenceId: string | null;
    installmentId: string | null;
    occurrenceVersion: number;
    economicVersion: number;
    projected: boolean;
    cancelled: boolean;
    resolved: boolean;
    originalAmountInCents: number | null;
    amountInCents: number | null;
    fulfilledAmountInCents: number;
    shares: readonly EconomicShare[] | null;
    distribution: SplitInput | null;
    expectedMemberId: string | null;
    settlementRuleSnapshot: SettlementRuleSnapshot | null;
    settlementRuleSourceVersion: number;
    facts: readonly OccurrenceFact[];
    adjustments: readonly FinancialAdjustment[];
    cancellation: FinancialCancellation | null;
}

export function proportionalCorrectionShares(
    amount: number,
    shares: readonly EconomicShare[],
) {
    const denominator = shares.reduce(
        (sum, share) => sum + BigInt(share.amountInCents),
        0n,
    );
    if (denominator === 0n)
        throw new FinancesError('VALIDATION_ERROR', ['distribution']);
    const calculated = shares.map((share) => ({
        memberId: share.memberId,
        amountInCents: Number(
            (BigInt(amount) * BigInt(share.amountInCents)) / denominator,
        ),
        remainder: (BigInt(amount) * BigInt(share.amountInCents)) % denominator,
    }));
    let residual =
        amount -
        calculated.reduce((sum, share) => sum + share.amountInCents, 0);
    for (const share of [...calculated].sort((a, b) =>
        a.remainder === b.remainder
            ? a.memberId.localeCompare(b.memberId)
            : a.remainder > b.remainder
              ? -1
              : 1,
    )) {
        if (residual > 0) {
            share.amountInCents++;
            residual--;
        }
    }
    return calculated.map(({ memberId, amountInCents }) => ({
        memberId,
        amountInCents,
    }));
}

export function assessFinancialAdjustment(
    state: FinancialCorrectionState,
    direction: 'INCREASE' | 'DECREASE',
    amount: number,
    distribution: SplitInput | undefined,
    actorMemberId: string | null,
) {
    Money.from(amount);
    if (
        amount < 1 ||
        state.amountInCents === null ||
        state.cancelled ||
        state.resolved
    )
        throw new FinancesError('VALIDATION_ERROR', ['amountInCents']);
    const next =
        BigInt(state.amountInCents) +
        (direction === 'INCREASE' ? BigInt(amount) : -BigInt(amount));
    if (next < 0n || next > BigInt(Number.MAX_SAFE_INTEGER))
        throw new FinancesError('VALIDATION_ERROR', ['amountInCents']);
    if (next < BigInt(state.fulfilledAmountInCents))
        throw new FinancesError('FINANCIAL_ADJUSTMENT_BELOW_FULFILLED');
    if (state.personal && distribution)
        throw new FinancesError('VALIDATION_ERROR', ['distribution']);
    let economicShares: readonly EconomicShare[] | null = null;
    let shareChanges:
        readonly { memberId: string; amountInCents: number }[] | null = null;
    const memberIds = state.shares?.map((share) => share.memberId) ?? [];
    if (!state.personal) {
        const allocation = distribution
            ? ResponsibilitySplit.create(amount, memberIds, distribution).shares
            : state.distribution?.mode === 'PERCENTAGES'
              ? ResponsibilitySplit.create(
                    amount,
                    memberIds,
                    state.distribution,
                ).shares
              : state.distribution?.mode === 'AMOUNTS'
                ? proportionalCorrectionShares(
                      amount,
                      state.distribution.shares,
                  )
                : state.shares &&
                    state.shares.some((share) => share.amountInCents > 0)
                  ? proportionalCorrectionShares(amount, state.shares)
                  : null;
        if (!allocation)
            throw new FinancesError('VALIDATION_ERROR', ['distribution']);
        shareChanges = allocation.map((share) => ({
            memberId: share.memberId,
            amountInCents:
                direction === 'INCREASE'
                    ? share.amountInCents
                    : -share.amountInCents,
        }));
        economicShares = state.shares!.map((share) => ({
            memberId: share.memberId,
            amountInCents:
                share.amountInCents +
                (shareChanges!.find(
                    (change) => change.memberId === share.memberId,
                )?.amountInCents ?? 0),
        }));
        if (economicShares.some((share) => share.amountInCents < 0))
            throw new FinancesError('VALIDATION_ERROR', ['distribution']);
    }
    const impactByMember = (state.shares ?? []).map((share) => {
        const proposed = economicShares!.find(
            (item) => item.memberId === share.memberId,
        )!.amountInCents;
        const ratio =
            BigInt(proposed) * BigInt(state.amountInCents!) -
            BigInt(share.amountInCents) * next;
        return {
            memberId: share.memberId,
            currentAmountInCents: share.amountInCents.toString(),
            proposedAmountInCents: proposed.toString(),
            deltaInCents: (proposed - share.amountInCents).toString(),
            requiresAcceptance:
                share.memberId !== actorMemberId &&
                (state.kind === 'EXPENSE'
                    ? proposed > share.amountInCents || ratio > 0n
                    : proposed < share.amountInCents || ratio < 0n),
        };
    });
    return {
        proposedAmountInCents: Number(next),
        economicShares,
        shareChanges,
        impactByMember,
        requiresAcceptance: impactByMember.some(
            (row) => row.requiresAcceptance,
        ),
        recipientMemberId:
            impactByMember.find((row) => row.requiresAcceptance)?.memberId ??
            null,
    };
}
