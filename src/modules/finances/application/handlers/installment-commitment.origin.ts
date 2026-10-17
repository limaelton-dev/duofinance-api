import { FinancesError } from '../../domain/errors/finances.error.js';
import { InstallmentCommitment } from '../../domain/installment/installment-commitment.js';
import {
    FinancialOccurrence,
    type OccurrenceFact,
} from '../../domain/recurrence/financial-occurrence.js';
import { FinancialCommitment } from '../../domain/shared-expense/financial-commitment.js';
import { ResponsibilitySplit } from '../../domain/shared-expense/responsibility-split.js';

export function synthetic(
    root: InstallmentCommitment,
    occurrence: FinancialOccurrence,
    today: string,
) {
    const p = root.participation;
    if (p.type !== 'SHARED') throw new FinancesError('SHARED_SPACE_REQUIRED');
    const installment = root.plan.installments.find(
        (item) => item.id === occurrence.id,
    )!;
    const shares = root.effectiveSharesFor(installment.position)!;
    const split = ResponsibilitySplit.create(
        installment.effectiveAmountInCents,
        shares.map((share) => share.memberId),
        { mode: 'AMOUNTS', shares: shares.map((share) => ({ ...share })) },
    );
    const disbursements = occurrence.facts
        .filter(
            (fact): fact is Extract<OccurrenceFact, { kind: 'DISBURSEMENT' }> =>
                fact.kind === 'DISBURSEMENT',
        )
        .map((fact) => ({
            id: fact.id,
            sequence: occurrence.facts.indexOf(fact) + 1,
            payerMemberId: fact.payerMemberId!,
            method: fact.method,
            amountInCents: fact.amountInCents,
            factDate: fact.factDate,
            registeredAt: fact.registeredAt,
            recordedByPersonId: fact.recordedByPersonId,
        }));
    const liabilities = occurrence.facts
        .filter(
            (
                fact,
            ): fact is Extract<
                OccurrenceFact,
                { kind: 'EXTERNAL_LIABILITY' }
            > => fact.kind === 'EXTERNAL_LIABILITY',
        )
        .map((fact) => ({
            id: fact.id,
            sequence: occurrence.facts.indexOf(fact) + 1,
            holderMemberId: fact.holderMemberId!,
            amountInCents: fact.amountInCents,
            remainingAmountInCents: fact.amountInCents,
            factDate: fact.factDate,
            registeredAt: fact.registeredAt,
            recordedByPersonId: fact.recordedByPersonId,
        }));
    return new FinancialCommitment(
        root.id,
        root.spaceId,
        root.description,
        root.createdByPersonId,
        root.registeredAt,
        {
            version: 1,
            split,
            expectedPayerMemberId:
                installment.expectedMemberId === undefined
                    ? p.expectedMemberId
                    : installment.expectedMemberId,
            factDate: null,
            expectedPaymentDate: installment.dueDate,
            settlementRuleSnapshot: p.settlementRuleSnapshot,
            settlementRuleSourceVersion: p.settlementRuleSourceVersion,
            suggestedTargetDate: null,
        },
        disbursements,
        today,
        occurrence.stateVersion,
        liabilities,
    );
}

export function syntheticPayoff(
    root: InstallmentCommitment,
    impact: ReturnType<InstallmentCommitment['payoffImpact']>,
    fact: Extract<OccurrenceFact, { kind: 'DISBURSEMENT' }>,
    today: string,
) {
    const p = root.participation;
    if (p.type !== 'SHARED' || !impact.effectiveEconomicShares)
        throw new FinancesError('SHARED_SPACE_REQUIRED');
    const shares = impact.effectiveEconomicShares;
    const split = ResponsibilitySplit.create(
        impact.paidAmountInCents,
        shares.map((share) => share.memberId),
        { mode: 'AMOUNTS', shares: shares.map((share) => ({ ...share })) },
    );
    return new FinancialCommitment(
        root.id,
        root.spaceId,
        root.description,
        root.createdByPersonId,
        root.registeredAt,
        {
            version: 1,
            split,
            expectedPayerMemberId: p.expectedMemberId,
            factDate: null,
            expectedPaymentDate: fact.factDate,
            settlementRuleSnapshot: p.settlementRuleSnapshot,
            settlementRuleSourceVersion: p.settlementRuleSourceVersion,
            suggestedTargetDate: null,
        },
        [
            {
                id: fact.id,
                sequence: 1,
                payerMemberId: fact.payerMemberId!,
                method: fact.method,
                amountInCents: fact.amountInCents,
                factDate: fact.factDate,
                registeredAt: fact.registeredAt,
                recordedByPersonId: fact.recordedByPersonId,
            },
        ],
        today,
        root.version + 1,
        [],
    );
}
