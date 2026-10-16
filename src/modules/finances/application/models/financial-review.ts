export type FinancialReviewView = 'CALENDAR' | 'HISTORY';
export type FinancialReviewItemType =
    | 'EXPENSE'
    | 'EXPENSE_DISCOUNT'
    | 'EXPENSE_SURCHARGE'
    | 'EXPECTED_INCOME'
    | 'EXPECTED_EXPENSE'
    | 'DISBURSEMENT'
    | 'RECEIPT'
    | 'EXTERNAL_LIABILITY'
    | 'EXTERNAL_SETTLEMENT'
    | 'INTERNAL_TRANSFER'
    | 'INTERNAL_OFFSET'
    | 'INTERNAL_WAIVER'
    | 'INTERNAL_REVERSAL';
export interface FinancialReviewItem {
    id: string;
    type: FinancialReviewItemType;
    commitmentId: string | null;
    externalLiabilityId: string | null;
    description: string;
    amountInCents: number | null;
    relevantDate: string;
    dateNature: 'EXPECTED' | 'ACTUAL';
    registeredAt: string;
    recordedByPersonId: string;
    participantMemberId: string | null;
    participantPersonId: string | null;
    recipientMemberId: string | null;
    memberIds: string[];
}
export interface FinancialForecastItem extends FinancialReviewItem {
    type: 'EXPECTED_INCOME' | 'EXPECTED_EXPENSE';
    expectedAmountInCents?: number | null;
    receivedAmountInCents: number;
    fulfilledAmountInCents?: number;
    remainingAmountInCents: number | null;
    overdue?: boolean;
}
export interface FinancialReviewMetrics {
    expenseAmountInCents: string;
    realizedIncomeAmountInCents: string;
    economicResultInCents: string;
    paidAmountInCents: string;
    receivedAmountInCents: string;
    assumedAmountInCents: string;
    externalSettledAmountInCents: string;
    disbursedAmountInCents: string;
    supportedAmountInCents: string;
    internalTransfersSentAmountInCents: string;
    internalTransfersReceivedAmountInCents: string;
    internalTransfersSentReversedAmountInCents?: string;
    internalTransfersReceivedReversedAmountInCents?: string;
    internalTransfersSentEffectiveAmountInCents?: string;
    internalTransfersReceivedEffectiveAmountInCents?: string;
}
export interface FinancialReviewContext {
    spaceId: string;
    spaceType: 'PERSONAL' | 'SHARED';
    month: string;
    referenceDate: string;
    memberId: string | null;
    members: { memberId: string; personId: string; displayName: string }[];
}
export interface FinancialTimeline extends FinancialReviewContext {
    view: FinancialReviewView;
    items: FinancialReviewItem[];
    nextCursor: string | null;
}
export interface FinancialForecast extends FinancialReviewContext {
    items: FinancialForecastItem[];
    totals: {
        expectedAmountInCents: string;
        receivedAmountInCents: string;
        remainingAmountInCents: string;
        unknownAmountCount?: number;
        expectedExpenseAmountInCents?: string;
        fulfilledExpenseAmountInCents?: string;
        remainingExpenseAmountInCents?: string;
    };
    nextCursor: string | null;
}
export interface FinancialOverview extends FinancialReviewContext {
    totals: FinancialReviewMetrics;
    byMember: ({ memberId: string } & FinancialReviewMetrics)[];
    currentExternalLiabilities: {
        referenceDate: string;
        outstandingAmountInCents: string;
        byMember: { memberId: string; outstandingAmountInCents: string }[];
    };
}
export interface FinancialReviewKey {
    relevantDate: string;
    registeredAt: string;
    type: FinancialReviewItemType;
    id: string;
}
export interface FinancialReviewScope {
    spaceId: string;
    month: string;
    start: string;
    end: string;
    referenceDate: string;
    memberId: string | null;
}
