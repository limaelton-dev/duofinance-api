import type { SettlementRuleSnapshot } from '../settlement-rule/settlement-rule.js';
import { SettlementRule } from '../settlement-rule/settlement-rule.js';
import { FinancesError } from '../errors/finances.error.js';
import { ResponsibilitySplit } from './responsibility-split.js';
import { Money } from './money.js';
import { civilDate } from './settlement-cycle.js';
import { invalidExpense } from './validation.js';
export interface CommitmentVersion {
    readonly version: 1;
    readonly split: ResponsibilitySplit;
    readonly expectedPayerMemberId: string | null;
    readonly factDate: string;
    readonly settlementRuleSnapshot: SettlementRuleSnapshot | null;
    readonly settlementRuleSourceVersion: number;
    readonly suggestedTargetDate: string | null;
}
export interface Disbursement {
    readonly id: string;
    readonly payerMemberId: string;
    readonly method: 'PIX' | 'DEBIT' | 'CASH';
    readonly amountInCents: number;
    readonly factDate: string;
    readonly registeredAt: string;
    readonly recordedByPersonId?: string;
}
export interface PersonalCommitmentVersion {
    readonly version: 1;
    readonly ownerPersonId: string;
    readonly amount: Money;
    readonly factDate: string;
}
export interface PersonalDisbursement extends Omit<
    Disbursement,
    'payerMemberId'
> {
    readonly payerPersonId: string;
}
export type ExpenseVersion = CommitmentVersion | PersonalCommitmentVersion;
export type ExpenseDisbursement<V extends ExpenseVersion> =
    V extends CommitmentVersion ? Disbursement : PersonalDisbursement;
export class FinancialCommitment<V extends ExpenseVersion = CommitmentVersion> {
    readonly kind = 'EXPENSE';
    readonly modality = 'ONE_TIME';
    readonly initialVersion: V;
    readonly disbursement: ExpenseDisbursement<V>;
    readonly disbursements: readonly ExpenseDisbursement<V>[];
    readonly version: number;
    readonly paidAmountInCents: number;
    readonly remainingAmountInCents: number;
    readonly status: 'PARTIALLY_PAID' | 'PAID';
    constructor(
        readonly id: string,
        readonly spaceId: string,
        readonly description: string,
        readonly createdByPersonId: string,
        readonly registeredAt: string,
        initialVersion: V,
        payments: ExpenseDisbursement<V> | readonly ExpenseDisbursement<V>[],
        today: string,
        version?: number,
    ) {
        const facts: readonly ExpenseDisbursement<V>[] = Array.isArray(payments)
            ? payments
            : [payments as ExpenseDisbursement<V>];
        const personal = 'ownerPersonId' in initialVersion;
        const original = personal
            ? initialVersion.amount.amountInCents
            : initialVersion.split.total.amountInCents;
        Money.from(original);
        if (
            !id ||
            !spaceId ||
            !createdByPersonId ||
            initialVersion.version !== 1 ||
            original < 1 ||
            !description.trim() ||
            description !== description.trim() ||
            description.length > 160 ||
            !Number.isFinite(Date.parse(registeredAt)) ||
            civilDate(initialVersion.factDate) > civilDate(today) ||
            facts.length < 1 ||
            facts[0].factDate !== initialVersion.factDate ||
            facts[0].registeredAt !== registeredAt ||
            new Set(facts.map((fact) => fact.id)).size !== facts.length ||
            (version ?? facts.length) !== facts.length
        )
            invalidExpense();
        if (personal) {
            if (
                !initialVersion.ownerPersonId ||
                initialVersion.ownerPersonId !== createdByPersonId
            )
                invalidExpense();
        } else {
            if (
                !Number.isSafeInteger(
                    initialVersion.settlementRuleSourceVersion,
                ) ||
                initialVersion.settlementRuleSourceVersion < 0 ||
                (initialVersion.settlementRuleSnapshot === null) !==
                    (initialVersion.settlementRuleSourceVersion === 0) ||
                (initialVersion.expectedPayerMemberId !== null &&
                    !initialVersion.split.shares.some(
                        (s) =>
                            s.memberId === initialVersion.expectedPayerMemberId,
                    ))
            )
                invalidExpense();
            if (initialVersion.settlementRuleSnapshot)
                SettlementRule.from(initialVersion.settlementRuleSnapshot);
            if (initialVersion.suggestedTargetDate !== null) {
                civilDate(initialVersion.suggestedTargetDate);
                if (!initialVersion.settlementRuleSnapshot) invalidExpense();
            }
        }
        let total = 0n;
        for (const fact of facts) {
            Money.from(fact.amountInCents);
            if (
                !fact.id ||
                fact.id === id ||
                fact.amountInCents < 1 ||
                civilDate(fact.factDate) > civilDate(today) ||
                !Number.isFinite(Date.parse(fact.registeredAt)) ||
                !['PIX', 'DEBIT', 'CASH'].includes(fact.method) ||
                (personal
                    ? !('payerPersonId' in fact) ||
                      'payerMemberId' in fact ||
                      fact.payerPersonId !== initialVersion.ownerPersonId ||
                      (fact.recordedByPersonId !== undefined &&
                          fact.recordedByPersonId !==
                              initialVersion.ownerPersonId)
                    : !('payerMemberId' in fact) ||
                      'payerPersonId' in fact ||
                      !initialVersion.split.shares.some(
                          (s) => s.memberId === fact.payerMemberId,
                      ))
            )
                invalidExpense();
            total += BigInt(fact.amountInCents);
        }
        if (total > BigInt(original)) invalidExpense();
        this.initialVersion = Object.freeze(
            Object.assign(
                {},
                initialVersion,
                personal
                    ? {}
                    : {
                          settlementRuleSnapshot:
                              initialVersion.settlementRuleSnapshot
                                  ? Object.freeze({
                                        ...initialVersion.settlementRuleSnapshot,
                                    })
                                  : null,
                      },
            ),
        );
        this.disbursements = Object.freeze(
            facts.map((fact) =>
                Object.freeze({
                    ...fact,
                    recordedByPersonId:
                        fact.recordedByPersonId ?? createdByPersonId,
                }),
            ),
        ) as unknown as readonly ExpenseDisbursement<V>[];
        this.disbursement = this.disbursements[0];
        this.version = version ?? facts.length;
        this.paidAmountInCents = Number(total);
        this.remainingAmountInCents = original - this.paidAmountInCents;
        this.status =
            this.remainingAmountInCents === 0 ? 'PAID' : 'PARTIALLY_PAID';
        Object.freeze(this);
    }
    recordDisbursement(
        payment: ExpenseDisbursement<V>,
        expectedVersion: number,
        today: string,
    ): FinancialCommitment<V> {
        if (expectedVersion !== this.version)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        if (this.remainingAmountInCents === 0)
            throw new FinancesError('EXPENSE_ALREADY_PAID');
        return new FinancialCommitment(
            this.id,
            this.spaceId,
            this.description,
            this.createdByPersonId,
            this.registeredAt,
            this.initialVersion,
            [...this.disbursements, payment],
            today,
            this.version + 1,
        );
    }
}
