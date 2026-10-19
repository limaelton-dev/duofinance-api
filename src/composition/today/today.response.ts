import type { SpaceAccessContext } from '../../modules/spaces/application/ports/public/space-access.port.js';
import type {
    FinanceTodayCompositionRead,
    FinancialTodayItem,
} from '../../modules/finances/application/ports/public/finance-today-composition-query.port.js';
import type { RoutineTodayRead } from '../../modules/routine/application/ports/public/routine-today-query.port.js';
import type { ShoppingAttentionRead } from '../../modules/shopping/application/ports/public/shopping-attention-query.port.js';

export type TodaySource<T, Code extends string> =
    | { status: 'AVAILABLE'; data: T }
    | { status: 'UNAVAILABLE'; error: { code: Code; message: string } };

type TaskPreview = RoutineTodayRead['tasks']['items'][number];
type ShoppingPreview = ShoppingAttentionRead['items'][number];
type ProposalPreview =
    FinanceTodayCompositionRead['proposals']['items'][number];
type CyclePreview = NonNullable<
    FinanceTodayCompositionRead['legacy']['settlements']
>['overdueCycles']['items'][number];

type PreviewItem<Type extends string, Reference, Details> = {
    type: Type;
    reference: { type: Type } & Reference;
    label: string;
    date: string | null;
    details: Details;
};

export type TodayPreviewItem =
    | PreviewItem<
          'TASK',
          {
              taskId: string;
              kind: 'ONE_OFF' | 'OCCURRENCE';
              recurrenceId: string | null;
              scheduledDate: string | null;
          },
          TaskPreview
      >
    | PreviewItem<'SHOPPING_LIST', { listId: string }, ShoppingPreview>
    | PreviewItem<
          'FINANCIAL_COMMITMENT',
          Pick<
              FinancialTodayItem,
              'commitmentId' | 'occurrenceId' | 'modality' | 'expectedDate'
          >,
          FinancialTodayItem
      >
    | PreviewItem<
          'CHANGE_PROPOSAL',
          { proposalId: string; commitmentId: string },
          ProposalPreview
      >
    | PreviewItem<'SETTLEMENT_CYCLE', { cycleId: string }, CyclePreview>;

export interface TodayBlock {
    kind:
        | 'ATTENTION'
        | 'TODAY'
        | 'NEXT_SETTLEMENT'
        | 'UPCOMING'
        | 'TASKS'
        | 'SHOPPING';
    status: 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE' | 'NOT_APPLICABLE';
    items: TodayPreviewItem[];
    totalCount: number | null;
    knownTotalCount: number;
    hasMore: boolean | null;
}

export interface TodayResponse {
    spaceId: string;
    spaceType: SpaceAccessContext['type'];
    spaceStatus: SpaceAccessContext['status'];
    referenceDate: string;
    finance: TodaySource<
        FinanceTodayCompositionRead['legacy'],
        'FINANCE_TODAY_UNAVAILABLE'
    >;
    routine: TodaySource<
        RoutineTodayRead['legacy'],
        'ROUTINE_TODAY_UNAVAILABLE'
    >;
    shopping: TodaySource<ShoppingAttentionRead, 'SHOPPING_TODAY_UNAVAILABLE'>;
    blocks: TodayBlock[];
    capabilities: { spaceClosureAttention: 'NOT_SUPPORTED' };
}
