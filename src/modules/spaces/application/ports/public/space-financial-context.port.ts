import type { PersonId } from '../../../domain/person/person-id.js';
import type { SpaceId } from '../../../domain/space/space-id.js';
export interface SpaceFinancialContext {
    spaceId: string;
    type: 'SHARED';
    status: 'ACTIVE' | 'CLOSING' | 'CLOSED';
    version: number;
    actorMemberId: string;
    closureCutoffDate?: string | null;
    members: { memberId: string; personId: string; displayName: string }[];
}
export const SPACE_FINANCIAL_CONTEXT_PORT = Symbol(
    'SPACE_FINANCIAL_CONTEXT_PORT',
);
export interface SpaceFinancialContextPort {
    read(actorId: PersonId, spaceId: SpaceId): Promise<SpaceFinancialContext>;
    lockForWrite(
        actorId: PersonId,
        spaceId: SpaceId,
    ): Promise<SpaceFinancialContext>;
    lockForSettlement(
        actorId: PersonId,
        spaceId: SpaceId,
    ): Promise<SpaceFinancialContext>;
    lockForFulfillment(
        actorId: PersonId,
        spaceId: SpaceId,
    ): Promise<SpaceFinancialContext>;
}
