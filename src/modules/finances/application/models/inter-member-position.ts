import type { SpaceFinancialContext } from '../../../spaces/application/ports/public/space-financial-context.port.js';
export type PositionDirection = 'ALL' | 'PAYABLE' | 'RECEIVABLE';
export interface PositionKey {
    registeredAt: string;
    id: string;
}
export interface OpenObligationView extends PositionKey {
    version: number;
    status: 'OPEN';
    debtorMemberId: string;
    creditorMemberId: string;
    originalAmountInCents: number;
    remainingAmountInCents: number;
    factDate: string;
    origin: {
        commitmentId: string;
        disbursementId: string;
        description: string;
    };
    settlementCycle: null | {
        id: string;
        targetDate: string;
        status: 'OPEN' | 'FINALIZED';
    };
}
export interface PositionSummary {
    payableAmountInCents: string;
    receivableAmountInCents: string;
    net: {
        direction: 'PAYABLE' | 'RECEIVABLE' | 'BALANCED';
        amountInCents: string;
    };
}
export interface InterMemberPositionView {
    spaceId: string;
    spaceStatus: SpaceFinancialContext['status'];
    actorMemberId: string;
    members: SpaceFinancialContext['members'];
    scope: 'OPEN_OBLIGATIONS';
    summary: PositionSummary;
    items: OpenObligationView[];
    page: {
        direction: PositionDirection;
        pageSize: 20;
        nextCursor: string | null;
    };
}
