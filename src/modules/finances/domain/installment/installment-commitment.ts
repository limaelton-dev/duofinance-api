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

export interface InstallmentResolutionItem {
    installmentId: string;
    position: number;
    dueDate: string;
    plannedAmountInCents: number;
    previouslyFulfilledAmountInCents: number;
    expectedRemainingAmountInCents: number;
    expectedInstallmentVersion: number;
    remainingEconomicShares: readonly EconomicShare[] | null;
}

export interface InstallmentPayoffImpact {
    items: readonly InstallmentResolutionItem[];
    expectedRemainingAmountInCents: number;
    paidAmountInCents: number;
    adjustmentInCents: number;
    expectedRemainingShares: readonly EconomicShare[] | null;
    effectiveEconomicShares: readonly EconomicShare[] | null;
    recognizedRemainingShares: readonly EconomicShare[] | null;
    recognizedManualAdjustments: {
        amountInCents: number;
        shareChanges: readonly EconomicShare[] | null;
    } | null;
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
            if (!participation.ownerPersonId)
                throw new FinancesError('VALIDATION_ERROR');
        } else {
            const members = participation.distribution.shares.map(
                (share) => share.memberId,
            );
            ResponsibilitySplit.create(
                plan.installments.reduce(
                    (sum, item) => sum + item.originalAmountInCents,
                    0,
                ),
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
        if (installment.economicShares) return installment.economicShares;
        const members = this.participation.distribution.shares.map(
            (share) => share.memberId,
        );
        const split = ResponsibilitySplit.create(
            this.plan.installments.reduce(
                (sum, item) => sum + item.originalAmountInCents,
                0,
            ),
            members,
            this.participation.distribution,
        );
        const before = this.plan.installments
            .slice(0, position - 1)
            .reduce((sum, item) => sum + item.originalAmountInCents, 0);
        const after = before + installment.originalAmountInCents;
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

    resolutionOptions(): readonly InstallmentResolutionItem[] {
        return Object.freeze(
            this.plan.installments.map((item) => {
                const planned = this.sharesFor(item.position);
                const realized =
                    planned &&
                    item.remainingAmountInCents > 0 &&
                    item.fulfilledAmountInCents > 0
                        ? ResponsibilitySplit.create(
                              item.amountInCents,
                              planned.map((share) => share.memberId),
                              {
                                  mode: 'AMOUNTS',
                                  shares: planned.map((share) => ({
                                      ...share,
                                  })),
                              },
                          ).realizedShares(item.fulfilledAmountInCents)
                        : (planned?.map((share) => ({
                              memberId: share.memberId,
                              amountInCents: 0,
                          })) ?? null);
                return Object.freeze({
                    installmentId: item.id,
                    position: item.position,
                    dueDate: item.dueDate,
                    plannedAmountInCents: item.amountInCents,
                    previouslyFulfilledAmountInCents:
                        item.fulfilledAmountInCents,
                    expectedRemainingAmountInCents: item.remainingAmountInCents,
                    expectedInstallmentVersion: item.stateVersion,
                    remainingEconomicShares:
                        planned?.map((share, index) => ({
                            memberId: share.memberId,
                            amountInCents:
                                item.remainingAmountInCents === 0
                                    ? 0
                                    : share.amountInCents -
                                      realized![index]!.amountInCents,
                        })) ?? null,
                });
            }),
        );
    }

    assertGlobalFulfillment(
        amountInCents: number,
        economicAdjustmentInCents = 0,
    ): void {
        if (
            !Number.isSafeInteger(amountInCents) ||
            amountInCents < 1 ||
            !Number.isSafeInteger(economicAdjustmentInCents) ||
            BigInt(amountInCents) >
                BigInt(this.plan.remainingAmountInCents) +
                    BigInt(economicAdjustmentInCents)
        )
            throw new FinancesError('VALIDATION_ERROR', ['amountInCents']);
    }

    payoffImpact(
        paidAmountInCents: number,
        actorMemberId: string | null,
    ): InstallmentPayoffImpact {
        if (
            this.plan.payoff ||
            !Number.isSafeInteger(paidAmountInCents) ||
            paidAmountInCents < 1
        )
            throw new FinancesError('VALIDATION_ERROR', ['paidAmountInCents']);
        const items = this.resolutionOptions().filter(
            (item) => item.expectedRemainingAmountInCents > 0,
        );
        if (!items.length)
            throw new FinancesError('OCCURRENCE_ALREADY_RESOLVED');
        const expectedBig = items.reduce(
            (sum, item) => sum + BigInt(item.expectedRemainingAmountInCents),
            BigInt(this.plan.globalAdjustmentInCents),
        );
        if (expectedBig < 1n || expectedBig > BigInt(Number.MAX_SAFE_INTEGER))
            throw new FinancesError('VALIDATION_ERROR', ['amountInCents']);
        const expected = Number(expectedBig);
        const fulfilledBefore = this.plan.installments.reduce(
            (sum, item) => sum + BigInt(item.fulfilledAmountInCents),
            0n,
        );
        if (
            fulfilledBefore + BigInt(paidAmountInCents) >
            BigInt(Number.MAX_SAFE_INTEGER)
        )
            throw new FinancesError('VALIDATION_ERROR', ['paidAmountInCents']);
        let expectedShares: readonly EconomicShare[] | null = null;
        let effectiveShares: readonly EconomicShare[] | null = null;
        let recognizedShares: readonly EconomicShare[] | null = null;
        if (this.participation.type === 'SHARED') {
            const members = this.participation.distribution.shares.map(
                (share) => share.memberId,
            );
            if (!actorMemberId || !members.includes(actorMemberId))
                throw new FinancesError('VALIDATION_ERROR', ['actorMemberId']);
            const sumShares = (
                selected: readonly InstallmentResolutionItem[],
            ) =>
                members.map((memberId) => ({
                    memberId,
                    amountInCents: selected.reduce(
                        (sum, item) =>
                            sum +
                            (item.remainingEconomicShares?.find(
                                (share) => share.memberId === memberId,
                            )?.amountInCents ?? 0),
                        0,
                    ),
                }));
            expectedShares = sumShares(items).map((share) => ({
                memberId: share.memberId,
                amountInCents:
                    share.amountInCents +
                    (this.plan.globalAdjustmentShares?.find(
                        (adjustment) => adjustment.memberId === share.memberId,
                    )?.amountInCents ?? 0),
            }));
            recognizedShares = sumShares(
                items.filter(
                    (item) =>
                        item.previouslyFulfilledAmountInCents > 0 ||
                        this.plan.installments.find(
                            (installment) =>
                                installment.id === item.installmentId,
                        )!.reversals.length > 0,
                ),
            );
            effectiveShares =
                paidAmountInCents <= expected
                    ? ResponsibilitySplit.create(expected, members, {
                          mode: 'AMOUNTS',
                          shares: expectedShares.map((share) => ({ ...share })),
                      }).realizedShares(paidAmountInCents)
                    : expectedShares.map((share) => ({
                          memberId: share.memberId,
                          amountInCents:
                              share.amountInCents +
                              (share.memberId === actorMemberId
                                  ? paidAmountInCents - expected
                                  : 0),
                      }));
        }
        const manualAdjustments = this.plan.installments
            .filter(
                (item) =>
                    items.some(
                        (selected) => selected.installmentId === item.id,
                    ) &&
                    item.fulfilledAmountInCents === 0 &&
                    item.reversals.length === 0 &&
                    !item.resolutionHistory.some(
                        (resolution) => resolution.type === 'PAYOFF',
                    ),
            )
            .flatMap((item) => item.adjustments);
        const recognizedAmount = manualAdjustments.reduce(
            (sum, adjustment) =>
                sum +
                (adjustment.direction === 'INCREASE'
                    ? BigInt(adjustment.amountInCents)
                    : -BigInt(adjustment.amountInCents)),
            0n,
        );
        if (
            recognizedAmount < -BigInt(Number.MAX_SAFE_INTEGER) ||
            recognizedAmount > BigInt(Number.MAX_SAFE_INTEGER)
        )
            throw new FinancesError('VALIDATION_ERROR', ['amountInCents']);
        const recognizedManualAdjustments = manualAdjustments.length
            ? {
                  amountInCents: Number(recognizedAmount),
                  shareChanges:
                      this.participation.type === 'PERSONAL'
                          ? null
                          : this.participation.distribution.shares.map(
                                (share) => {
                                    const change = manualAdjustments.reduce(
                                        (sum, adjustment) =>
                                            sum +
                                            BigInt(
                                                adjustment.shareChanges?.find(
                                                    (item) =>
                                                        item.memberId ===
                                                        share.memberId,
                                                )?.amountInCents ?? 0,
                                            ),
                                        0n,
                                    );
                                    if (
                                        change <
                                            -BigInt(Number.MAX_SAFE_INTEGER) ||
                                        change > BigInt(Number.MAX_SAFE_INTEGER)
                                    )
                                        throw new FinancesError(
                                            'VALIDATION_ERROR',
                                            ['distribution'],
                                        );
                                    return {
                                        memberId: share.memberId,
                                        amountInCents: Number(change),
                                    };
                                },
                            ),
              }
            : null;
        return Object.freeze({
            items,
            expectedRemainingAmountInCents: expected,
            paidAmountInCents,
            adjustmentInCents: paidAmountInCents - expected,
            expectedRemainingShares: expectedShares,
            effectiveEconomicShares: effectiveShares,
            recognizedRemainingShares: recognizedShares,
            recognizedManualAdjustments,
        });
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
        const expectedSelected = selected.reduce(
            (sum, item) => sum + BigInt(item!.remainingAmountInCents),
            0n,
        );
        if (expectedSelected > BigInt(this.plan.remainingAmountInCents))
            throw new FinancesError('VALIDATION_ERROR', ['selection']);
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
