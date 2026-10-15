import type { ObligationStatus } from '../../domain/shared-expense/inter-member-obligation.js';
export interface FulfillmentObligationView {
    id: string;
    originCommitmentId: string;
    originDisbursementId?: string;
    originExternalLiabilityId?: string;
    originReceiptId?: string;
    debtorMemberId: string;
    creditorMemberId: string;
    originalAmountInCents: number;
    recognizedAmountInCents: number;
    remainingAmountInCents: number;
    transferredAmountInCents: number;
    status: ObligationStatus;
    cycleId: string | null;
    history: {
        version: number;
        type: 'CREATED' | 'SETTLEMENT_APPLIED' | 'RECONCILED';
        actorId: string;
        registeredAt: string;
        snapshot: Record<string, unknown>;
    }[];
}
