import { FinancesError } from '../errors/finances.error.js';
import { Money } from '../shared-expense/money.js';
import { civilDate } from '../shared-expense/settlement-cycle.js';

export type OccurrenceFact =
    | {
          kind: 'DISBURSEMENT';
          id: string;
          amountInCents: number;
          factDate: string;
          registeredAt: string;
          recordedByPersonId: string;
          payerMemberId: string | null;
          payerPersonId: string | null;
          method: 'PIX' | 'DEBIT' | 'CASH';
      }
    | {
          kind: 'RECEIPT';
          id: string;
          amountInCents: number;
          factDate: string;
          registeredAt: string;
          recordedByPersonId: string;
          recipientMemberId: string | null;
          recipientPersonId: string | null;
      }
    | {
          kind: 'EXTERNAL_LIABILITY';
          id: string;
          amountInCents: number;
          factDate: string;
          registeredAt: string;
          recordedByPersonId: string;
          holderMemberId: string | null;
          holderPersonId: string | null;
          remainingAmountInCents: number;
      };

export interface OccurrenceExternalSettlement {
    id: string;
    externalLiabilityId: string;
    amountInCents: number;
    factDate: string;
    registeredAt: string;
    recordedByPersonId: string;
}

export interface OccurrenceValueChange {
    version: number;
    previousAmountInCents: number | null;
    amountInCents: number;
    actorId: string;
    registeredAt: string;
}

export class FinancialOccurrence {
    readonly facts: readonly OccurrenceFact[];
    readonly externalSettlements: readonly OccurrenceExternalSettlement[];
    readonly valueHistory: readonly OccurrenceValueChange[];
    readonly fulfilledAmountInCents: number;
    readonly remainingAmountInCents: number | null;
    readonly valuePending: boolean;
    readonly status:
        'PENDING' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | 'CANCELLED';

    constructor(
        readonly id: string,
        readonly commitmentId: string,
        readonly spaceId: string,
        readonly referenceDate: string,
        readonly economicVersion: number,
        readonly stateVersion: number,
        readonly amountInCents: number | null,
        facts: readonly OccurrenceFact[],
        readonly materializedAt: string,
        status?: 'PENDING' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | 'CANCELLED',
        settlements: readonly OccurrenceExternalSettlement[] = [],
        valueHistory: readonly OccurrenceValueChange[] = [],
    ) {
        if (amountInCents !== null) Money.from(amountInCents);
        civilDate(referenceDate);
        if (
            !id ||
            !commitmentId ||
            !spaceId ||
            (amountInCents !== null && amountInCents < 1) ||
            !Number.isInteger(economicVersion) ||
            economicVersion < 1 ||
            !Number.isInteger(stateVersion) ||
            stateVersion < 1 ||
            !Number.isFinite(Date.parse(materializedAt)) ||
            new Set(facts.map((fact) => fact.id)).size !== facts.length
        )
            throw new FinancesError('VALIDATION_ERROR');
        let fulfilled = 0n;
        for (const fact of facts) {
            Money.from(fact.amountInCents);
            civilDate(fact.factDate);
            if (
                !fact.id ||
                fact.amountInCents < 1 ||
                !fact.recordedByPersonId ||
                !Number.isFinite(Date.parse(fact.registeredAt)) ||
                (fact.kind === 'EXTERNAL_LIABILITY' &&
                    (fact.remainingAmountInCents < 0 ||
                        fact.remainingAmountInCents > fact.amountInCents))
            )
                throw new FinancesError('VALIDATION_ERROR');
            fulfilled += BigInt(fact.amountInCents);
        }
        if (amountInCents === null && fulfilled > 0n)
            throw new FinancesError('OCCURRENCE_VALUE_REQUIRED');
        if (amountInCents !== null && fulfilled > BigInt(amountInCents))
            throw new FinancesError('VALIDATION_ERROR', ['amountInCents']);
        if (valueHistory.length) {
            let previous: number | null = null;
            for (const [index, change] of valueHistory.entries()) {
                Money.from(change.amountInCents);
                if (
                    change.version !== index + 2 ||
                    change.previousAmountInCents !== previous ||
                    !change.actorId ||
                    !Number.isFinite(Date.parse(change.registeredAt))
                )
                    throw new FinancesError('VALIDATION_ERROR');
                previous = change.amountInCents;
            }
            if (
                previous !== amountInCents ||
                stateVersion < valueHistory.at(-1)!.version
            )
                throw new FinancesError('VALIDATION_ERROR');
        }
        if (
            new Set(settlements.map((item) => item.id)).size !==
            settlements.length
        )
            throw new FinancesError('VALIDATION_ERROR');
        for (const settlement of settlements) {
            Money.from(settlement.amountInCents);
            civilDate(settlement.factDate);
            if (
                settlement.amountInCents < 1 ||
                !settlement.recordedByPersonId ||
                !Number.isFinite(Date.parse(settlement.registeredAt))
            )
                throw new FinancesError('VALIDATION_ERROR');
        }
        for (const fact of facts.filter(
            (f): f is Extract<OccurrenceFact, { kind: 'EXTERNAL_LIABILITY' }> =>
                f.kind === 'EXTERNAL_LIABILITY',
        )) {
            const paid = settlements
                .filter((item) => item.externalLiabilityId === fact.id)
                .reduce(
                    (total, item) => total + BigInt(item.amountInCents),
                    0n,
                );
            if (
                paid !==
                BigInt(fact.amountInCents - fact.remainingAmountInCents)
            )
                throw new FinancesError('VALIDATION_ERROR');
        }
        if (
            settlements.some(
                (item) =>
                    !facts.some(
                        (fact) =>
                            fact.kind === 'EXTERNAL_LIABILITY' &&
                            fact.id === item.externalLiabilityId,
                    ),
            )
        )
            throw new FinancesError('VALIDATION_ERROR');
        this.facts = Object.freeze(
            facts.map((fact) => Object.freeze({ ...fact })),
        );
        this.externalSettlements = Object.freeze(
            settlements.map((item) => Object.freeze({ ...item })),
        );
        this.valueHistory = Object.freeze(
            valueHistory.map((item) => Object.freeze({ ...item })),
        );
        this.fulfilledAmountInCents = Number(fulfilled);
        this.remainingAmountInCents =
            amountInCents === null
                ? null
                : amountInCents - this.fulfilledAmountInCents;
        this.valuePending = amountInCents === null;
        this.status =
            status ??
            (fulfilled === 0n
                ? 'PENDING'
                : this.remainingAmountInCents === 0
                  ? 'FULFILLED'
                  : 'PARTIALLY_FULFILLED');
        if (
            this.status !== 'CANCELLED' &&
            this.status !==
                (fulfilled === 0n
                    ? 'PENDING'
                    : this.remainingAmountInCents === 0
                      ? 'FULFILLED'
                      : 'PARTIALLY_FULFILLED')
        )
            throw new FinancesError('VALIDATION_ERROR');
        Object.freeze(this);
    }

