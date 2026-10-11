import type { PersonId } from '../../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../../spaces/domain/space/space-id.js';
import type { SettlementCyclesResponse } from '../../models/settlement-cycle.js';
export const SETTLEMENT_CYCLE_QUERY_PORT = Symbol(
    'SETTLEMENT_CYCLE_QUERY_PORT',
);
export interface SettlementCycleQueryPort {
    upcoming(
        actor: PersonId,
        space: SpaceId,
        cursor?: string,
    ): Promise<SettlementCyclesResponse>;
}
