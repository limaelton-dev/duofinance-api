import type { PersonId } from '../../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../../spaces/domain/space/space-id.js';

export const INCOME_TODAY_QUERY_PORT = Symbol('INCOME_TODAY_QUERY_PORT');
export interface IncomeTodayQueryPort {
    readUpcoming(
        actor: PersonId,
        space: SpaceId,
        referenceDate: string,
    ): Promise<{
        items: {
            commitmentId: string;
            kind: 'INCOME';
            description: string;
            expectedReceiptDate: string;
            amountInCents: number;
        }[];
        totalCount: number;
    }>;
}
