import type { SettlementRuleSnapshot } from '../settlement-rule/settlement-rule.js';
import { SettlementRule } from '../settlement-rule/settlement-rule.js';
import { ResponsibilitySplit } from './responsibility-split.js';
import { civilDate } from './settlement-cycle.js';
import { invalidExpense } from './validation.js';
export interface CommitmentVersion {
    readonly version: 1;
    readonly split: ResponsibilitySplit;
    readonly expectedPayerMemberId: string;
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
export class FinancialCommitment {
    readonly kind = 'EXPENSE';
    readonly modality = 'ONE_TIME';
    readonly initialVersion: CommitmentVersion;
    readonly disbursement: Disbursement;
    constructor(
        readonly id: string,
        readonly spaceId: string,
        readonly description: string,
        readonly createdByPersonId: string,
        readonly registeredAt: string,
        initialVersion: CommitmentVersion,
        disbursement: Disbursement,
        today: string,
    ) {
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
            !initialVersion.split.shares.some(
                (s) => s.memberId === initialVersion.expectedPayerMemberId,
            ) ||
            !initialVersion.split.shares.some(
                (s) => s.memberId === disbursement.payerMemberId,
            ) ||
            disbursement.amountInCents !==
                initialVersion.split.total.amountInCents ||
            disbursement.factDate !== initialVersion.factDate ||
            !['PIX', 'DEBIT', 'CASH'].includes(disbursement.method)
        )
            invalidExpense();
        this.initialVersion = Object.freeze({
            ...initialVersion,
            settlementRuleSnapshot: initialVersion.settlementRuleSnapshot
                ? Object.freeze({ ...initialVersion.settlementRuleSnapshot })
                : null,
        });
        this.disbursement = Object.freeze({ ...disbursement });
        Object.freeze(this);
    }
}
