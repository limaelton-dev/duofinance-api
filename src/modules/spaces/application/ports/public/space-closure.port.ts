import type {
    ClosureConsent,
    ClosureDestinationIntent,
    ClosureFutureDestination,
    ClosureParticipant,
    ClosureRecurringImpact,
    ClosureProposalSnapshot,
    ClosurePlanAction,
    ClosureCancellationConsent,
} from '../../../domain/space/closure-plan.js';

export type {
    ClosureConsent,
    ClosureParticipant,
    ClosureDestinationIntent,
    ClosureFutureDestination,
    ClosureRecurringImpact,
    ClosureProposalSnapshot,
    ClosurePlanAction,
    ClosureCancellationConsent,
};

export type SpaceClosureNextAction =
    | 'PROPOSE_PLAN'
    | 'REVIEW_PLAN'
    | 'WAIT_APPROVAL'
    | 'RESOLVE_FINANCES'
    | 'REVIEW_CLOSURE'
    | 'WAIT_CANCELLATION'
    | 'APPROVE_CANCELLATION'
    | 'READ_ONLY';

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
    proposalSnapshot?: ClosureProposalSnapshot | null;
    hasBilateralApproval?: boolean;
    cancellationConsents?: ClosureCancellationConsent[];
    actorNextAction?: SpaceClosureNextAction;
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

export type ClosurePlanDecisionInput = SpaceClosureCommandBase & {
    expectedPlanRevision: number;
    action: ClosurePlanAction;
    expectedFinancialFingerprint?: string;
    proposalSnapshot?: ClosureProposalSnapshot;
};

export type ConfirmClosureInput = SpaceClosureCommandBase & {
    action: 'CONFIRM';
    expectedPlanRevision: number;
    expectedFinancialFingerprint: string;
    financialFingerprint: string;
    financiallyReady: boolean;
    completionPrepared: boolean;
};

export type CancelClosureInput = SpaceClosureCommandBase & {
    action: 'CANCEL';
    expectedPlanRevision: number;
};

export type ClosureConclusionInput = ConfirmClosureInput | CancelClosureInput;

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
    replayPlanDecision(
        input: ClosurePlanDecisionInput,
    ): Promise<SpaceClosureCommandResult | null>;
    decidePlan(
        input: ClosurePlanDecisionInput,
    ): Promise<SpaceClosureCommandResult>;
    replayConclusion(
        input: ClosureConclusionInput,
    ): Promise<SpaceClosureCommandResult | null>;
    confirm(input: ConfirmClosureInput): Promise<SpaceClosureCommandResult>;
    cancel(input: CancelClosureInput): Promise<SpaceClosureCommandResult>;
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
