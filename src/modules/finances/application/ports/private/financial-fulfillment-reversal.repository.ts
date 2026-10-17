import type { FinancialCorrectionState } from '../../../domain/corrections/financial-correction.js';
import type {
    FinancialFulfillmentReversal,
    FinancialFulfillmentReversalState,
    ReversibleFinancialFactKind,
} from '../../../domain/reversals/financial-fulfillment-reversal.js';

export const FINANCIAL_FULFILLMENT_REVERSAL_REPOSITORY = Symbol(
    'FINANCIAL_FULFILLMENT_REVERSAL_REPOSITORY',
);
export interface FinancialReversalTarget {
    occurrenceId?: string;
    referenceDate?: string;
    installmentId?: string;
}
export interface FinancialReversalReadInput extends FinancialReversalTarget {
    originalKind: ReversibleFinancialFactKind;
    originalId: string;
}
export interface FinancialFulfillmentReversalRepository {
    snapshot<T>(work: () => Promise<T>): Promise<T>;
    read(
        spaceId: string,
        commitmentId: string,
        input: FinancialReversalReadInput,
        now: string,
        lock?: boolean,
    ): Promise<FinancialFulfillmentReversalState | null>;
    reverse(
        state: FinancialFulfillmentReversalState,
        reversal: FinancialFulfillmentReversal,
    ): Promise<void>;
    loadOrigin(
        spaceId: string,
        commitmentId: string,
        target: FinancialReversalTarget,
        now: string,
    ): Promise<FinancialCorrectionState>;
    list(
        spaceId: string,
        commitmentId: string,
        after: string | null,
    ): Promise<{ items: FinancialFulfillmentReversal[]; totalCount: number }>;
}
