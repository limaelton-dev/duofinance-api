import { FinancesError } from '../errors/finances.error.js';
import { Money } from '../shared-expense/money.js';
import { ResponsibilitySplit } from '../shared-expense/responsibility-split.js';
import type { SettlementRuleSnapshot } from '../settlement-rule/settlement-rule.js';
import { RecurrenceRule } from './recurrence-rule.js';

export type RecurringParticipation =
    | { type: 'PERSONAL'; ownerPersonId: string }
    | {
          type: 'SHARED';
          split: ResponsibilitySplit;
          expectedMemberId: string | null;
          settlementRuleSnapshot: SettlementRuleSnapshot | null;
          settlementRuleSourceVersion: number;
      };

export class RecurringCommitment {
    readonly modality = 'RECURRING';
    readonly participation: RecurringParticipation;

    constructor(
        readonly id: string,
        readonly spaceId: string,
        readonly kind: 'EXPENSE' | 'INCOME',
        readonly description: string,
        readonly amountInCents: number,
        readonly rule: RecurrenceRule,
        readonly createdByPersonId: string,
        readonly registeredAt: string,
        readonly economicVersion: number,
        readonly version: number,
        participation: RecurringParticipation,
    ) {
        Money.from(amountInCents);
        if (
            !id ||
            !spaceId ||
            !createdByPersonId ||
            !description.trim() ||
            description !== description.trim() ||
            description.length > 160 ||
            amountInCents < 1 ||
            !Number.isFinite(Date.parse(registeredAt)) ||
            !Number.isSafeInteger(economicVersion) ||
            economicVersion < 1 ||
            !Number.isSafeInteger(version) ||
            version < economicVersion ||
            (participation.type === 'PERSONAL'
                ? participation.ownerPersonId !== createdByPersonId
                : participation.split.total.amountInCents !== amountInCents ||
                  (participation.expectedMemberId !== null &&
                      !participation.split.shares.some(
                          (share) =>
                              share.memberId === participation.expectedMemberId,
                      )) ||
                  participation.settlementRuleSourceVersion < 0 ||
                  (participation.settlementRuleSnapshot === null) !==
                      (participation.settlementRuleSourceVersion === 0))
        )
            throw new FinancesError('VALIDATION_ERROR');
        this.participation = Object.freeze({ ...participation });
        Object.freeze(this);
    }

    project(month: string): {
        commitmentId: string;
        referenceDate: string;
        commitmentVersion: number;
        amountInCents: number;
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
