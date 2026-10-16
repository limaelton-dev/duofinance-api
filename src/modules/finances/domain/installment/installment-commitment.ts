import { FinancesError } from '../errors/finances.error.js';
import {
    ResponsibilitySplit,
    type EconomicShare,
    type SplitInput,
} from '../shared-expense/responsibility-split.js';
import { civilDate } from '../shared-expense/settlement-cycle.js';
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

export type InstallmentSelection =
    | { mode: 'IDS'; installmentIds: readonly string[] }
    | { mode: 'FROM_END'; quantity: number };

export interface AnticipationValue {
    installmentId: string;
    expectedInstallmentVersion: number;
    paidAmountInCents: number;
}

export interface AnticipationPlanItem {
    installmentId: string;
    position: number;
    dueDate: string;
    plannedAmountInCents: number;
    previouslyFulfilledAmountInCents: number;
    expectedRemainingAmountInCents: number;
    paidAmountInCents: number;
    effectiveAmountInCents: number;
    adjustmentInCents: number;
    expectedInstallmentVersion: number;
    plannedEconomicShares: readonly EconomicShare[] | null;
    effectiveEconomicShares: readonly EconomicShare[] | null;
}

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

    effectiveSharesFor(position: number): readonly EconomicShare[] | null {
        const item = this.plan.installments[position - 1];
        if (!item || item.position !== position)
            throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        return item.anticipation?.economicShares ?? this.sharesFor(position);
    }

    selectForAnticipation(
        selection: InstallmentSelection,
        values: readonly AnticipationValue[] | null,
        factDate: string,
        today: string,
        actorMemberId: string | null,
    ): readonly AnticipationPlanItem[] {
        civilDate(factDate);
        civilDate(today);
        if (factDate > today)
            throw new FinancesError('VALIDATION_ERROR', ['factDate']);
        const eligible = this.plan.installments.filter(
            (item) => item.dueDate > today && item.remainingAmountInCents > 0,
        );
        const selected =
            selection.mode === 'IDS'
                ? selection.installmentIds.map((id) =>
                      this.plan.installments.find((item) => item.id === id),
                  )
                : [...eligible]
                      .sort((a, b) => b.position - a.position)
                      .slice(0, selection.quantity);
        const resolvedValues =
            values ??
            selected.map((item) => ({
                installmentId: item?.id ?? '',
                expectedInstallmentVersion: item?.stateVersion ?? 0,
                paidAmountInCents: item?.remainingAmountInCents ?? 0,
            }));
        if (selected.some((item) => item && item.remainingAmountInCents === 0))
            throw new FinancesError('OCCURRENCE_ALREADY_RESOLVED');
        if (
            selected.some(
                (item) =>
                    item && (item.dueDate <= today || factDate >= item.dueDate),
            )
        )
            throw new FinancesError('VALIDATION_ERROR', ['factDate']);
        if (
            (selection.mode === 'IDS' &&
                (selection.installmentIds.length < 1 ||
                    new Set(selection.installmentIds).size !==
                        selection.installmentIds.length)) ||
            (selection.mode === 'FROM_END' &&
                (!Number.isSafeInteger(selection.quantity) ||
                    selection.quantity < 1 ||
                    selected.length !== selection.quantity)) ||
            selected.length !== resolvedValues.length ||
            selected.some(
                (item, index) =>
                    !item ||
                    item.id !== resolvedValues[index]?.installmentId ||
                    item.dueDate <= today ||
                    factDate >= item.dueDate ||
                    item.remainingAmountInCents < 1 ||
                    item.anticipation !== null ||
                    item.stateVersion !==
                        resolvedValues[index]?.expectedInstallmentVersion,
            )
        )
            throw new FinancesError('INSTALLMENT_SELECTION_CHANGED');
        return Object.freeze(
            selected.map((item, index) => {
                const installment = item!;
                const paidAmountInCents =
                    resolvedValues[index]!.paidAmountInCents;
                const effectiveAmountInCents =
                    installment.fulfilledAmountInCents + paidAmountInCents;
                if (
                    !Number.isSafeInteger(paidAmountInCents) ||
                    paidAmountInCents < 1 ||
                    !Number.isSafeInteger(effectiveAmountInCents) ||
                    effectiveAmountInCents < 1
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'values.paidAmountInCents',
                    ]);
                const plannedEconomicShares = this.sharesFor(
                    installment.position,
                );
                let effectiveEconomicShares: readonly EconomicShare[] | null =
                    null;
                if (plannedEconomicShares) {
                    if (
                        !actorMemberId ||
                        !plannedEconomicShares.some(
                            (share) => share.memberId === actorMemberId,
                        )
                    )
                        throw new FinancesError('VALIDATION_ERROR', [
                            'actorMemberId',
                        ]);
                    effectiveEconomicShares =
                        effectiveAmountInCents <= installment.amountInCents
                            ? ResponsibilitySplit.create(
                                  installment.amountInCents,
                                  plannedEconomicShares.map(
                                      (share) => share.memberId,
                                  ),
                                  {
                                      mode: 'AMOUNTS',
                                      shares: plannedEconomicShares.map(
                                          (share) => ({ ...share }),
                                      ),
                                  },
                              ).realizedShares(effectiveAmountInCents)
                            : plannedEconomicShares.map((share) => ({
                                  memberId: share.memberId,
                                  amountInCents:
                                      share.amountInCents +
                                      (share.memberId === actorMemberId
                                          ? effectiveAmountInCents -
                                            installment.amountInCents
                                          : 0),
                              }));
                }
                return Object.freeze({
                    installmentId: installment.id,
                    position: installment.position,
                    dueDate: installment.dueDate,
                    plannedAmountInCents: installment.amountInCents,
                    previouslyFulfilledAmountInCents:
                        installment.fulfilledAmountInCents,
                    expectedRemainingAmountInCents:
                        installment.remainingAmountInCents,
                    paidAmountInCents,
                    effectiveAmountInCents,
                    adjustmentInCents:
                        paidAmountInCents - installment.remainingAmountInCents,
                    expectedInstallmentVersion: installment.stateVersion,
                    plannedEconomicShares,
                    effectiveEconomicShares,
                });
            }),
        );
    }
}
