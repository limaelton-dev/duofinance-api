import type {
    OpenObligationView,
    PositionDirection,
    PositionKey,
} from '../../models/inter-member-position.js';
export const INTER_MEMBER_POSITION_READER = Symbol(
    'INTER_MEMBER_POSITION_READER',
);
export interface InterMemberPositionReader {
    read(
        spaceId: string,
        actorMemberId: string,
        direction: PositionDirection,
        after: PositionKey | null,
    ): Promise<{
        payableAmountInCents: string;
        receivableAmountInCents: string;
        items: OpenObligationView[];
    }>;
}
