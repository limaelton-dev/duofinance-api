import type {
    AdjustmentCommand,
    AssignmentCycle,
} from './settlement-adjustment.js';
import type { ObligationStatus } from '../../domain/shared-expense/inter-member-obligation.js';
export interface WaiveObligationCommand extends AdjustmentCommand {
    obligationId: string;
    expectedObligationVersion: number;
    amountInCents: number;
    factDate: string;
    reason?: string;
}
export interface ObligationWaiverResult {
    spaceId: string;
    waiver: {
        id: string;
        obligationId: string;
        creditorMemberId: string;
        amountInCents: number;
        factDate: string;
        registeredAt: string;
        createdByPersonId: string;
        reason: string | null;
    };
    obligation: {
        id: string;
        version: number;
        status: ObligationStatus;
        cycleId: string | null;
        remainingAmountInCents: number;
        closureAgreementId?: string;
    };
    affectedCycleIds: string[];
    replayed: boolean;
}
export interface ObligationWaiverOptions {
    obligation: ObligationWaiverResult['obligation'] & {
        debtorMemberId: string;
        creditorMemberId: string;
    };
    settlementCycle: AssignmentCycle | null;
}
