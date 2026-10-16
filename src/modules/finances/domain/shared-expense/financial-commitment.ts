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
    readonly factDate: string | null;
    readonly expectedPaymentDate?: string | null;
    readonly settlementRuleSnapshot: SettlementRuleSnapshot | null;
    readonly settlementRuleSourceVersion: number;
    readonly suggestedTargetDate: string | null;
}
export interface Disbursement {
    readonly id: string;
    readonly sequence?: number;
    readonly payerMemberId: string;
    readonly method: 'PIX' | 'DEBIT' | 'CASH';
    readonly amountInCents: number;
    readonly factDate: string;
    readonly registeredAt: string;
    readonly recordedByPersonId?: string;
}
export interface ExternalLiabilitySettlement {
    readonly id: string;
    readonly externalLiabilityId: string;
    readonly sequence: number;
    readonly holderMemberId?: string;
    readonly holderPersonId?: string;
    readonly amountInCents: number;
    readonly factDate: string;
    readonly registeredAt: string;
    readonly recordedByPersonId: string;
}
export interface ExternalLiability {
    readonly settlements?: readonly ExternalLiabilitySettlement[];
    readonly id: string;
    readonly sequence?: number;
    readonly holderMemberId: string;
    readonly amountInCents: number;
    readonly remainingAmountInCents: number;
    readonly factDate: string;
    readonly registeredAt: string;
    readonly recordedByPersonId: string;
}
export interface PersonalExternalLiability extends Omit<
    ExternalLiability,
    'holderMemberId'
> {
    readonly holderPersonId: string;
}
export type ExpenseExternalLiability<V extends ExpenseVersion> =
    V extends CommitmentVersion ? ExternalLiability : PersonalExternalLiability;
