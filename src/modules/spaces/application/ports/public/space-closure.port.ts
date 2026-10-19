import type {
    ClosureConsent,
    ClosureDestinationIntent,
    ClosureFutureDestination,
    ClosureParticipant,
    ClosureRecurringImpact,
} from '../../../domain/space/closure-plan.js';

export type {
    ClosureConsent,
    ClosureParticipant,
    ClosureDestinationIntent,
    ClosureFutureDestination,
    ClosureRecurringImpact,
};

export type SpaceClosureView = {
    spaceId: string;
    spaceStatus: 'ACTIVE' | 'CLOSING' | 'CLOSED';
    spaceVersion: number;
    processId: string;
    processStatus: 'OPEN' | 'COMPLETED' | 'CANCELLED';
    planRevision: number;
    planStatus: 'DRAFT' | 'PROPOSED' | 'APPROVED' | 'REJECTED';
    cutoffDate: string;
    proposedCutoffDate: string | null;
    requestedByMemberId: string;
    requiredMemberIds: string[];
    participants: ClosureParticipant[];
    approvals: ClosureConsent[];
    confirmations: ClosureConsent[];
    futureDestinations: ClosureFutureDestination[];
    startedAt: string;
    completedAt: string | null;
    cancelledAt: string | null;
    invitationStatus: string | null;
};

export type SpaceClosureCommandBase = {
    actorId: string;
    spaceId: string;
    idempotencyKey: string;
    expectedSpaceVersion: number;
    now: Date;
};

export type ProposeClosureCutoffInput = SpaceClosureCommandBase & {
    expectedPlanRevision: number;
    cutoffDate: string;
};

export type ClosureDestinationReplayInput = SpaceClosureCommandBase & {
    expectedPlanRevision: number;
    intent: ClosureDestinationIntent;
};

export type UpsertClosureDestinationInput = ClosureDestinationReplayInput & {
    destination: ClosureFutureDestination;
};

export type SpaceClosureCommandResult = {
    view: SpaceClosureView;
    replayed: boolean;
    httpStatus: 200 | 201;
};

export type SpaceClosureHistoryEntry = {
    id: string;
    processId: string;
    action: string;
    actorMemberId: string;
    planRevision: number;
    recordedAt: string;
    snapshot: SpaceClosureView;
};

export const SPACE_CLOSURE_PORT = Symbol('SPACE_CLOSURE_PORT');

export interface SpaceClosurePort {
    start(input: SpaceClosureCommandBase): Promise<SpaceClosureCommandResult>;
    proposeCutoff(
        input: ProposeClosureCutoffInput,
    ): Promise<SpaceClosureCommandResult>;
    replayDestination(
        input: ClosureDestinationReplayInput,
    ): Promise<SpaceClosureCommandResult | null>;
    upsertDestination(
        input: UpsertClosureDestinationInput,
    ): Promise<SpaceClosureCommandResult>;
    read(actorId: string, spaceId: string): Promise<SpaceClosureView | null>;
    lockForProcess(
        actorId: string,
        spaceId: string,
    ): Promise<SpaceClosureView | null>;
    history(
        actorId: string,
        spaceId: string,
        input: { limit: number; cursor?: string },
    ): Promise<{
        items: SpaceClosureHistoryEntry[];
        nextCursor: string | null;
    }>;
}
