import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type {
    FinancialCommitment,
    PersonalCommitmentVersion,
    PersonalDisbursement,
} from '../../domain/shared-expense/financial-commitment.js';
export interface RecordPersonalExpenseInput {
    description: string;
    amountInCents: number;
    factDate: string;
    disbursement: { method: 'PIX' | 'DEBIT' | 'CASH'; amountInCents?: number };
}
export interface RecordPersonalExpenseCommand extends RecordPersonalExpenseInput {
    actorId: PersonId;
    spaceId: SpaceId;
    idempotencyKey: string;
}
export interface PersonalExpenseView {
    spaceId: string;
    spaceType: 'PERSONAL';
    commitment: {
        id: string;
        version: number;
        kind: 'EXPENSE';
        modality: 'ONE_TIME';
        description: string;
        amountInCents: number;
        factDate: string | null;
        expectedPaymentDate?: string | null;
        registeredAt: string;
        createdByPersonId: string;
        ownerPersonId: string;
    };
    disbursement: PersonalDisbursement | null;
    disbursements: readonly PersonalDisbursement[];
    reversals?: FinancialCommitment<PersonalCommitmentVersion>['reversals'];
    validDisbursements?: FinancialCommitment<PersonalCommitmentVersion>['validDisbursements'];
    validExternalLiabilities?: FinancialCommitment<PersonalCommitmentVersion>['validExternalLiabilities'];
    externalLiabilities?: FinancialCommitment<PersonalCommitmentVersion>['externalLiabilities'];
    assumedAmountInCents?: number;
    externalOutstandingAmountInCents?: number;
    externalSettledAmountInCents?: number;
    supportedAmountInCents?: number;
    fulfillmentStatus?: 'PENDING' | 'PARTIALLY_FULFILLED' | 'FULFILLED';
    paidAmountInCents: number;
    remainingAmountInCents: number;
    status: FinancialCommitment['status'];
    overdue?: boolean;
}
export interface PersonalExpenseResult extends PersonalExpenseView {
    replayed: boolean;
}
export interface PersonalExpenseSummary {
    id: string;
    description: string;
    amountInCents: number;
    factDate: string | null;
    expectedPaymentDate?: string | null;
    relevantDate?: string;
    overdue?: boolean;
    disbursement: {
        amountInCents: number;
        method: 'PIX' | 'DEBIT' | 'CASH';
    } | null;
    externalLiabilities?: FinancialCommitment<PersonalCommitmentVersion>['externalLiabilities'];
    assumedAmountInCents?: number;
    externalOutstandingAmountInCents?: number;
    externalSettledAmountInCents?: number;
    supportedAmountInCents?: number;
    fulfillmentStatus?: 'PENDING' | 'PARTIALLY_FULFILLED' | 'FULFILLED';
    paidAmountInCents: number;
    remainingAmountInCents: number;
    status: FinancialCommitment['status'];
}
export function personalExpenseView(
    c: FinancialCommitment<PersonalCommitmentVersion>,
): PersonalExpenseView {
    return {
        spaceId: c.spaceId,
        ...(c.reversals.length
            ? {
                  reversals: c.reversals,
                  validDisbursements: c.validDisbursements,
                  validExternalLiabilities: c.validExternalLiabilities,
              }
            : {}),
        ...(c.adjustments.length || c.cancellation
            ? {
                  adjustments: c.adjustments,
                  cancellation: c.cancellation,
                  originalAmountInCents:
                      c.adjustments[0]?.previousAmountInCents ??
                      c.initialVersion.amount.amountInCents,
              }
            : {}),
        spaceType: 'PERSONAL',
        commitment: {
            id: c.id,
            version: c.version,
            kind: 'EXPENSE',
            modality: 'ONE_TIME',
            description: c.description,
            amountInCents: c.initialVersion.amount.amountInCents,
            factDate: c.initialVersion.factDate,
            ...(c.initialVersion.expectedPaymentDate
                ? { expectedPaymentDate: c.initialVersion.expectedPaymentDate }
                : {}),
            registeredAt: c.registeredAt,
            createdByPersonId: c.createdByPersonId,
            ownerPersonId: c.initialVersion.ownerPersonId,
        },
        disbursement: c.disbursement ? { ...c.disbursement } : null,
        externalLiabilities: c.externalLiabilities,
        externalSettledAmountInCents: c.externalSettledAmountInCents,
        assumedAmountInCents: c.assumedAmountInCents,
        externalOutstandingAmountInCents: c.externalOutstandingAmountInCents,
        supportedAmountInCents: c.supportedAmountInCents,
        fulfillmentStatus: c.fulfillmentStatus,
        disbursements: c.disbursements,
        paidAmountInCents: c.paidAmountInCents,
        remainingAmountInCents: c.remainingAmountInCents,
        status: c.status,
        ...(c.initialVersion.expectedPaymentDate ? { overdue: c.overdue } : {}),
    };
}
