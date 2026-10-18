import type { SpaceAccessContext } from '../../modules/spaces/application/ports/public/space-access.port.js';
import type { RoutineAttentionQueryPort } from '../../modules/routine/application/ports/public/routine-attention-query.port.js';
import type { FinanceTodaySettlementSummary } from '../../modules/finances/application/ports/public/finance-today-query.port.js';
import type { IncomeTodayQueryPort } from '../../modules/finances/application/ports/public/income-today-query.port.js';
import type { PlannedTodayQueryPort } from '../../modules/finances/application/ports/public/planned-today-query.port.js';

export interface TodayResponse {
    spaceId: string;
    spaceType: SpaceAccessContext['type'];
    spaceStatus: SpaceAccessContext['status'];
    referenceDate: string;
    routine:
        | {
              status: 'AVAILABLE';
              data: Awaited<ReturnType<RoutineAttentionQueryPort['read']>>;
          }
        | {
              status: 'UNAVAILABLE';
              error: { code: 'ROUTINE_TODAY_UNAVAILABLE'; message: string };
          };
    finance:
        | {
              status: 'AVAILABLE';
              data: {
                  upcomingCommitments: {
                      items: (
                          | Awaited<
                                ReturnType<IncomeTodayQueryPort['readUpcoming']>
                            >['items'][number]
                          | Awaited<
                                ReturnType<
                                    PlannedTodayQueryPort['readUpcoming']
                                >
                            >['items'][number]
                      )[];
                      totalCount: number;
                  };
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
