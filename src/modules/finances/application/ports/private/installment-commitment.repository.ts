import type { InstallmentCommitment } from '../../../domain/installment/installment-commitment.js';
import type { InstallmentAnticipation } from '../../../domain/installment/installment-plan.js';
import type {
    FinancialOccurrence,
    OccurrenceFact,
} from '../../../domain/recurrence/financial-occurrence.js';

export const INSTALLMENT_COMMITMENT_REPOSITORY = Symbol(
    'INSTALLMENT_COMMITMENT_REPOSITORY',
);

export interface InstallmentCommitmentRepository {
    save(commitment: InstallmentCommitment): Promise<void>;
    find(
        spaceId: string,
        commitmentId: string,
        lock?: boolean,
    ): Promise<InstallmentCommitment | null>;
    list(
        spaceId: string,
        after: string | null,
    ): Promise<{
        items: InstallmentCommitment[];
        totalCount: number;
        totalAmountInCents: string;
    }>;
    occurrence(
        commitment: InstallmentCommitment,
        installmentId: string,
    ): Promise<FinancialOccurrence | null>;
    record(
        commitment: InstallmentCommitment,
        occurrence: FinancialOccurrence,
        fact: OccurrenceFact,
        anticipation?: InstallmentAnticipation,
    ): Promise<void>;
    settleExternal(
        commitment: InstallmentCommitment,
        occurrence: FinancialOccurrence,
        liabilityId: string,
        amountInCents: number,
        factDate: string,
        actorId: string,
        now: string,
    ): Promise<{ id: string; remainingAmountInCents: number }>;
    findReceipt(
        actorId: string,
        operation: string,
        key: string,
        hash: Buffer,
    ): Promise<unknown | null>;
    saveReceipt(
        actorId: string,
        spaceId: string,
        commitmentId: string,
        installmentId: string | null,
        operation: string,
        key: string,
        hash: Buffer,
        result: unknown,
        now: string,
    ): Promise<void>;
}