export interface PersonalCommitmentVersion {
    readonly version: 1;
    readonly ownerPersonId: string;
    readonly amount: Money;
    readonly factDate: string | null;
    readonly expectedPaymentDate?: string | null;
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
    readonly disbursement: ExpenseDisbursement<V> | null;
    readonly disbursements: readonly ExpenseDisbursement<V>[];
    readonly externalLiabilities: readonly ExpenseExternalLiability<V>[];
    readonly fulfillments: readonly (
        ExpenseDisbursement<V> | ExpenseExternalLiability<V>
    )[];
    readonly assumedAmountInCents: number;
    readonly externalOutstandingAmountInCents: number;
    readonly externalSettledAmountInCents: number;
    readonly supportedAmountInCents: number;
    readonly fulfillmentStatus: 'PENDING' | 'PARTIALLY_FULFILLED' | 'FULFILLED';
    readonly version: number;
    readonly paidAmountInCents: number;
    readonly remainingAmountInCents: number;
    readonly overdue: boolean;
    readonly status:
        | 'PENDING'
        | 'PARTIALLY_PAID'
        | 'PAID'
        | 'PARTIALLY_FULFILLED'
        | 'FULFILLED';
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
        liabilities: readonly ExpenseExternalLiability<V>[] = [],
    ) {
        const facts: readonly ExpenseDisbursement<V>[] = Array.isArray(payments)
            ? payments
            : [payments as ExpenseDisbursement<V>];
        const all = [...facts, ...liabilities]
            .map((f, index) => ({ ...f, sequence: f.sequence ?? index + 1 }))
            .sort((a, b) => a.sequence - b.sequence);
        const settlements = liabilities.flatMap((f) => f.settlements ?? []);
        const events = [...all, ...settlements].sort(
            (a, b) => a.sequence - b.sequence,
        );
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
            (initialVersion.factDate !== null &&
                civilDate(initialVersion.factDate) > civilDate(today)) ||
            (initialVersion.factDate === null &&
                !initialVersion.expectedPaymentDate) ||
            (initialVersion.expectedPaymentDate !== undefined &&
                initialVersion.expectedPaymentDate !== null &&
                !civilDate(initialVersion.expectedPaymentDate)) ||
            (initialVersion.factDate !== null &&
                (all.length < 1 ||
                    all[0].factDate !== initialVersion.factDate ||
                    all[0].registeredAt !== registeredAt)) ||
            new Set(events.map((fact) => fact.id)).size !== events.length ||
            events.some((f, index) => f.sequence !== index + 1) ||
            !Number.isSafeInteger(version ?? Math.max(1, events.length)) ||
            (version ?? Math.max(1, events.length)) < Math.max(1, events.length)
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
        let assumed = 0n;
        let settled = 0n;
        for (const fact of liabilities) {
            Money.from(fact.amountInCents);
            let liabilitySettled = 0n;
            for (const payment of fact.settlements ?? []) {
                Money.from(payment.amountInCents);
                if (
                    !payment.id ||
                    payment.id === id ||
                    payment.amountInCents < 1 ||
                    payment.externalLiabilityId !== fact.id ||
                    payment.sequence <=
                        all.find((f) => f.id === fact.id)!.sequence ||
                    civilDate(payment.factDate) > civilDate(today) ||
                    !Number.isFinite(Date.parse(payment.registeredAt)) ||
                    !payment.recordedByPersonId ||
                    (personal
                        ? payment.holderPersonId !==
                              initialVersion.ownerPersonId ||
                          payment.holderMemberId !== undefined ||
                          payment.recordedByPersonId !==
                              initialVersion.ownerPersonId
                        : !('holderMemberId' in fact) ||
                          payment.holderMemberId !== fact.holderMemberId ||
                          payment.holderPersonId !== undefined)
                )
                    invalidExpense();
                liabilitySettled += BigInt(payment.amountInCents);
            }
            if (
                liabilitySettled > BigInt(fact.amountInCents) ||
                fact.remainingAmountInCents !==
                    fact.amountInCents - Number(liabilitySettled)
            )
                invalidExpense();
            settled += liabilitySettled;
            if (
                !fact.id ||
                fact.id === id ||
                fact.amountInCents < 1 ||
                civilDate(fact.factDate) > civilDate(today) ||
                !Number.isFinite(Date.parse(fact.registeredAt)) ||
                !fact.recordedByPersonId ||
                (personal
                    ? !('holderPersonId' in fact) ||
                      'holderMemberId' in fact ||
                      fact.holderPersonId !== initialVersion.ownerPersonId ||
                      fact.recordedByPersonId !== initialVersion.ownerPersonId
                    : !('holderMemberId' in fact) ||
                      'holderPersonId' in fact ||
                      !initialVersion.split.shares.some(
                          (s) => s.memberId === fact.holderMemberId,
                      ))
            )
                invalidExpense();
            assumed += BigInt(fact.amountInCents);
        }
        if (total + assumed > BigInt(original)) invalidExpense();
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
                    sequence: all.find((f) => f.id === fact.id)!.sequence,
                    recordedByPersonId:
                        fact.recordedByPersonId ?? createdByPersonId,
                }),
            ),
        ) as unknown as readonly ExpenseDisbursement<V>[];
        this.externalLiabilities = Object.freeze(
            liabilities.map((f) =>
                Object.freeze({
                    ...f,
                    settlements: Object.freeze(
                        (f.settlements ?? []).map((s) =>
                            Object.freeze({ ...s }),
                        ),
                    ),
                    sequence: all.find((a) => a.id === f.id)!.sequence,
                }),
            ),
        ) as unknown as readonly ExpenseExternalLiability<V>[];
        this.fulfillments = Object.freeze(
            [...this.disbursements, ...this.externalLiabilities].sort(
                (a, b) => a.sequence! - b.sequence!,
            ),
        );
        this.disbursement = this.disbursements[0] ?? null;
        this.version = version ?? Math.max(1, events.length);
        this.assumedAmountInCents = Number(assumed);
        this.externalOutstandingAmountInCents = Number(assumed - settled);
        this.externalSettledAmountInCents = Number(settled);
        this.supportedAmountInCents = Number(total + assumed);
        this.paidAmountInCents = Number(total);
        this.remainingAmountInCents = original - this.supportedAmountInCents;
        this.overdue =
            initialVersion.expectedPaymentDate != null &&
            initialVersion.expectedPaymentDate < today &&
            this.remainingAmountInCents > 0;
        this.fulfillmentStatus =
            events.length === 0
                ? 'PENDING'
                : this.remainingAmountInCents === 0
                  ? 'FULFILLED'
                  : 'PARTIALLY_FULFILLED';
        this.status =
            events.length === 0
                ? 'PENDING'
                : liabilities.length
                  ? this.fulfillmentStatus
                  : this.remainingAmountInCents === 0
                    ? 'PAID'
                    : 'PARTIALLY_PAID';
        Object.freeze(this);
    }
    settleExternalLiability(
        externalLiabilityId: string,
        payment: Omit<
            ExternalLiabilitySettlement,
            | 'sequence'
            | 'externalLiabilityId'
            | 'holderMemberId'
            | 'holderPersonId'
        >,
        expectedVersion: number,
        today: string,
    ): FinancialCommitment<V> {
        if (expectedVersion !== this.version)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        const liability = this.externalLiabilities.find(
            (f) => f.id === externalLiabilityId,
        );
        if (!liability) throw new FinancesError('EXTERNAL_LIABILITY_NOT_FOUND');
        if (liability.remainingAmountInCents === 0)
            throw new FinancesError('EXTERNAL_LIABILITY_ALREADY_SETTLED');
        const settlement: ExternalLiabilitySettlement = {
            ...payment,
            externalLiabilityId,
            sequence: this.nextFactSequence,
            ...('holderMemberId' in liability
                ? { holderMemberId: liability.holderMemberId }
                : { holderPersonId: liability.holderPersonId }),
        };
        return new FinancialCommitment(
            this.id,
            this.spaceId,
            this.description,
            this.createdByPersonId,
            this.registeredAt,
            this.initialVersion,
            this.disbursements,
            today,
            this.version + 1,
            this.externalLiabilities.map((f) =>
                f.id === externalLiabilityId
                    ? {
                          ...f,
                          remainingAmountInCents:
                              f.remainingAmountInCents - payment.amountInCents,
                          settlements: [...(f.settlements ?? []), settlement],
                      }
                    : f,
            ) as readonly ExpenseExternalLiability<V>[],
        );
    }
    recordExternalLiability(
        liability: ExpenseExternalLiability<V>,
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
            this.disbursements,
            today,
            this.version + 1,
            [
                ...this.externalLiabilities,
                { ...liability, sequence: this.nextFactSequence },
            ],
        );
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
            [
                ...this.disbursements,
                { ...payment, sequence: this.nextFactSequence },
            ],
            today,
            this.version + 1,
            this.externalLiabilities,
        );
    }
    private get nextFactSequence(): number {
        return (
            this.fulfillments.length +
            this.externalLiabilities.reduce(
                (count, liability) =>
                    count + (liability.settlements?.length ?? 0),
                0,
            ) +
            1
        );
    }
}
