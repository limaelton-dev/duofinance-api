import { InstallmentCommitment } from '../../domain/installment/installment-commitment.js';
import { Installment } from '../../domain/installment/installment-plan.js';
import { FinancialOccurrence } from '../../domain/recurrence/financial-occurrence.js';

export function installmentView(
    root: InstallmentCommitment,
    item: Installment,
    occurrence?: FinancialOccurrence | null,
) {
    return {
        id: item.id,
        position: item.position,
        dueDate: item.dueDate,
        amountInCents: item.amountInCents,
        ...(item.adjustments.length
            ? {
                  adjustments: item.adjustments,
                  originalAmountInCents: item.originalAmountInCents,
              }
            : {}),
        ...(item.economicVersion > 1
            ? {
                  originalAmountInCents: item.originalAmountInCents,
                  economicVersion: item.economicVersion,
              }
            : {}),
        ...(item.expectedMemberId !== undefined
            ? { expectedMemberId: item.expectedMemberId }
            : {}),
        economicShares: root.sharesFor(item.position),
        effectiveAmountInCents: item.effectiveAmountInCents,
        effectiveEconomicShares: root.effectiveSharesFor(item.position),
        anticipation: item.anticipation,
        resolution: item.resolution,
        stateVersion: occurrence?.stateVersion ?? item.stateVersion,
        status: item.status,
        fulfilledAmountInCents: item.fulfilledAmountInCents,
        remainingAmountInCents: item.remainingAmountInCents,
        facts: occurrence?.facts ?? [],
        externalSettlements: occurrence?.externalSettlements ?? [],
        ...(item.reversals.length
            ? {
                  reversals: item.reversals,
                  validFacts: occurrence?.validFacts ?? [],
                  validExternalSettlements:
                      occurrence?.validExternalSettlements ?? [],
              }
            : {}),
        ...(item.resolutionHistory.some((resolution) => resolution.compensated)
            ? { resolutionHistory: item.resolutionHistory }
            : {}),
    };
}

export function rootView(root: InstallmentCommitment) {
    const p = root.participation;
    return {
        id: root.id,
        spaceId: root.spaceId,
        kind: root.kind,
        modality: root.modality,
        description: root.description,
        createdByPersonId: root.createdByPersonId,
        registeredAt: root.registeredAt,
        version: root.version,
        scope: p.type,
        plan: {
            id: root.plan.id,
            count: root.plan.count,
            cadence: root.cadence,
            status: root.plan.status,
            plannedPaymentMethod: root.plannedPaymentMethod,
            totalAmountInCents: root.plan.totalAmountInCents,
            fulfilledAmountInCents: root.plan.installments.reduce(
                (sum, item) => sum + item.fulfilledAmountInCents,
                root.plan.payoff?.paidAmountInCents ?? 0,
            ),
            remainingAmountInCents: root.plan.remainingAmountInCents,
            ...(root.plan.payoffHistory.some((payoff) => payoff.compensated)
                ? {
                      globalAdjustmentInCents:
                          root.plan.globalAdjustmentInCents,
                      payoffHistory: root.plan.payoffHistory,
                  }
                : {}),
            installments: root.plan.installments.map((item) =>
                installmentView(root, item),
            ),
            payoff: root.plan.payoff,
        },
        ...(p.type === 'PERSONAL'
            ? { ownerPersonId: p.ownerPersonId }
            : {
                  distribution: p.distribution,
                  expectedMemberId: p.expectedMemberId,
                  settlementRuleSnapshot: p.settlementRuleSnapshot,
                  settlementRuleSourceVersion: p.settlementRuleSourceVersion,
              }),
    };
}
