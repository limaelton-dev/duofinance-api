import type { SpaceAccessContext } from '../../modules/spaces/application/ports/public/space-access.port.js';
import type { FinanceTodaySettlementSummary } from '../../modules/finances/application/ports/public/finance-today-query.port.js';
import type { IncomeTodayQueryPort } from '../../modules/finances/application/ports/public/income-today-query.port.js';

export interface TodayResponse {
    spaceId: string;
    spaceType: SpaceAccessContext['type'];
    spaceStatus: SpaceAccessContext['status'];
    referenceDate: string;
    finance:
        | {
              status: 'AVAILABLE';
              data: {
                  upcomingCommitments: Awaited<
                      ReturnType<IncomeTodayQueryPort['readUpcoming']>
                  >;
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
