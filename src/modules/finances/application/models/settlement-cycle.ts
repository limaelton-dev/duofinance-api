import type { SpaceFinancialContext } from '../../../spaces/application/ports/public/space-financial-context.port.js';
import type {
    OpenObligationView,
    PositionDirection,
    PositionSummary,
} from './inter-member-position.js';
export type SettlementCycleView = 'OPEN' | 'UPCOMING' | 'OVERDUE' | 'FINALIZED';
export interface SettlementCycleKey {
    targetDate: string;
    id: string;
}
export interface SettlementCycleTotals {
    originalAmountInCents: string;
    recognizedAmountInCents: string;
    resolvedAmountInCents: string;
    remainingAmountInCents: string;
    transferredAmountInCents: string;
    compensatedAmountInCents?: string;
    waivedAmountInCents?: string;
}
export interface SettlementCycleSummary extends SettlementCycleKey {
    version: number;
    status: 'OPEN' | 'FINALIZED';
    isOverdue: boolean;
    obligationCount: number;
    openObligationCount: number;
    totals: SettlementCycleTotals;
    position: PositionSummary;
}
export interface SettlementCycleDetail extends SettlementCycleSummary {
    finalizedAt: string | null;
    canFinalize?: boolean;
    finalizationBlockReason?:
        | 'SPACE_CLOSED'
        | 'SETTLEMENT_CYCLE_FINALIZED'
        | 'OPEN_OBLIGATIONS'
        | null;
}
export interface SettlementObligationView extends Omit<
    OpenObligationView,
    'settlementCycle' | 'status'
> {
    status: 'OPEN' | 'PARTIALLY_SETTLED' | 'SETTLED' | 'RECONCILED' | 'WAIVED';
    resolvedAmountInCents: number;
    compensatedAmountInCents?: number;
    waivedAmountInCents?: number;
}
interface SettlementContext {
    spaceId: string;
    spaceStatus: SpaceFinancialContext['status'];
    actorMemberId: string;
    members: SpaceFinancialContext['members'];
    referenceDate: string;
}
export interface SettlementCyclesResponse extends SettlementContext {
    items: SettlementCycleSummary[];
    page: {
        view: SettlementCycleView;
        pageSize: 20;
        nextCursor: string | null;
    };
}
export interface SettlementCycleResponse extends SettlementContext {
    cycle: SettlementCycleDetail;
    items: SettlementObligationView[];
    page: {
        direction: PositionDirection;
        pageSize: 20;
        nextCursor: string | null;
    };
}
export interface SelectedSettlementObligation extends SettlementObligationView {
    cycleId: string;
    origin: SettlementObligationView['origin'] & {
        kind: 'EXPENSE' | 'INCOME';
        amountInCents: number;
        distribution: {
            kind: 'RESPONSIBILITY' | 'PARTICIPATION';
            shares: { memberId: string; amountInCents: number }[];
            actorAmountInCents: number;
        };
    };
}
export interface SelectedSettlementTotals extends SettlementCycleTotals {
    transferTotalAmountInCents: string;
    transferCount: number;
    grossPayableAmountInCents: string;
    grossReceivableAmountInCents: string;
}
export interface SelectedSettlementCyclesResponse extends SettlementContext {
    selectedCycles: (SettlementCycleDetail & { readOnly: boolean })[];
    totals: SelectedSettlementTotals;
    position: PositionSummary;
    items: SelectedSettlementObligation[];
    page: {
        direction: PositionDirection;
        pageSize: 20;
        nextCursor: string | null;
    };
}
