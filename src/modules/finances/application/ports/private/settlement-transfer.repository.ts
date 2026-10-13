import type { InterMemberObligation } from '../../../domain/shared-expense/inter-member-obligation.js';
import type { SettlementTransfer } from '../../../domain/settlement-transfer/settlement-transfer.js';
import type {
    RecordSettlementTransferCommand,
    SettlementTransferResult,
} from '../../models/settlement-transfer.js';
import type {
    OpenObligationView,
    PositionKey,
} from '../../models/inter-member-position.js';

export const SETTLEMENT_TRANSFER_REPOSITORY = Symbol(
    'SETTLEMENT_TRANSFER_REPOSITORY',
);
export const SETTLEMENT_TRANSFER_RECEIPTS = Symbol(
    'SETTLEMENT_TRANSFER_RECEIPTS',
);
export class SettlementTransferReceiptRaceError extends Error {}
export interface SettlementTransferRepository {
    discover(
        spaceId: string,
        ids: string[],
    ): Promise<{ id: string; cycleId: string | null }[]>;
    lockCycles(spaceId: string, ids: string[]): Promise<void>;
    lockObligations(
        spaceId: string,
        ids: string[],
    ): Promise<InterMemberObligation[]>;
    save(
        transfer: SettlementTransfer,
        before: InterMemberObligation[],
        after: InterMemberObligation[],
    ): Promise<void>;
    options(
        spaceId: string,
        actorMemberId: string,
        direction: 'PAYABLE' | 'RECEIVABLE',
        cycleId: string | null,
        after: PositionKey | null,
    ): Promise<{
        payable: string;
        receivable: string;
        items: OpenObligationView[];
    }>;
    detail(
        spaceId: string,
        id: string,
    ): Promise<Omit<SettlementTransferResult, 'replayed'> | null>;
    history(
        spaceId: string,
        cycleId: string | null,
        obligationId: string | null,
        after: PositionKey | null,
    ): Promise<{
        items: (Omit<SettlementTransferResult, 'replayed'> & {
            appliedAmountInCentsInFilter: number;
        })[];
    }>;
    hasCycle(spaceId: string, id: string): Promise<boolean>;
    hasObligation(spaceId: string, id: string): Promise<boolean>;
}
export interface SettlementTransferReceipts {
    find(
        command: RecordSettlementTransferCommand,
    ): Promise<SettlementTransferResult | null>;
    save(
        command: RecordSettlementTransferCommand,
        result: SettlementTransferResult,
    ): Promise<void>;
}
