import type { SettlementCycle } from '../../../domain/shared-expense/settlement-cycle.js';
export const SETTLEMENT_CYCLE_FINALIZATION_REPOSITORY = Symbol(
    'SETTLEMENT_CYCLE_FINALIZATION_REPOSITORY',
);
export interface SettlementCycleFinalizationRepository {
    lockCycle(spaceId: string, id: string): Promise<SettlementCycle | null>;
    hasOpenObligations(spaceId: string, cycleId: string): Promise<boolean>;
    saveFinalization(
        before: SettlementCycle,
        after: SettlementCycle,
        actorId: string,
        now: string,
    ): Promise<void>;
}
