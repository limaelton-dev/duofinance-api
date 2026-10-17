import { FinancesError } from '../errors/finances.error.js';
import { Money } from '../shared-expense/money.js';
import { ResponsibilitySplit } from '../shared-expense/responsibility-split.js';
import { civilDate } from '../shared-expense/settlement-cycle.js';
import type { SettlementRuleSnapshot } from '../settlement-rule/settlement-rule.js';
import type { OriginSettlement } from '../shared-expense/obligation-reconciler.js';
import type {
    FinancialAdjustment,
    FinancialCancellation,
} from '../corrections/financial-correction.js';
import {
    assertFinancialReversalHistory,
    validFinancialAmount,
    type FinancialFulfillmentReversal,
} from '../reversals/financial-fulfillment-reversal.js';

export interface IncomeReceipt {
    id: string;
    amountInCents: number;
    factDate: string;
    registeredAt: string;
    recordedByPersonId: string;
    recipientPersonId: string | null;
    recipientMemberId: string | null;
}

export type IncomeParticipation =
    | { type: 'PERSONAL'; ownerPersonId: string }
    | {
          type: 'SHARED';
          split: ResponsibilitySplit;
          expectedRecipientMemberId: string | null;
          settlementRuleSnapshot: SettlementRuleSnapshot | null;
          settlementRuleSourceVersion: number;
      };

export class IncomeCommitment {
    readonly kind = 'INCOME';
    readonly modality = 'ONE_TIME';
    readonly version: number;
    readonly receipt: IncomeReceipt | null;
    readonly receipts: readonly IncomeReceipt[];
    readonly validReceipts: readonly IncomeReceipt[];
    readonly receivedAmountInCents: number;
    readonly remainingAmountInCents: number;
    readonly status:
        'PENDING' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED';
    readonly participation: IncomeParticipation;

    constructor(
        readonly id: string,
        readonly spaceId: string,
        readonly description: string,
        readonly amountInCents: number,
        readonly expectedReceiptDate: string,
        readonly createdByPersonId: string,
        readonly registeredAt: string,
        participation: IncomeParticipation,
        receipt: IncomeReceipt | readonly IncomeReceipt[] | null = null,
        version = (Array.isArray(receipt) ? receipt.length : receipt ? 1 : 0) +
            1,
        readonly adjustments: readonly FinancialAdjustment[] = [],
        readonly cancellation: FinancialCancellation | null = null,
        readonly reversals: readonly FinancialFulfillmentReversal[] = [],
    ) {
        const receipts: readonly IncomeReceipt[] = Array.isArray(receipt)
            ? receipt
            : receipt
              ? [receipt as IncomeReceipt]
              : [];
        assertFinancialReversalHistory(
            reversals,
            receipts.map((fact) => ({ ...fact, kind: 'RECEIPT' as const })),
            spaceId,
            id,
        );
        Money.from(amountInCents);
        civilDate(expectedReceiptDate);
        if (
            !id ||
            !spaceId ||
            !createdByPersonId ||
            !description.trim() ||
            description !== description.trim() ||
            description.length > 160 ||
            (amountInCents < 1 &&
                !(amountInCents === 0 && adjustments.length > 0)) ||
            !Number.isFinite(Date.parse(registeredAt)) ||
            !Number.isSafeInteger(version) ||
            version < receipts.length + 1 ||
            new Set(receipts.map((r) => r.id)).size !== receipts.length
        )
            throw new FinancesError('VALIDATION_ERROR');
        if (participation.type === 'PERSONAL') {
            if (participation.ownerPersonId !== createdByPersonId)
                throw new FinancesError('VALIDATION_ERROR');
        } else if (
            participation.split.total.amountInCents !== amountInCents ||
            (participation.expectedRecipientMemberId !== null &&
                !participation.split.shares.some(
                    (share) =>
                        share.memberId ===
                        participation.expectedRecipientMemberId,
                )) ||
            !Number.isSafeInteger(participation.settlementRuleSourceVersion) ||
            participation.settlementRuleSourceVersion < 0 ||
            (participation.settlementRuleSnapshot === null) !==
                (participation.settlementRuleSourceVersion === 0)
        )
            throw new FinancesError('VALIDATION_ERROR');
        let total = 0n;
        for (const receipt of receipts) {
            Money.from(receipt.amountInCents);
            civilDate(receipt.factDate);
            if (
                !receipt.id ||
                receipt.id === id ||
                receipt.amountInCents < 1 ||
                !receipt.recordedByPersonId ||
                !Number.isFinite(Date.parse(receipt.registeredAt)) ||
                (participation.type === 'PERSONAL'
                    ? receipt.recipientPersonId !==
                          participation.ownerPersonId ||
                      receipt.recordedByPersonId !==
                          participation.ownerPersonId ||
                      receipt.recipientMemberId !== null
                    : receipt.recipientPersonId !== null ||
                      !participation.split.shares.some(
                          (share) =>
                              share.memberId === receipt.recipientMemberId,
                      ))
            )
                throw new FinancesError('VALIDATION_ERROR');
            total += BigInt(
                validFinancialAmount(
                    receipt.amountInCents,
                    reversals,
                    'RECEIPT',
                    receipt.id,
                ),
            );
        }
        if (total > BigInt(amountInCents))
            throw new FinancesError('VALIDATION_ERROR');
        this.version = version;
        this.participation = Object.freeze(
            participation.type === 'PERSONAL'
                ? { ...participation }
                : {
                      ...participation,
                      settlementRuleSnapshot:
                          participation.settlementRuleSnapshot
                              ? Object.freeze({
                                    ...participation.settlementRuleSnapshot,
                                })
                              : null,
                  },
        );
        this.receipts = Object.freeze(
            receipts.map((r) => Object.freeze({ ...r })),
        );
        this.receipt = this.receipts[0] ?? null;
        this.validReceipts = Object.freeze(
            this.receipts
                .map((fact) => ({
                    ...fact,
                    amountInCents: validFinancialAmount(
                        fact.amountInCents,
                        reversals,
                        'RECEIPT',
                        fact.id,
                    ),
                }))
                .filter((fact) => fact.amountInCents > 0),
        );
        this.receivedAmountInCents = Number(total);
        this.remainingAmountInCents =
            amountInCents - this.receivedAmountInCents;
        this.status = cancellation
            ? 'CANCELLED'
            : this.remainingAmountInCents === 0 && adjustments.length > 0
              ? 'RECEIVED'
              : total === 0n
                ? 'PENDING'
                : this.remainingAmountInCents === 0
                  ? 'RECEIVED'
                  : 'PARTIALLY_RECEIVED';
        Object.freeze(this);
    }

