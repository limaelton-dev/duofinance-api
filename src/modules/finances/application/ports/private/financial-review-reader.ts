import type {
    FinancialReviewScope,
    FinancialReviewKey,
    FinancialReviewItem,
    FinancialForecastItem,
    FinancialForecast,
    FinancialOverview,
} from '../../models/financial-review.js';
export const FINANCIAL_REVIEW_READER = Symbol('FINANCIAL_REVIEW_READER');
export interface FinancialReviewReader {
    timeline(
        scope: FinancialReviewScope,
        after: FinancialReviewKey | null,
    ): Promise<FinancialReviewItem[]>;
    forecast(
        scope: FinancialReviewScope,
        after: FinancialReviewKey | null,
    ): Promise<{
        items: FinancialForecastItem[];
        totals: FinancialForecast['totals'];
        globalCorrections?: FinancialForecast['globalCorrections'];
    }>;
    overview(
        scope: FinancialReviewScope,
    ): Promise<
        Pick<
            FinancialOverview,
            'totals' | 'byMember' | 'currentExternalLiabilities'
        >
    >;
}
