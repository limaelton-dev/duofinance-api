import { FinancesError } from '../errors/finances.error.js';
import { Money } from '../shared-expense/money.js';
import {
    ResponsibilitySplit,
    type SplitInput,
} from '../shared-expense/responsibility-split.js';
import type { SettlementRuleSnapshot } from '../settlement-rule/settlement-rule.js';
import { RecurrenceRule } from './recurrence-rule.js';

export type RecurringParticipation =
    | { type: 'PERSONAL'; ownerPersonId: string }
    | {
          type: 'SHARED';
          split: ResponsibilitySplit | null;
          distribution: SplitInput;
          expectedMemberId: string | null;
          settlementRuleSnapshot: SettlementRuleSnapshot | null;
          settlementRuleSourceVersion: number;
      };

export interface RecurringVersion {
    effectiveFrom: string;
    configuration: RecurringCommitment;
}

export class RecurringCommitment {
    readonly modality = 'RECURRING';
    readonly participation: RecurringParticipation;

    constructor(
        readonly id: string,
        readonly spaceId: string,
        readonly kind: 'EXPENSE' | 'INCOME',
        readonly description: string,
        readonly amountInCents: number | null,
        readonly rule: RecurrenceRule,
        readonly createdByPersonId: string,
        readonly registeredAt: string,
        readonly economicVersion: number,
        readonly version: number,
        participation: RecurringParticipation,
        readonly valueMode: 'FIXED' | 'VARIABLE' = 'FIXED',
        readonly effectiveFrom: string = rule.startsOn,
        readonly versions: readonly RecurringVersion[] = [],
        readonly terminatedOn: string | null = null,
    ) {
        if (amountInCents !== null) Money.from(amountInCents);
        if (
            !id ||
            !spaceId ||
            !createdByPersonId ||
            !description.trim() ||
            description !== description.trim() ||
            description.length > 160 ||
            (amountInCents !== null && amountInCents < 1) ||
            (valueMode === 'FIXED' && amountInCents === null) ||
            !Number.isFinite(Date.parse(registeredAt)) ||
            !Number.isSafeInteger(economicVersion) ||
            economicVersion < 1 ||
            !Number.isSafeInteger(version) ||
            version < economicVersion ||
            (terminatedOn !== null &&
                !/^\d{4}-\d{2}-\d{2}$/.test(terminatedOn)) ||
            (participation.type === 'PERSONAL'
                ? !participation.ownerPersonId
                : (valueMode === 'FIXED'
                      ? participation.split === null ||
                        participation.split.total.amountInCents !==
                            amountInCents ||
                        participation.distribution.mode !==
                            participation.split.original.mode
                      : participation.split !== null ||
                        participation.distribution.mode !== 'PERCENTAGES' ||
                        participation.distribution.shares.length < 1 ||
                        participation.distribution.shares.length > 2 ||
                        new Set(
                            participation.distribution.shares.map(
                                (s) => s.memberId,
                            ),
                        ).size !== participation.distribution.shares.length ||
                        participation.distribution.shares.some(
                            (s) =>
                                !('basisPoints' in s) ||
                                !Number.isInteger(s.basisPoints) ||
                                s.basisPoints < 0 ||
                                s.basisPoints > 10000,
                        ) ||
                        participation.distribution.shares.reduce(
                            (sum, s) =>
                                sum + ('basisPoints' in s ? s.basisPoints : 0),
                            0,
                        ) !== 10000) ||
                  (participation.expectedMemberId !== null &&
                      !participation.distribution.shares.some(
                          (share) =>
                              share.memberId === participation.expectedMemberId,
                      )) ||
                  participation.settlementRuleSourceVersion < 0 ||
                  (participation.settlementRuleSnapshot === null) !==
                      (participation.settlementRuleSourceVersion === 0))
        )
            throw new FinancesError('VALIDATION_ERROR');
        this.participation = Object.freeze({ ...participation });
        this.versions = Object.freeze([...versions]);
        Object.freeze(this);
    }

    effectiveVersionAt(referenceDate: string): RecurringCommitment | null {
        if (this.terminatedOn && referenceDate > this.terminatedOn) return null;
        const versions = this.versions.length
            ? this.versions
            : [{ effectiveFrom: this.effectiveFrom, configuration: this }];
        const selected = [...versions]
            .reverse()
            .find((v) => v.effectiveFrom <= referenceDate);
        return selected?.configuration ?? null;
    }

    configurationAt(referenceDate: string): RecurringCommitment | null {
        const selected = this.effectiveVersionAt(referenceDate);
        return selected?.rule.contains(referenceDate) ? selected : null;
    }

    configurationForVersion(version: number): RecurringCommitment | null {
        return (
            this.versions.find(
                (v) => v.configuration.economicVersion === version,
            )?.configuration ?? (this.economicVersion === version ? this : null)
        );
    }

    projections(month: string) {
        const versions = this.versions.length
            ? this.versions
            : [{ effectiveFrom: this.effectiveFrom, configuration: this }];
        const eligible = versions
            .map((v) => v.configuration.project(month))
            .filter(
                (p): p is NonNullable<typeof p> =>
                    p !== null &&
                    this.configurationAt(p.referenceDate)?.economicVersion ===
                        p.commitmentVersion,
            )
            .sort((a, b) => a.referenceDate.localeCompare(b.referenceDate));
        return eligible.slice(0, 1);
    }

    projectedConfigurationAt(
        referenceDate: string,
    ): RecurringCommitment | null {
        const projection = this.projections(referenceDate.slice(0, 7))[0];
        return projection?.referenceDate === referenceDate
            ? this.configurationForVersion(projection.commitmentVersion)
            : null;
    }

    effectiveSplit(amountInCents: number): ResponsibilitySplit | null {
        if (this.participation.type !== 'SHARED') return null;
        return this.valueMode === 'FIXED'
            ? this.participation.split
            : ResponsibilitySplit.create(
                  amountInCents,
                  this.participation.distribution.shares.map((s) => s.memberId),
                  this.participation.distribution,
              );
    }

    project(month: string): {
        commitmentId: string;
        referenceDate: string;
        commitmentVersion: number;
        amountInCents: number | null;
    } | null {
        const referenceDate = this.rule.dateInMonth(month);
        return referenceDate
            ? {
                  commitmentId: this.id,
                  referenceDate,
                  commitmentVersion: this.economicVersion,
                  amountInCents: this.amountInCents,
              }
            : null;
    }
}
