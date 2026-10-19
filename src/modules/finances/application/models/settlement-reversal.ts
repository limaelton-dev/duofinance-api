import type {
    AdjustmentCommand,
    AssignmentCycle,
} from './settlement-adjustment.js';
import type { ObligationStatus } from '../../domain/shared-expense/inter-member-obligation.js';
import type { SettlementReversalSource } from '../../domain/settlement-reversal/settlement-reversal.js';
export type SettlementResolutionKind = 'TRANSFER' | 'OFFSET';
export interface SettlementResolutionOriginal {
    kind: SettlementResolutionKind;
    id: string;
    amountInCents: number;
    factDate: string;
    registeredAt: string;
    createdByPersonId: string;
}
export interface SettlementResolutionAllocation {
    id: string;
    obligationId: string;
    originCommitmentId: string;
    debtorMemberId: string;
    creditorMemberId: string;
    amountInCents: number;
    cycleId: string | null;
}
export interface ReversalObligationState extends SettlementReversalSource {
    id: string;
    version: number;
    cycleId: string | null;
    debtorMemberId: string;
    creditorMemberId: string;
    remainingAmountInCents: number;
    status: ObligationStatus;
}
export interface SettlementReversalState {
    original: SettlementResolutionOriginal;
    allocations: SettlementResolutionAllocation[];
    previousReversals: {
        id: string;
        amountInCents: number;
        factDate: string;
        registeredAt: string;
        createdByPersonId: string;
        applications: SettlementReversalResult['applications'];
    }[];
    obligations: ReversalObligationState[];
    cycles: AssignmentCycle[];
}
export interface ReverseSettlementCommand extends AdjustmentCommand {
    originalKind: SettlementResolutionKind;
    originalId: string;
    factDate: string;
    expectedObligationVersions: { obligationId: string; version: number }[];
    expectedCycleVersions: { cycleId: string; version: number }[];
    applications: { allocationId: string; amountInCents: number }[];
    correctionCycleId?: string;
}
export interface SettlementReversalResult {
    spaceId: string;
    reversal: {
        id: string;
        originalKind: SettlementResolutionKind;
        originalId: string;
        amountInCents: number;
        factDate: string;
        registeredAt: string;
        createdByPersonId: string;
    };
    original: SettlementResolutionOriginal;
    applications: {
        id: string;
        originalAllocationId: string;
        obligationId: string;
        originalCycleId: string | null;
        correctionCycleId: string | null;
        effectObligationId: string | null;
        amountInCents: number;
        debtorMemberId: string;
        creditorMemberId: string;
    }[];
    effects: {
        obligationId: string;
        originCommitmentId: string;
        remainingAmountInCents: number;
        cycleId: string | null;
        version: number;
        status: ObligationStatus;
    }[];
    affectedCycleIds: string[];
    replayed: boolean;
}
