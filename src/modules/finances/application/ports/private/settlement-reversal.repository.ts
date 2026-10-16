import type { SettlementReversal } from '../../../domain/settlement-reversal/settlement-reversal.js';
import type { InterMemberObligation } from '../../../domain/shared-expense/inter-member-obligation.js';
import type {
    SettlementResolutionKind,
    SettlementReversalState,
} from '../../models/settlement-reversal.js';
export const SETTLEMENT_REVERSAL_REPOSITORY = Symbol(
    'SETTLEMENT_REVERSAL_REPOSITORY',
);
export interface SettlementReversalRepository {
    state(
        spaceId: string,
        kind: SettlementResolutionKind,
        id: string,
    ): Promise<SettlementReversalState | null>;
    save(
        reversal: SettlementReversal,
        before: InterMemberObligation[],
        after: InterMemberObligation[],
        created: InterMemberObligation[],
        effectObligationIds: Map<string, string | null>,
    ): Promise<void>;
}
