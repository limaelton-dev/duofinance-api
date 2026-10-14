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
    disbursement: { method: 'PIX' | 'DEBIT' | 'CASH' };
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
        factDate: string;
        registeredAt: string;
        createdByPersonId: string;
        ownerPersonId: string;
    };
    disbursement: PersonalDisbursement;
}
export interface PersonalExpenseResult extends PersonalExpenseView {
    replayed: boolean;
}
export interface PersonalExpenseSummary {
    id: string;
    description: string;
    amountInCents: number;
    factDate: string;
    disbursement: { amountInCents: number; method: 'PIX' | 'DEBIT' | 'CASH' };
}
export function personalExpenseView(
    c: FinancialCommitment<PersonalCommitmentVersion>,
): PersonalExpenseView {
    return {
        spaceId: c.spaceId,
        spaceType: 'PERSONAL',
        commitment: {
            id: c.id,
            version: 1,
            kind: 'EXPENSE',
            modality: 'ONE_TIME',
            description: c.description,
            amountInCents: c.initialVersion.amount.amountInCents,
            factDate: c.initialVersion.factDate,
            registeredAt: c.registeredAt,
            createdByPersonId: c.createdByPersonId,
            ownerPersonId: c.initialVersion.ownerPersonId,
        },
        disbursement: { ...c.disbursement },
    };
}