    recordReceipt(
        receipt: IncomeReceipt,
        expectedVersion: number,
        today: string,
    ): IncomeCommitment {
        if (this.cancellation)
            throw new FinancesError('FINANCIAL_COMMITMENT_CANCELLED');
        if (this.remainingAmountInCents === 0)
            throw new FinancesError('INCOME_ALREADY_RECEIVED');
        if (expectedVersion !== this.version)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        if (civilDate(receipt.factDate) > civilDate(today))
            throw new FinancesError('VALIDATION_ERROR', ['factDate']);
        return new IncomeCommitment(
            this.id,
            this.spaceId,
            this.description,
            this.amountInCents,
            this.expectedReceiptDate,
            this.createdByPersonId,
            this.registeredAt,
            this.participation,
            [...this.receipts, receipt],
            this.version + 1,
            this.adjustments,
            this.cancellation,
            this.reversals,
        );
    }
}

export function incomeDifference(
    income: IncomeCommitment,
    settlements: readonly OriginSettlement[] = [],
): {
    debtorMemberId: string;
    creditorMemberId: string;
    amountInCents: number;
} | null {
    if (income.participation.type === 'PERSONAL') return null;
    const shares = income.participation.split.realizedShares(
        income.receivedAmountInCents,
    );
    if (shares.length < 2) return null;
    const member = shares[0].memberId;
    let excess =
        income.validReceipts.reduce(
            (sum, r) =>
                sum +
                (r.recipientMemberId === member ? BigInt(r.amountInCents) : 0n),
            0n,
        ) - BigInt(shares[0].amountInCents);
    for (const settlement of settlements)
        excess +=
            settlement.recipientMemberId === member
                ? BigInt(settlement.amountInCents)
                : settlement.payerMemberId === member
                  ? -BigInt(settlement.amountInCents)
                  : 0n;
    if (excess === 0n) return null;
    const amount = Number(excess > 0n ? excess : -excess);
    Money.from(amount);
    return {
        debtorMemberId: excess > 0n ? member : shares[1].memberId,
        creditorMemberId: excess > 0n ? shares[1].memberId : member,
        amountInCents: amount,
    };
}
