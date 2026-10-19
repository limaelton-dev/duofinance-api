import type { PersonId } from '../../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../../spaces/domain/space/space-id.js';
import type { FinanceTodaySettlementSummary } from './finance-today-query.port.js';
import type { IncomeTodayQueryPort } from './income-today-query.port.js';
import type { PlannedTodayQueryPort } from './planned-today-query.port.js';

export const FINANCE_TODAY_COMPOSITION_QUERY_PORT = Symbol(
    'FINANCE_TODAY_COMPOSITION_QUERY_PORT',
);

export interface FinanceTodayPreview<T> {
    items: T[];
    totalCount: number;
}

export type IncomeTodayItem = Awaited<
    ReturnType<IncomeTodayQueryPort['readUpcoming']>
>['items'][number];

export type PlannedTodayItem = Awaited<
    ReturnType<PlannedTodayQueryPort['readUpcoming']>
>['items'][number];

export interface FinancialTodayItem {
    commitmentId: string;
    occurrenceId: string | null;
    modality: 'ONE_TIME' | 'RECURRING' | 'INSTALLMENT';
    kind: 'EXPENSE' | 'INCOME';
    description: string;
    expectedDate: string;
    amountInCents: number | null;
    expectedAmountInCents: number | null;
    valuePending: boolean;
    fulfilledAmountInCents: number;
    remainingAmountInCents: number | null;
}

export interface FinanceTodayCompositionRead {
    spaceId: string;
    actorMemberId: string | null;
    referenceDate: string;
    legacy: {
        upcomingCommitments: FinanceTodayPreview<
            IncomeTodayItem | PlannedTodayItem
        >;
        settlements: FinanceTodaySettlementSummary | null;
    };
    overdue: FinanceTodayPreview<FinancialTodayItem>;
    today: FinanceTodayPreview<FinancialTodayItem>;
    upcoming: FinanceTodayPreview<FinancialTodayItem>;
    proposals: FinanceTodayPreview<{
        proposalId: string;
        commitmentId: string;
        registeredAt: string;
        effectiveFrom: string;
    }>;
}

export interface FinanceTodayCompositionQueryPort {
    read(
        actor: PersonId,
        space: SpaceId,
        referenceDate: string,
    ): Promise<FinanceTodayCompositionRead>;
}