    record(
        fact: OccurrenceFact,
        expectedStateVersion: number,
        today: string,
    ): FinancialOccurrence {
        if (this.stateVersion !== expectedStateVersion)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        if (this.status === 'CANCELLED' || this.remainingAmountInCents === 0)
            throw new FinancesError('OCCURRENCE_ALREADY_RESOLVED');
        if (this.amountInCents === null)
            throw new FinancesError('OCCURRENCE_VALUE_REQUIRED');
        if (civilDate(fact.factDate) > civilDate(today))
            throw new FinancesError('VALIDATION_ERROR', ['factDate']);
        return new FinancialOccurrence(
            this.id,
            this.commitmentId,
            this.spaceId,
            this.referenceDate,
            this.economicVersion,
            this.stateVersion + 1,
            this.amountInCents,
            [...this.facts, fact],
            this.materializedAt,
            undefined,
            this.externalSettlements,
            this.valueHistory,
        );
    }

    defineValue(
        amountInCents: number,
        expectedStateVersion: number,
        actorId: string,
        now: string,
    ): FinancialOccurrence {
        Money.from(amountInCents);
        if (amountInCents < 1)
            throw new FinancesError('VALIDATION_ERROR', ['amountInCents']);
        if (this.stateVersion !== expectedStateVersion)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        if (
            this.status === 'CANCELLED' ||
            this.facts.length ||
            this.externalSettlements.length
        )
            throw new FinancesError('OCCURRENCE_ALREADY_RESOLVED');
        return new FinancialOccurrence(
            this.id,
            this.commitmentId,
            this.spaceId,
            this.referenceDate,
            this.economicVersion,
            this.stateVersion + 1,
            amountInCents,
            this.facts,
            this.materializedAt,
            'PENDING',
            this.externalSettlements,
            [
                ...this.valueHistory,
                {
                    version: this.stateVersion + 1,
                    previousAmountInCents: this.amountInCents,
                    amountInCents,
                    actorId,
                    registeredAt: now,
                },
            ],
        );
    }
}
