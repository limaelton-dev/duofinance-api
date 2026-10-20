import type { ObligationWaiver } from '../../../domain/shared-expense/obligation-waiver.js';
import type { InterMemberObligation } from '../../../domain/shared-expense/inter-member-obligation.js';
import type {
    ObligationWaiverResult,
    ObligationWaiverOptions,
} from '../../models/obligation-waiver.js';
import type { PositionKey } from '../../models/inter-member-position.js';
export const OBLIGATION_WAIVER_REPOSITORY = Symbol(
    'OBLIGATION_WAIVER_REPOSITORY',
);
export interface ObligationWaiverRepository {
    save(
        waiver: ObligationWaiver,
        before: InterMemberObligation,
        after: InterMemberObligation,
    ): Promise<void>;
    options(
        spaceId: string,
        obligationId: string,
    ): Promise<ObligationWaiverOptions | null>;
    history(
        spaceId: string,
        obligationId: string,
        after: PositionKey | null,
    ): Promise<ObligationWaiverResult[]>;
}
