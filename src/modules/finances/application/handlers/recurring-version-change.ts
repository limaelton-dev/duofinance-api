import { Inject, Injectable } from '@nestjs/common';
import { FinancesError } from '../../domain/errors/finances.error.js';
import { RecurrenceRule } from '../../domain/recurrence/recurrence-rule.js';
import { RecurringCommitment } from '../../domain/recurrence/recurring-commitment.js';
import { ResponsibilitySplit } from '../../domain/shared-expense/responsibility-split.js';
import type { ChangeRecurringCommitmentDto } from '../../http/dto/recurring-commitment.dto.js';
import {
    DEFAULT_SETTLEMENT_RULE_REPOSITORY,
    type DefaultSettlementRuleRepository,
} from '../ports/private/default-settlement-rule.repository.js';
import {
    RECURRING_COMMITMENT_REPOSITORY,
    type RecurringCommitmentRepository,
} from '../ports/private/recurring-commitment.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';

@Injectable()
export class RecurringVersionChange {
    constructor(
        @Inject(DEFAULT_SETTLEMENT_RULE_REPOSITORY)
        private readonly rules: DefaultSettlementRuleRepository,
        @Inject(RECURRING_COMMITMENT_REPOSITORY)
        private readonly repository: RecurringCommitmentRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}

    async candidate(
        c: ChangeRecurringCommitmentDto,
        root: RecurringCommitment,
        memberIds: string[] | null,
    ) {
        const today = this.clock.today();
        if (root.version !== c.expectedCommitmentVersion)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        if (root.terminatedOn)
            throw new FinancesError('RECURRENCE_ALREADY_TERMINATED');
        if (c.effectiveFrom <= today || c.effectiveFrom <= root.effectiveFrom)
            throw new FinancesError('VALIDATION_ERROR', ['effectiveFrom']);
        if (root.kind !== c.kind || root.participation.type !== c.scope)
            throw new FinancesError('VALIDATION_ERROR', ['kind', 'scope']);
        let participation: RecurringCommitment['participation'];
        if (c.scope === 'PERSONAL') {
            participation = {
                type: 'PERSONAL',
                ownerPersonId: root.createdByPersonId,
            };
        } else {
            if (
                !memberIds ||
                c.distribution.shares.length !== memberIds.length ||
                c.distribution.shares.some(
                    (share) => !memberIds.includes(share.memberId),
                ) ||
                (c.expectedMemberId && !memberIds.includes(c.expectedMemberId))
            )
                throw new FinancesError('VALIDATION_ERROR', ['distribution']);
            const rule = await this.rules.find(root.spaceId);
            participation = {
                type: 'SHARED',
                split:
                    c.valueMode === 'FIXED'
                        ? ResponsibilitySplit.create(
                              c.amountInCents,
                              memberIds,
                              c.distribution,
                          )
                        : null,
                distribution: c.distribution,
                expectedMemberId: c.expectedMemberId ?? null,
                settlementRuleSnapshot: rule?.rule.snapshot ?? null,
                settlementRuleSourceVersion: rule?.version ?? 0,
            };
        }
        return new RecurringCommitment(
            root.id,
            root.spaceId,
            root.kind,
            c.description,
            c.valueMode === 'FIXED'
                ? c.amountInCents
                : (c.expectedAmountInCents ?? null),
            new RecurrenceRule(c.recurrence, c.effectiveFrom, c.endsOn ?? null),
            root.createdByPersonId,
            this.clock.now().toISOString(),
            root.economicVersion + 1,
            root.version + 1,
            participation,
            c.valueMode,
            c.effectiveFrom,
        );
    }

    withCandidate(root: RecurringCommitment, candidate: RecurringCommitment) {
        const existing = root.versions.length
            ? root.versions
            : [{ effectiveFrom: root.effectiveFrom, configuration: root }];
        return new RecurringCommitment(
            candidate.id,
            candidate.spaceId,
            candidate.kind,
            candidate.description,
            candidate.amountInCents,
            candidate.rule,
            candidate.createdByPersonId,
            candidate.registeredAt,
            candidate.economicVersion,
            candidate.version,
            candidate.participation,
            candidate.valueMode,
            candidate.effectiveFrom,
            [
                ...existing,
                {
                    effectiveFrom: candidate.effectiveFrom,
                    configuration: candidate,
                },
            ],
        );
    }

