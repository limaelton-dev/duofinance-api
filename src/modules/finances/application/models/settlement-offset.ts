import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type {
    OpenObligationView,
    PositionKey,
} from './inter-member-position.js';
import type { SettlementOffsetAllocation } from '../../domain/settlement-offset/settlement-offset.js';
import type { AssignmentCycle } from './settlement-adjustment.js';
export interface SettlementOffsetScope {
    cycleIds: string[];
    obligationIds: string[];
}
export interface RecordSettlementOffsetCommand {
    actorId: PersonId;
    spaceId: SpaceId;
    idempotencyKey: string;
    scope: SettlementOffsetScope;
    expectedSpaceVersion: number;
    factDate: string;
    expectedCycleVersions: { cycleId: string; version: number }[];
    allocations: {
        obligationId: string;
        expectedObligationVersion: number;
        amountInCents: number;
    }[];
}
export interface SettlementOffsetResult {
    spaceId: string;
    offset: PositionKey & {
        amountInCents: number;
        factDate: string;
        createdByPersonId: string;
    };
    allocations: (SettlementOffsetAllocation & {
        origin: OpenObligationView['origin'];
    })[];
    affectedCycleIds: string[];
    replayed: boolean;
}
export interface SettlementOffsetOptionsRead {
    cycles: AssignmentCycle[];
    payable: string;
    receivable: string;
    items: OpenObligationView[];
    previewCandidates: OpenObligationView[];
}
