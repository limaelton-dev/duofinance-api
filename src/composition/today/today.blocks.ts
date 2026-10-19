import type {
    FinanceTodayCompositionRead,
    FinancialTodayItem,
} from '../../modules/finances/application/ports/public/finance-today-composition-query.port.js';
import type { RoutineTodayRead } from '../../modules/routine/application/ports/public/routine-today-query.port.js';
import type { ShoppingAttentionRead } from '../../modules/shopping/application/ports/public/shopping-attention-query.port.js';
import type {
    TodayBlock,
    TodayPreviewItem,
    TodaySource,
    TodayResponse,
} from './today.response.js';

type Preview = { items: TodayPreviewItem[]; totalCount: number };
type Task = RoutineTodayRead['tasks']['items'][number];
type Cycle = NonNullable<
    FinanceTodayCompositionRead['legacy']['settlements']
>['overdueCycles']['items'][number];

function financialItem(item: FinancialTodayItem): TodayPreviewItem {
    return {
        type: 'FINANCIAL_COMMITMENT',
        reference: {
            type: 'FINANCIAL_COMMITMENT',
            commitmentId: item.commitmentId,
            occurrenceId: item.occurrenceId,
            modality: item.modality,
            expectedDate: item.expectedDate,
        },
        label: item.description,
        date: item.expectedDate,
        details: item,
    };
}
function taskItem(item: Task): TodayPreviewItem {
    return {
        type: 'TASK',
        reference: {
            type: 'TASK',
            taskId: item.id,
            kind: item.kind,
            recurrenceId: item.recurrenceId ?? null,
            scheduledDate: item.scheduledDate ?? null,
        },
        label: item.description,
        date: item.deadline?.date ?? null,
        details: item,
    };
}
function cycleItem(item: Cycle): TodayPreviewItem {
    return {
        type: 'SETTLEMENT_CYCLE',
        reference: { type: 'SETTLEMENT_CYCLE', cycleId: item.id },
        label: 'Acerto',
        date: item.targetDate,
        details: item,
    };
}
function mapPreview<T>(
    preview: { items: T[]; totalCount: number },
    map: (item: T) => TodayPreviewItem,
): Preview {
    return { items: preview.items.map(map), totalCount: preview.totalCount };
}
function block(
    kind: TodayBlock['kind'],
    previews: (Preview | null)[],
): TodayBlock {
    const available = previews.filter(
        (value): value is Preview => value !== null,
    );
    const knownTotalCount = available.reduce(
        (sum, preview) => sum + preview.totalCount,
        0,
    );
    const items = available
        .flatMap((preview) => preview.items)
        .slice(0, kind === 'ATTENTION' ? 3 : 4);
    const complete = available.length === previews.length;
    return {
        kind,
        status: complete
            ? 'AVAILABLE'
            : available.length
              ? 'PARTIAL'
              : 'UNAVAILABLE',
        items,
        totalCount: complete ? knownTotalCount : null,
        knownTotalCount,
        hasMore: complete ? knownTotalCount > items.length : null,
    };
}

export function todayBlocks(
    spaceType: 'PERSONAL' | 'SHARED',
    financial: TodaySource<
        FinanceTodayCompositionRead,
        'FINANCE_TODAY_UNAVAILABLE'
    >,
    routine: TodaySource<RoutineTodayRead, 'ROUTINE_TODAY_UNAVAILABLE'>,
    shopping: TodaySource<ShoppingAttentionRead, 'SHOPPING_TODAY_UNAVAILABLE'>,
    closure?: TodayResponse['closure'],
): TodayBlock[] {
    const finance = financial.status === 'AVAILABLE' ? financial.data : null;
    const tasks = routine.status === 'AVAILABLE' ? routine.data : null;
    const lists = shopping.status === 'AVAILABLE' ? shopping.data : null;
    const financeAttention: Preview | null = finance
        ? {
              items: [
                  ...(finance.legacy.settlements?.overdueCycles.items.map(
                      cycleItem,
                  ) ?? []),
                  ...finance.overdue.items.map(financialItem),
                  ...finance.proposals.items.map((item): TodayPreviewItem => ({
                      type: 'CHANGE_PROPOSAL',
                      reference: {
                          type: 'CHANGE_PROPOSAL',
                          proposalId: item.proposalId,
                          commitmentId: item.commitmentId,
                      },
                      label: 'Alteração financeira aguardando sua aprovação',
                      date: item.registeredAt.slice(0, 10),
                      details: item,
                  })),
              ],
              totalCount:
                  (finance.legacy.settlements?.overdueCycles.totalCount ?? 0) +
                  finance.overdue.totalCount +
                  finance.proposals.totalCount,
          }
        : null;
    return [
        block('ATTENTION', [
            ...(closure
                ? [
                      closure.status === 'AVAILABLE'
                          ? {
                                items:
                                    closure.data?.spaceStatus === 'CLOSING'
                                        ? [
                                              {
                                                  type: 'SPACE_CLOSURE' as const,
                                                  reference: {
                                                      type: 'SPACE_CLOSURE' as const,
                                                      processId:
                                                          closure.data
                                                              .processId,
                                                  },
                                                  label: 'Encerramento do espaço em andamento',
                                                  date: closure.data.cutoffDate,
                                                  details: closure.data,
                                              },
                                          ]
                                        : [],
                                totalCount:
                                    closure.data?.spaceStatus === 'CLOSING'
                                        ? 1
                                        : 0,
                            }
                          : null,
                  ]
                : []),
            financeAttention,
            tasks ? mapPreview(tasks.attention, taskItem) : null,
        ]),
        block('TODAY', [
            finance ? mapPreview(finance.today, financialItem) : null,
            tasks ? mapPreview(tasks.today, taskItem) : null,
        ]),
        spaceType === 'PERSONAL'
            ? {
                  kind: 'NEXT_SETTLEMENT',
                  status: 'NOT_APPLICABLE',
                  items: [],
                  totalCount: 0,
                  knownTotalCount: 0,
                  hasMore: false,
              }
            : block('NEXT_SETTLEMENT', [
                  finance
                      ? {
                            items: finance.legacy.settlements?.nextCycle
                                ? [
                                      cycleItem(
                                          finance.legacy.settlements.nextCycle,
                                      ),
                                  ]
                                : [],
                            totalCount: finance.legacy.settlements?.nextCycle
                                ? 1
                                : 0,
                        }
                      : null,
              ]),
        block('UPCOMING', [
            finance ? mapPreview(finance.upcoming, financialItem) : null,
        ]),
        block('TASKS', [tasks ? mapPreview(tasks.tasks, taskItem) : null]),
        block('SHOPPING', [
            lists
                ? {
                      items: lists.items.map((item): TodayPreviewItem => ({
                          type: 'SHOPPING_LIST',
                          reference: { type: 'SHOPPING_LIST', listId: item.id },
                          label: item.name ?? 'Lista de compras',
                          date: null,
                          details: item,
                      })),
                      totalCount: lists.totalCount,
                  }
                : null,
        ]),
    ];
}
