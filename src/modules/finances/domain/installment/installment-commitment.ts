import { FinancesError } from '../errors/finances.error.js';
import {
    ResponsibilitySplit,
    type EconomicShare,
    type SplitInput,
} from '../shared-expense/responsibility-split.js';
import type { SettlementRuleSnapshot } from '../settlement-rule/settlement-rule.js';
import { InstallmentPlan } from './installment-plan.js';

export type InstallmentParticipation =
    | { type: 'PERSONAL'; ownerPersonId: string }
    | {
          type: 'SHARED';
          distribution: SplitInput;
          expectedMemberId: string | null;
          settlementRuleSnapshot: SettlementRuleSnapshot | null;
          settlementRuleSourceVersion: number;
      };

export class InstallmentCommitment {
    readonly kind = 'EXPENSE';
    readonly modality = 'INSTALLMENT';

    constructor(
        readonly id: string,
        readonly spaceId: string,
        readonly description: string,
        readonly createdByPersonId: string,
        readonly registeredAt: string,
        readonly version: number,
        readonly plan: InstallmentPlan,
        readonly participation: InstallmentParticipation,
        readonly cadence: 'MONTHLY' | 'ANNUAL' | 'EXPLICIT',
        readonly plannedPaymentMethod: 'CARD' | 'PIX' | 'DEBIT' | 'CASH' | null,
    ) {
        if (
            !id ||
            !spaceId ||
            !createdByPersonId ||
            plan.commitmentId !== id ||
            plan.spaceId !== spaceId ||
            !description.trim() ||
            description !== description.trim() ||
            description.length > 160 ||
            !Number.isSafeInteger(version) ||
            version < 1 ||
            !Number.isFinite(Date.parse(registeredAt))
        )
            throw new FinancesError('VALIDATION_ERROR');
        if (participation.type === 'PERSONAL') {
            if (participation.ownerPersonId !== createdByPersonId)
                throw new FinancesError('VALIDATION_ERROR');
        } else {
            const members = participation.distribution.shares.map(
                (share) => share.memberId,
            );
            ResponsibilitySplit.create(
                plan.totalAmountInCents,
                members,
                participation.distribution,
            );
            if (
                (participation.expectedMemberId !== null &&
                    !members.includes(participation.expectedMemberId)) ||
                participation.settlementRuleSourceVersion < 0 ||
                (participation.settlementRuleSnapshot === null) !==
                    (participation.settlementRuleSourceVersion === 0)
            )
                throw new FinancesError('VALIDATION_ERROR');
        }
        Object.freeze(this);
    }

    sharesFor(position: number): readonly EconomicShare[] | null {
        if (this.participation.type === 'PERSONAL') return null;
        const installment = this.plan.installments[position - 1];
        if (!installment || installment.position !== position)
            throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const members = this.participation.distribution.shares.map(
            (share) => share.memberId,
        );
        const split = ResponsibilitySplit.create(
            this.plan.totalAmountInCents,
            members,
            this.participation.distribution,
        );
        const before = this.plan.installments
            .slice(0, position - 1)
            .reduce((sum, item) => sum + item.amountInCents, 0);
        const after = before + installment.amountInCents;
        const prior = new Map(
            split
                .realizedShares(before)
                .map((share) => [share.memberId, share.amountInCents]),
        );
        return Object.freeze(
            split.realizedShares(after).map((share) => ({
                memberId: share.memberId,
                amountInCents:
                    share.amountInCents - (prior.get(share.memberId) ?? 0),
            })),
        );
    }
}
