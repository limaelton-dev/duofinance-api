import type { SpaceFinancialContext } from '../../../spaces/application/ports/public/space-financial-context.port.js';
import type {
    OpenObligationView,
    PositionDirection,
    PositionSummary,
} from './inter-member-position.js';
export type SettlementCycleView = 'OPEN' | 'UPCOMING';
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
}
export interface SettlementObligationView extends Omit<
    OpenObligationView,
    'settlementCycle' | 'status'
> {
    status: 'OPEN' | 'PARTIALLY_SETTLED' | 'SETTLED' | 'RECONCILED';
    resolvedAmountInCents: number;
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
