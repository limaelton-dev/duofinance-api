import type { SpaceAccessContext } from '../../modules/spaces/application/ports/public/space-access.port.js';
import type { FinanceTodaySettlementSummary } from '../../modules/finances/application/ports/public/finance-today-query.port.js';

export interface TodayResponse {
    spaceId: string;
    spaceType: SpaceAccessContext['type'];
    spaceStatus: SpaceAccessContext['status'];
    referenceDate: string;
    finance:
        | {
              status: 'AVAILABLE';
              data: {
                  upcomingCommitments: { items: []; totalCount: 0 };
                  settlements: FinanceTodaySettlementSummary | null;
              };
          }
        | {
              status: 'UNAVAILABLE';
              error: {
                  code: 'FINANCE_TODAY_UNAVAILABLE';
                  message: string;
              };
          };
}
