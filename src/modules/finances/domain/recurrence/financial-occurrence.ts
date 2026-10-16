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

export class FinancialOccurrence {
    readonly facts: readonly OccurrenceFact[];
    readonly externalSettlements: readonly OccurrenceExternalSettlement[];
    readonly fulfilledAmountInCents: number;
    readonly remainingAmountInCents: number;
    readonly status:
        'PENDING' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | 'CANCELLED';

    constructor(
        readonly id: string,
        readonly commitmentId: string,
        readonly spaceId: string,
        readonly referenceDate: string,
        readonly economicVersion: number,
        readonly stateVersion: number,
        readonly amountInCents: number,
        facts: readonly OccurrenceFact[],
        readonly materializedAt: string,
        status?: 'PENDING' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | 'CANCELLED',
        settlements: readonly OccurrenceExternalSettlement[] = [],
    ) {
        Money.from(amountInCents);
        civilDate(referenceDate);
        if (
            !id ||
            !commitmentId ||
            !spaceId ||
            amountInCents < 1 ||
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
        if (fulfilled > BigInt(amountInCents))
            throw new FinancesError('VALIDATION_ERROR', ['amountInCents']);
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
        this.fulfilledAmountInCents = Number(fulfilled);
        this.remainingAmountInCents =
            amountInCents - this.fulfilledAmountInCents;
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
        );
    }
}
