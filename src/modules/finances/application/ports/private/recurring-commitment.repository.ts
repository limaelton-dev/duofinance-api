import type { RecurringCommitment } from '../../../domain/recurrence/recurring-commitment.js';
import type { EconomicShare } from '../../../domain/shared-expense/responsibility-split.js';
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
        closureCutoffDate?: string | null,
    ): Promise<{
        items: { commitment: RecurringCommitment; referenceDate: string }[];
        totalCount: number;
        totalAmountInCents: string;
        unknownAmountCount: number;
    }>;
    occurrence(
        root: RecurringCommitment,
        referenceDate: string,
    ): Promise<FinancialOccurrence | null>;
    occurrencesInMonth(
        root: RecurringCommitment,
        month: string,
    ): Promise<FinancialOccurrence[]>;
    materializedAfter(
        root: RecurringCommitment,
        date: string,
    ): Promise<
        { referenceDate: string; status: string; economicVersion: number }[]
    >;
    saveVersion(
        root: RecurringCommitment,
        next: RecurringCommitment,
        effectiveFrom: string,
    ): Promise<void>;
    terminate(
        root: RecurringCommitment,
        endsOn: string,
        actorId: string,
        now: string,
    ): Promise<void>;
    cancel(
        root: RecurringCommitment,
        occurrence: FinancialOccurrence,
        wasProjected: boolean,
    ): Promise<void>;
    defineValue(
        root: RecurringCommitment,
        occurrence: FinancialOccurrence,
        shares: readonly EconomicShare[] | null,
        wasProjected: boolean,
    ): Promise<void>;
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
