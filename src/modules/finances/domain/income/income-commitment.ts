import { FinancesError } from '../errors/finances.error.js';
import { Money } from '../shared-expense/money.js';
import { ResponsibilitySplit } from '../shared-expense/responsibility-split.js';
import { civilDate } from '../shared-expense/settlement-cycle.js';
import type { SettlementRuleSnapshot } from '../settlement-rule/settlement-rule.js';

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

    constructor(
        readonly id: string,
        readonly spaceId: string,
        readonly description: string,
        readonly amountInCents: number,
        readonly expectedReceiptDate: string,
        readonly createdByPersonId: string,
        readonly registeredAt: string,
        readonly participation: IncomeParticipation,
        receipt: IncomeReceipt | null = null,
        version = receipt ? 2 : 1,
    ) {
        Money.from(amountInCents);
        civilDate(expectedReceiptDate);
        if (
            !id ||
            !spaceId ||
            !createdByPersonId ||
            !description.trim() ||
            description !== description.trim() ||
            description.length > 160 ||
            amountInCents < 1 ||
            !Number.isFinite(Date.parse(registeredAt)) ||
            version !== (receipt ? 2 : 1)
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
        if (receipt) {
            Money.from(receipt.amountInCents);
            civilDate(receipt.factDate);
            if (
                !receipt.id ||
                receipt.id === id ||
                receipt.amountInCents !== amountInCents ||
                !receipt.recordedByPersonId ||
                !Number.isFinite(Date.parse(receipt.registeredAt)) ||
                (participation.type === 'PERSONAL'
                    ? receipt.recipientPersonId !==
                          participation.ownerPersonId ||
                      receipt.recipientMemberId !== null
                    : receipt.recipientPersonId !== null ||
                      !participation.split.shares.some(
                          (share) =>
                              share.memberId === receipt.recipientMemberId,
                      ))
            )
                throw new FinancesError('VALIDATION_ERROR');
        }
        this.version = version;
        this.receipt = receipt ? Object.freeze({ ...receipt }) : null;
        Object.freeze(this);
    }

    recordReceipt(
        receipt: IncomeReceipt,
        expectedVersion: number,
        today: string,
    ): IncomeCommitment {
        if (this.receipt) throw new FinancesError('INCOME_ALREADY_RECEIVED');
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
            receipt,
            this.version + 1,
        );
    }
}

export function incomeDifference(income: IncomeCommitment): {
    debtorMemberId: string;
    creditorMemberId: string;
    amountInCents: number;
} | null {
    if (income.participation.type === 'PERSONAL' || !income.receipt)
        return null;
    const receiver = income.receipt.recipientMemberId;
    const own = income.participation.split.shares.find(
        (share) => share.memberId === receiver,
    );
    const other = income.participation.split.shares.find(
        (share) => share.memberId !== receiver,
    );
    if (!own || !other || other.amountInCents === 0) return null;
    return {
        debtorMemberId: own.memberId,
        creditorMemberId: other.memberId,
        amountInCents: other.amountInCents,
    };
}
