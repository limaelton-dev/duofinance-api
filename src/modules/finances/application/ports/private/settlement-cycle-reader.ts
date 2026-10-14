import type {
    PositionDirection,
    PositionKey,
} from '../../models/inter-member-position.js';
import type {
    SettlementCycleDetail,
    SettlementCycleKey,
    SettlementCycleView,
    SettlementObligationView,
} from '../../models/settlement-cycle.js';
export const SETTLEMENT_CYCLE_READER = Symbol('SETTLEMENT_CYCLE_READER');
export type SettlementCycleRead = Omit<
    SettlementCycleDetail,
    'position' | 'isOverdue'
> & { payableAmountInCents: string; receivableAmountInCents: string };
export interface SettlementCycleReader {
    today(
        spaceId: string,
        actorMemberId: string,
        referenceDate: string,
    ): Promise<{
        nextCycle: SettlementCycleRead | null;
        overdueCycles: { items: SettlementCycleRead[]; totalCount: number };
    }>;
    list(
        spaceId: string,
        actorMemberId: string,
        view: SettlementCycleView,
        referenceDate: string,
        after: SettlementCycleKey | null,
    ): Promise<SettlementCycleRead[]>;
    detail(
        spaceId: string,
        actorMemberId: string,
        cycleId: string,
        direction: PositionDirection,
        after: PositionKey | null,
    ): Promise<{
        cycle: SettlementCycleRead;
        items: SettlementObligationView[];
    } | null>;
}
