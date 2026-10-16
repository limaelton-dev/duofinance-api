import type { SettlementOffset } from '../../../domain/settlement-offset/settlement-offset.js';
import type { InterMemberObligation } from '../../../domain/shared-expense/inter-member-obligation.js';
import type {
    PositionDirection,
    PositionKey,
} from '../../models/inter-member-position.js';
import type { AssignmentCycle } from '../../models/settlement-adjustment.js';
import type {
    RecordSettlementOffsetCommand,
    SettlementOffsetOptionsRead,
    SettlementOffsetResult,
    SettlementOffsetScope,
} from '../../models/settlement-offset.js';
export const SETTLEMENT_OFFSET_REPOSITORY = Symbol(
    'SETTLEMENT_OFFSET_REPOSITORY',
);
export class SettlementOffsetReceiptRaceError extends Error {}
export interface SettlementOffsetRepository {
    validateScope(
        spaceId: string,
        scope: SettlementOffsetScope,
    ): Promise<AssignmentCycle[]>;
    options(
        spaceId: string,
        actorMemberId: string,
        scope: SettlementOffsetScope,
        direction: PositionDirection,
        after: PositionKey | null,
    ): Promise<SettlementOffsetOptionsRead>;
    findReceipt(
        c: RecordSettlementOffsetCommand,
    ): Promise<SettlementOffsetResult | null>;
    saveReceipt(
        c: RecordSettlementOffsetCommand,
        result: SettlementOffsetResult,
    ): Promise<void>;
    save(
        offset: SettlementOffset,
        before: InterMemberObligation[],
        after: InterMemberObligation[],
    ): Promise<void>;
    detail(spaceId: string, id: string): Promise<SettlementOffsetResult | null>;
    history(
        spaceId: string,
        cycleId: string | null,
        obligationId: string | null,
        after: PositionKey | null,
    ): Promise<
        (SettlementOffsetResult & { appliedAmountInCentsInFilter: string })[]
    >;
}
