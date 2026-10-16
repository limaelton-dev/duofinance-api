import type { RecurringCommitment } from '../../../domain/recurrence/recurring-commitment.js';
import type {
    FinancialOccurrence,
    OccurrenceFact,
} from '../../../domain/recurrence/financial-occurrence.js';

export const RECURRING_COMMITMENT_REPOSITORY = Symbol(
    'RECURRING_COMMITMENT_REPOSITORY',
);

export interface RecurringCommitmentRepository {
    save(commitment: RecurringCommitment): Promise<void>;
    find(
        spaceId: string,
        commitmentId: string,
        lock?: boolean,
    ): Promise<RecurringCommitment | null>;
    list(
        spaceId: string,
        month: string,
        after: string | null,
    ): Promise<{
        items: RecurringCommitment[];
        totalCount: number;
        totalAmountInCents: string;
    }>;
    occurrence(
        root: RecurringCommitment,
        referenceDate: string,
    ): Promise<FinancialOccurrence | null>;
    record(
        root: RecurringCommitment,
        occurrence: FinancialOccurrence,
        fact: OccurrenceFact,
        wasProjected: boolean,
    ): Promise<void>;
    settleExternal(
        root: RecurringCommitment,
        occurrence: FinancialOccurrence,
        liabilityId: string,
        amountInCents: number,
        factDate: string,
        actorId: string,
        key: string,
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
        occurrenceId: string | null,
        operation: string,
        key: string,
        hash: Buffer,
        result: unknown,
        now: string,
    ): Promise<void>;
}
