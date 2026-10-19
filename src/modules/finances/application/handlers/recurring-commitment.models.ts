import { FinancialOccurrence } from '../../domain/recurrence/financial-occurrence.js';
import { RecurringCommitment } from '../../domain/recurrence/recurring-commitment.js';
export function view(
    root: RecurringCommitment,
    occurrence: FinancialOccurrence | null,
    referenceDate: string,
) {
    return {
        id: occurrence?.id ?? null,
        commitmentId: root.id,
        referenceDate,
        economicVersion: occurrence?.economicVersion ?? root.economicVersion,
        stateVersion: occurrence?.stateVersion ?? 1,
        amountInCents: occurrence
            ? occurrence.amountInCents
            : root.valueMode === 'FIXED'
              ? root.amountInCents
              : null,
        expectedAmountInCents: root.amountInCents,
        valuePending:
            root.valueMode === 'VARIABLE' && (occurrence?.valuePending ?? true),
        economicShares:
            occurrence?.amountInCents !== null &&
            occurrence?.amountInCents !== undefined
                ? (occurrence.economicShares ??
                  root.effectiveSplit(occurrence.amountInCents)?.shares ??
                  null)
                : root.valueMode === 'FIXED'
                  ? root.participation.type === 'SHARED'
                      ? (root.participation.split?.shares ?? null)
                      : null
                  : null,
        valueHistory: occurrence?.valueHistory ?? [],
        ...(occurrence?.adjustments.length
            ? {
                  adjustments: occurrence.adjustments,
                  originalAmountInCents:
                      occurrence.adjustments[0].previousAmountInCents,
              }
            : {}),
        status: occurrence?.status ?? 'PENDING',
        fulfilledAmountInCents: occurrence?.fulfilledAmountInCents ?? 0,
        remainingAmountInCents: occurrence
            ? occurrence.remainingAmountInCents
            : root.valueMode === 'FIXED'
              ? root.amountInCents
              : null,
        materializedAt: occurrence?.materializedAt ?? null,
        facts: occurrence?.facts ?? [],
        externalSettlements: occurrence?.externalSettlements ?? [],
        ...(occurrence?.reversals.length
            ? {
                  reversals: occurrence.reversals,
                  validFacts: occurrence.validFacts,
                  validExternalSettlements: occurrence.validExternalSettlements,
              }
            : {}),
        cancellation: occurrence?.cancellation ?? null,
    };
}
export function rootView(
    root: RecurringCommitment,
    today: string,
    closureCutoffDate: string | null = null,
) {
    const displayed =
        root.effectiveVersionAt(today) ??
        root.versions[0]?.configuration ??
        root;
    const p = displayed.participation;
    const next = Array.from({ length: 13 }, (_, i) => {
        const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() + i);
        return root.projections(d.toISOString().slice(0, 7));
    })
        .flat()
        .find(
            (projected) =>
                projected.referenceDate >= today &&
                (!closureCutoffDate ||
                    projected.referenceDate < closureCutoffDate),
        );
    const nextConfiguration = next
        ? root.configurationAt(next.referenceDate)
        : null;
    return {
        id: root.id,
        spaceId: root.spaceId,
        kind: root.kind,
        modality: root.modality,
        description: displayed.description,
        valueMode: displayed.valueMode,
        amountInCents:
            displayed.valueMode === 'FIXED' ? displayed.amountInCents : null,
        expectedAmountInCents: displayed.amountInCents,
        recurrence: displayed.rule.pattern,
        startsOn: displayed.rule.startsOn,
        endsOn: displayed.rule.endsOn,
        createdByPersonId: root.createdByPersonId,
        registeredAt: root.registeredAt,
        economicVersion: root.economicVersion,
        currentEconomicVersion:
            root.effectiveVersionAt(today)?.economicVersion ?? null,
        effectiveFrom: root.effectiveFrom,
        terminatedOn: root.terminatedOn,
        versions: (root.versions.length
            ? root.versions
            : [{ effectiveFrom: root.effectiveFrom, configuration: root }]
        ).map((v) => ({
            version: v.configuration.economicVersion,
            effectiveFrom: v.effectiveFrom,
            description: v.configuration.description,
            valueMode: v.configuration.valueMode,
            amountInCents:
                v.configuration.valueMode === 'FIXED'
                    ? v.configuration.amountInCents
                    : null,
            expectedAmountInCents: v.configuration.amountInCents,
            recurrence: v.configuration.rule.pattern,
            endsOn: v.configuration.rule.endsOn,
        })),
        version: root.version,
        scope: p.type,
        ...(closureCutoffDate ? { closureCutoffDate } : {}),
        ...(p.type === 'PERSONAL'
            ? { ownerPersonId: p.ownerPersonId }
            : {
                  distribution: p.split
                      ? { ...p.distribution, calculatedShares: p.split.shares }
                      : p.distribution,
                  expectedMemberId: p.expectedMemberId,
                  settlementRuleSnapshot: p.settlementRuleSnapshot,
                  settlementRuleSourceVersion: p.settlementRuleSourceVersion,
              }),
        nextOccurrence:
            next && nextConfiguration
                ? {
                      referenceDate: next.referenceDate,
                      economicVersion: nextConfiguration.economicVersion,
                      amountInCents:
                          nextConfiguration.valueMode === 'FIXED'
                              ? nextConfiguration.amountInCents
                              : null,
                      expectedAmountInCents: nextConfiguration.amountInCents,
                  }
                : null,
    };
}
