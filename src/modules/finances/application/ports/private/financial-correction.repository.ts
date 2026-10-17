import type {
    FinancialAdjustment,
    FinancialCancellation,
    FinancialCorrectionState,
} from '../../../domain/corrections/financial-correction.js';
export const FINANCIAL_CORRECTION_REPOSITORY = Symbol(
    'FINANCIAL_CORRECTION_REPOSITORY',
);
export interface FinancialCorrectionTarget {
    occurrenceId?: string;
    referenceDate?: string;
    installmentId?: string;
}
export interface FinancialCorrectionRepository {
    snapshot<T>(work: () => Promise<T>): Promise<T>;
    read(
        spaceId: string,
        commitmentId: string,
        target: FinancialCorrectionTarget,
        now: string,
        lock?: boolean,
    ): Promise<FinancialCorrectionState | null>;
    adjust(
        state: FinancialCorrectionState,
        adjustment: FinancialAdjustment,
    ): Promise<void>;
    cancel(
        state: FinancialCorrectionState,
        cancellation: FinancialCancellation,
    ): Promise<void>;
}
