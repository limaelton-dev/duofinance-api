import { FinancesError } from '../../domain/errors/finances.error.js';
import { IncomeCommitment } from '../../domain/income/income-commitment.js';
import {
    FinancialOccurrence,
    type OccurrenceFact,
} from '../../domain/recurrence/financial-occurrence.js';
import { RecurringCommitment } from '../../domain/recurrence/recurring-commitment.js';
import { validFinancialAmount } from '../../domain/reversals/financial-fulfillment-reversal.js';
import { FinancialCommitment } from '../../domain/shared-expense/financial-commitment.js';
import { ResponsibilitySplit } from '../../domain/shared-expense/responsibility-split.js';
export function recurringFinancialOrigin(
    root: RecurringCommitment,
    occurrence: FinancialOccurrence,
    today: string,
) {
    const p = root.participation;
    if (p.type !== 'SHARED') throw new FinancesError('SHARED_SPACE_REQUIRED');
    if (root.kind === 'INCOME') {
        const receipts = occurrence.facts.filter(
            (f): f is Extract<OccurrenceFact, { kind: 'RECEIPT' }> =>
                f.kind === 'RECEIPT',
        );
        return new IncomeCommitment(
            root.id,
            root.spaceId,
            root.description,
            occurrence.amountInCents!,
            occurrence.referenceDate,
            root.createdByPersonId,
            root.registeredAt,
            {
                type: 'SHARED',
                split: occurrence.economicShares
                    ? ResponsibilitySplit.fromEffectiveShares(
                          occurrence.amountInCents!,
                          occurrence.economicShares,
                      )
                    : root.effectiveSplit(occurrence.amountInCents!)!,
                expectedRecipientMemberId: p.expectedMemberId,
                settlementRuleSnapshot: p.settlementRuleSnapshot,
                settlementRuleSourceVersion: p.settlementRuleSourceVersion,
            },
            receipts.map((f) => ({
                id: f.id,
                amountInCents: f.amountInCents,
                factDate: f.factDate,
                registeredAt: f.registeredAt,
                recordedByPersonId: f.recordedByPersonId,
                recipientMemberId: f.recipientMemberId,
                recipientPersonId: null,
            })),
            occurrence.stateVersion,
            occurrence.adjustments,
            null,
            occurrence.reversals,
        );
    }
    const disbursements = occurrence.facts
        .filter(
            (f): f is Extract<OccurrenceFact, { kind: 'DISBURSEMENT' }> =>
                f.kind === 'DISBURSEMENT',
        )
        .map((f) => ({
            id: f.id,
            sequence: occurrence.facts.indexOf(f) + 1,
            payerMemberId: f.payerMemberId!,
            method: f.method,
            amountInCents: f.amountInCents,
            factDate: f.factDate,
            registeredAt: f.registeredAt,
            recordedByPersonId: f.recordedByPersonId,
        }));
    const liabilities = occurrence.facts
        .filter(
            (f): f is Extract<OccurrenceFact, { kind: 'EXTERNAL_LIABILITY' }> =>
                f.kind === 'EXTERNAL_LIABILITY',
        )
        .map((f) => ({
            id: f.id,
            sequence: occurrence.facts.indexOf(f) + 1,
            holderMemberId: f.holderMemberId!,
            amountInCents: f.amountInCents,
            remainingAmountInCents: validFinancialAmount(
                f.amountInCents,
                occurrence.reversals,
                'EXTERNAL_LIABILITY',
                f.id,
            ),
            factDate: f.factDate,
            registeredAt: f.registeredAt,
            recordedByPersonId: f.recordedByPersonId,
        }));
    return new FinancialCommitment(
        root.id,
        root.spaceId,
        root.description,
        root.createdByPersonId,
        root.registeredAt,
        {
            version: 1,
            split: occurrence.economicShares
                ? ResponsibilitySplit.fromEffectiveShares(
                      occurrence.amountInCents!,
                      occurrence.economicShares,
                  )
                : root.effectiveSplit(occurrence.amountInCents!)!,
            expectedPayerMemberId: p.expectedMemberId,
            factDate: null,
            expectedPaymentDate: occurrence.referenceDate,
            settlementRuleSnapshot: p.settlementRuleSnapshot,
            settlementRuleSourceVersion: p.settlementRuleSourceVersion,
            suggestedTargetDate: null,
        },
        disbursements,
        today,
        occurrence.stateVersion,
        liabilities,
        occurrence.adjustments,
        null,
        occurrence.reversals.filter(
            (reversal) => reversal.originalKind !== 'EXTERNAL_SETTLEMENT',
        ),
    );
}
