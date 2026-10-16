import type { PersonId } from '../../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../../spaces/domain/space/space-id.js';

export const PLANNED_TODAY_QUERY_PORT = Symbol('PLANNED_TODAY_QUERY_PORT');
export interface PlannedTodayQueryPort {
    readUpcoming(
        actor: PersonId,
        space: SpaceId,
        referenceDate: string,
    ): Promise<{
        items: {
            commitmentId: string;
            occurrenceId: string | null;
            kind: 'EXPENSE' | 'INCOME';
            description: string;
            expectedDate: string;
            amountInCents: number;
            fulfilledAmountInCents: number;
            remainingAmountInCents: number;
            overdue: boolean;
        }[];
        totalCount: number;
    }>;
}