    async changeImpact(
        root: RecurringCommitment,
        candidate: RecurringCommitment,
        actorMemberId: string | null,
    ) {
        const proposed = this.withCandidate(root, candidate);
        const start = new Date(
            `${candidate.effectiveFrom.slice(0, 7)}-01T00:00:00Z`,
        );
        const allMaterialized = await this.repository.materializedAfter(
            root,
            candidate.effectiveFrom.slice(0, 7) + '-01',
        );
        const materializedMonths = new Set(
            allMaterialized.map((item) => item.referenceDate.slice(0, 7)),
        );
        const before: {
            referenceDate: string;
            configuration: RecurringCommitment;
        }[] = [];
        const after: {
            referenceDate: string;
            configuration: RecurringCommitment;
        }[] = [];
        for (let i = 0; i < 25; i += 1) {
            const month = new Date(
                Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1),
            )
                .toISOString()
                .slice(0, 7);
            for (const p of materializedMonths.has(month)
                ? []
                : root.projections(month))
                if (p.referenceDate >= candidate.effectiveFrom)
                    before.push({
                        referenceDate: p.referenceDate,
                        configuration: root.configurationAt(p.referenceDate)!,
                    });
            for (const p of materializedMonths.has(month)
                ? []
                : proposed.projections(month))
                if (p.referenceDate >= candidate.effectiveFrom)
                    after.push({
                        referenceDate: p.referenceDate,
                        configuration: proposed.configurationAt(
                            p.referenceDate,
                        )!,
                    });
        }
        const totals = (items: typeof before) => {
            const rows = new Map<
                string,
                { fixed: bigint; variableWeight: number; occurrences: number }
            >();
            for (const item of items) {
                const p = item.configuration.participation;
                if (p.type !== 'SHARED') continue;
                for (const share of p.distribution.shares) {
                    const row = rows.get(share.memberId) ?? {
                        fixed: 0n,
                        variableWeight: 0,
                        occurrences: 0,
                    };
                    if (item.configuration.valueMode === 'FIXED')
                        row.fixed += BigInt(
                            item.configuration
                                .effectiveSplit(
                                    item.configuration.amountInCents!,
                                )!
                                .shares.find(
                                    (s) => s.memberId === share.memberId,
                                )!.amountInCents,
                        );
                    else if ('basisPoints' in share)
                        row.variableWeight += share.basisPoints;
                    row.occurrences += 1;
                    rows.set(share.memberId, row);
                }
            }
            return rows;
        };
        const previous = totals(before),
            next = totals(after);
        const ids = [...new Set([...previous.keys(), ...next.keys()])].sort();
        const impactByMember = ids.map((memberId) => {
            const a = previous.get(memberId) ?? {
                fixed: 0n,
                variableWeight: 0,
                occurrences: 0,
            };
            const b = next.get(memberId) ?? {
                fixed: 0n,
                variableWeight: 0,
                occurrences: 0,
            };
            const fixedDelta = b.fixed - a.fixed;
            const variableDelta = b.variableWeight - a.variableWeight;
            const uncertain =
                (a.fixed > 0n && b.variableWeight > 0) ||
                (a.variableWeight > 0 && b.fixed > 0n);
            const monthlyOnerous = [
                ...new Set(
                    [...before, ...after].map((item) =>
                        item.referenceDate.slice(0, 7),
                    ),
                ),
            ].some((month) => {
                const prior = before.find((item) =>
                    item.referenceDate.startsWith(month),
                )?.configuration;
                const proposed = after.find((item) =>
                    item.referenceDate.startsWith(month),
                )?.configuration;
                const exposure = (
                    configuration: RecurringCommitment | undefined,
                ) => {
                    if (
                        !configuration ||
                        configuration.participation.type !== 'SHARED'
                    )
                        return { amount: 0, numerator: 0n, denominator: 1n };
                    const participation = configuration.participation;
                    const amount =
                        configuration.valueMode === 'FIXED'
                            ? (configuration
                                  .effectiveSplit(configuration.amountInCents!)!
                                  .shares.find(
                                      (share) => share.memberId === memberId,
                                  )?.amountInCents ?? 0)
                            : 0;
                    const share = participation.distribution.shares.find(
                        (share) => share.memberId === memberId,
                    );
                    const numerator = BigInt(
                        share
                            ? 'basisPoints' in share
                                ? share.basisPoints
                                : share.amountInCents
                            : 0,
                    );
                    const denominator = BigInt(
                        share && 'basisPoints' in share
                            ? 10000
                            : (configuration.amountInCents ?? 1),
                    );
                    return { amount, numerator, denominator };
                };
                const p = exposure(prior),
                    n = exposure(proposed);
                return root.kind === 'EXPENSE'
                    ? n.amount > p.amount ||
                          n.numerator * p.denominator >
                              p.numerator * n.denominator
                    : n.amount < p.amount ||
                          n.numerator * p.denominator <
                              p.numerator * n.denominator;
            });
            const onerous =
                memberId !== actorMemberId &&
                (root.kind === 'EXPENSE'
                    ? fixedDelta > 0n ||
                      variableDelta > 0 ||
                      uncertain ||
                      monthlyOnerous
                    : fixedDelta < 0n ||
                      variableDelta < 0 ||
                      uncertain ||
                      monthlyOnerous);
            return {
                memberId,
                currentFixedAmountInCents: a.fixed.toString(),
                proposedFixedAmountInCents: b.fixed.toString(),
                fixedDeltaInCents: fixedDelta.toString(),
                currentVariableWeight: a.variableWeight,
                proposedVariableWeight: b.variableWeight,
                variableWeightDelta: variableDelta,
                currentOccurrenceCount: a.occurrences,
                proposedOccurrenceCount: b.occurrences,
                requiresAcceptance: onerous,
            };
        });
        const materialized = allMaterialized.filter(
            (item) => item.referenceDate >= candidate.effectiveFrom,
        );
        return {
            effectiveFrom: candidate.effectiveFrom,
            assessmentThrough: new Date(
                Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 25, 0),
            )
                .toISOString()
                .slice(0, 10),
            currentVersion: root.economicVersion,
            proposedVersion: candidate.economicVersion,
            currentOccurrences: before.map((item) => item.referenceDate),
            proposedOccurrences: after.map((item) => item.referenceDate),
            impactByMember,
            requiresAcceptance: impactByMember.some(
                (row) => row.requiresAcceptance,
            ),
            materializedOccurrencesPreserved: materialized,
        };
    }
}
