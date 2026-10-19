import type { ObligationStatus } from '../../domain/shared-expense/inter-member-obligation.js';
export interface FulfillmentObligationView {
    id: string;
    originCommitmentId: string;
    originDisbursementId?: string;
    originExternalLiabilityId?: string;
    originClosureAgreementId?: string;
    originReceiptId?: string;
    debtorMemberId: string;
    creditorMemberId: string;
    originalAmountInCents: number;
    recognizedAmountInCents: number;
    remainingAmountInCents: number;
    transferredAmountInCents: number | string;
    compensatedAmountInCents?: number | string;
    waivedAmountInCents?: number;
    reversedTransferredAmountInCents?: string;
    effectiveTransferredAmountInCents?: string;
    reversedCompensatedAmountInCents?: string;
    effectiveCompensatedAmountInCents?: string;
    reversalIds?: string[];
    status: ObligationStatus;
    cycleId: string | null;
    history: {
        version: number;
        type:
            | 'CREATED'
            | 'SETTLEMENT_APPLIED'
            | 'RECONCILED'
            | 'ASSIGNMENT_CHANGED'
            | 'OFFSET_APPLIED'
            | 'WAIVED'
            | 'REVERSED';
        actorId: string;
        registeredAt: string;
        snapshot: Record<string, unknown>;
    }[];
}
