import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type {
    OpenObligationView,
    PositionSummary,
} from './inter-member-position.js';
import type { SpaceFinancialContext } from '../../../spaces/application/ports/public/space-financial-context.port.js';

export interface RecordSettlementTransferInput {
    expectedSpaceVersion: number;
    payerMemberId: string;
    recipientMemberId: string;
    amountInCents: number;
    factDate: string;
    allocations: {
        obligationId: string;
        expectedObligationVersion: number;
        amountInCents: number;
    }[];
}
export interface RecordSettlementTransferCommand extends RecordSettlementTransferInput {
    actorId: PersonId;
    spaceId: SpaceId;
    idempotencyKey: string;
}
export interface SettlementTransferView {
    id: string;
    payerMemberId: string;
    recipientMemberId: string;
    amountInCents: number;
    reversedAmountInCents?: number;
    effectiveAmountInCents?: number;
    reversalId?: string | null;
    factDate: string;
    registeredAt: string;
    createdByPersonId: string;
    mode: 'MANUAL';
}
export interface SettlementTransferResult {
    replayed: boolean;
    spaceId: string;
    transfer: SettlementTransferView;
    allocations: {
        id: string;
        obligationId: string;
        cycleId: string | null;
        amountInCents: number;
        reversedAmountInCents?: number;
        effectiveAmountInCents?: number;
        origin: OpenObligationView['origin'];
    }[];
    affectedCycleIds: string[];
}
export interface SettlementTransferOptions extends Omit<
    SpaceFinancialContext,
    'version'
> {
    spaceVersion: number;
    referenceDate: string;
    canRecord: boolean;
    summary: PositionSummary;
    items: OpenObligationView[];
    page: {
        direction: 'PAYABLE' | 'RECEIVABLE';
        cycleId: string | null;
        pageSize: 20;
        nextCursor: string | null;
    };
}
