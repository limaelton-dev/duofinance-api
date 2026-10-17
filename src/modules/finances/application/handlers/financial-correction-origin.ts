import type { FinancialCorrectionState } from '../../domain/corrections/financial-correction.js';
import { IncomeCommitment } from '../../domain/income/income-commitment.js';
import { FinancialCommitment } from '../../domain/shared-expense/financial-commitment.js';
import { ResponsibilitySplit } from '../../domain/shared-expense/responsibility-split.js';

export function financialCorrectionOrigin(
    state: FinancialCorrectionState,
    today: string,
) {
    const split = ResponsibilitySplit.fromEffectiveShares(
        state.amountInCents!,
        state.shares!,
    );
    if (state.kind === 'INCOME')
        return new IncomeCommitment(
            state.id,
            state.spaceId,
            state.description,
            state.amountInCents!,
            state.referenceDate ?? today,
            state.createdByPersonId,
            state.registeredAt,
            {
                type: 'SHARED',
                split,
                expectedRecipientMemberId: state.expectedMemberId,
                settlementRuleSnapshot: state.settlementRuleSnapshot,
                settlementRuleSourceVersion: state.settlementRuleSourceVersion,
            },
            state.facts.filter((fact) => fact.kind === 'RECEIPT'),
            Math.max(state.version, state.facts.length + 1),
            state.adjustments,
        );
    const facts = state.facts.map((fact, index) => ({
        ...fact,
        sequence: index + 1,
    }));
    return new FinancialCommitment(
        state.id,
        state.spaceId,
        state.description,
        state.createdByPersonId,
        state.registeredAt,
        {
            version: state.economicVersion,
            split,
            expectedPayerMemberId: state.expectedMemberId,
            factDate: null,
            expectedPaymentDate: state.referenceDate ?? today,
            settlementRuleSnapshot: state.settlementRuleSnapshot,
            settlementRuleSourceVersion: state.settlementRuleSourceVersion,
            suggestedTargetDate: null,
        },
        facts
            .filter((fact) => fact.kind === 'DISBURSEMENT')
            .map((fact) => ({
                id: fact.id,
                sequence: fact.sequence,
                payerMemberId: fact.payerMemberId!,
                method: fact.method,
                amountInCents: fact.amountInCents,
                factDate: fact.factDate,
                registeredAt: fact.registeredAt,
                recordedByPersonId: fact.recordedByPersonId,
            })),
        today,
        Math.max(state.version, state.facts.length + 1),
        facts
            .filter((fact) => fact.kind === 'EXTERNAL_LIABILITY')
            .map((fact) => ({
                id: fact.id,
                sequence: fact.sequence,
                holderMemberId: fact.holderMemberId!,
                amountInCents: fact.amountInCents,
                remainingAmountInCents: fact.amountInCents,
                factDate: fact.factDate,
                registeredAt: fact.registeredAt,
                recordedByPersonId: fact.recordedByPersonId,
            })),
        state.adjustments,
    );
}
