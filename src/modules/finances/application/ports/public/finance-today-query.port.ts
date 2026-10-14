import type { PersonId } from '../../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../../spaces/domain/space/space-id.js';
import type { SpaceFinancialContext } from '../../../../spaces/application/ports/public/space-financial-context.port.js';
import type { SettlementCycleSummary } from '../../models/settlement-cycle.js';

export const FINANCE_TODAY_QUERY_PORT = Symbol('FINANCE_TODAY_QUERY_PORT');

export interface FinanceTodaySettlementSummary {
    actorMemberId: string;
    members: SpaceFinancialContext['members'];
    nextCycle: SettlementCycleSummary | null;
    overdueCycles: {
        items: SettlementCycleSummary[];
        totalCount: number;
    };
}

export interface FinanceTodayRead extends FinanceTodaySettlementSummary {
    spaceId: string;
    spaceStatus: SpaceFinancialContext['status'];
    referenceDate: string;
}

export interface FinanceTodayQueryPort {
    read(
        actor: PersonId,
        space: SpaceId,
        referenceDate: string,
    ): Promise<FinanceTodayRead>;
}

export class FinanceTodayUnavailableError extends Error {
    constructor() {
        super('Finance today source unavailable');
    }
}
