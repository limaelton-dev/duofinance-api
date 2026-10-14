import type { SettlementRuleSnapshot } from '../settlement-rule/settlement-rule.js';
import { SettlementRule } from '../settlement-rule/settlement-rule.js';
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
    constructor(
        readonly id: string,
        readonly spaceId: string,
        readonly description: string,
        readonly createdByPersonId: string,
        readonly registeredAt: string,
        initialVersion: V,
        disbursement: ExpenseDisbursement<V>,
        today: string,
    ) {
        const immutableDisbursement = Object.freeze(
            Object.assign({}, disbursement),
        ) as ExpenseDisbursement<V>;
        if ('ownerPersonId' in initialVersion) {
            Money.from(initialVersion.amount.amountInCents);
            if (
                !id ||
                !disbursement.id ||
                id === disbursement.id ||
                initialVersion.version !== 1 ||
                !initialVersion.ownerPersonId ||
                createdByPersonId !== initialVersion.ownerPersonId ||
                !('payerPersonId' in disbursement) ||
                'payerMemberId' in disbursement ||
                disbursement.payerPersonId !== initialVersion.ownerPersonId ||
                !description.trim() ||
                description !== description.trim() ||
                description.length > 160 ||
                initialVersion.amount.amountInCents < 1 ||
                disbursement.amountInCents !==
                    initialVersion.amount.amountInCents ||
                civilDate(initialVersion.factDate) > civilDate(today) ||
                disbursement.factDate !== initialVersion.factDate ||
                !Number.isFinite(Date.parse(registeredAt)) ||
                disbursement.registeredAt !== registeredAt ||
                !['PIX', 'DEBIT', 'CASH'].includes(disbursement.method)
            )
                invalidExpense();
            this.initialVersion = Object.freeze(
                Object.assign({}, initialVersion),
            );
            this.disbursement = immutableDisbursement;
            Object.freeze(this);
            return;
        }
        if (
            !('payerMemberId' in disbursement) ||
            'payerPersonId' in disbursement
        )
            invalidExpense();
        if (
            initialVersion.version !== 1 ||
            !Number.isSafeInteger(initialVersion.settlementRuleSourceVersion) ||
            initialVersion.settlementRuleSourceVersion < 0 ||
            (initialVersion.settlementRuleSnapshot === null) !==
                (initialVersion.settlementRuleSourceVersion === 0) ||
            !Number.isFinite(Date.parse(registeredAt)) ||
            disbursement.registeredAt !== registeredAt
        )
            invalidExpense();
        if (initialVersion.settlementRuleSnapshot)
            SettlementRule.from(initialVersion.settlementRuleSnapshot);
        if (initialVersion.suggestedTargetDate !== null) {
            civilDate(initialVersion.suggestedTargetDate);
            if (!initialVersion.settlementRuleSnapshot) invalidExpense();
        }
        if (
            !description.trim() ||
            description !== description.trim() ||
            description.length > 160 ||
            civilDate(initialVersion.factDate) > civilDate(today) ||
            (initialVersion.expectedPayerMemberId !== null &&
                !initialVersion.split.shares.some(
                    (s) => s.memberId === initialVersion.expectedPayerMemberId,
                )) ||
            !initialVersion.split.shares.some(
                (s) => s.memberId === disbursement.payerMemberId,
            ) ||
            disbursement.amountInCents !==
                initialVersion.split.total.amountInCents ||
            disbursement.factDate !== initialVersion.factDate ||
            !['PIX', 'DEBIT', 'CASH'].includes(disbursement.method)
        )
            invalidExpense();
        this.initialVersion = Object.freeze(
            Object.assign({}, initialVersion, {
                settlementRuleSnapshot: initialVersion.settlementRuleSnapshot
                    ? Object.freeze({
                          ...initialVersion.settlementRuleSnapshot,
                      })
                    : null,
            }),
        );
        this.disbursement = immutableDisbursement;
        Object.freeze(this);
    }
}
