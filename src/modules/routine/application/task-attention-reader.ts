import type { TaskItem } from '../domain/task-item.js';
import type {
    AttentionReference,
    TaskAttention,
} from '../domain/task-attention.js';
export interface TaskListFilters {
    status: 'PENDING' | 'COMPLETED' | 'CANCELLED' | 'SKIPPED' | 'ALL';
    scope: 'MINE' | 'ALL';
    attention?: TaskAttention | 'ATTENTION';
    from?: string;
    to?: string;
}
export interface TaskAttentionCounts {
    totalCount: number;
    today: number;
    overdue: number;
    urgent: number;
    upcoming: number;
    noDeadline: number;
}
export const TASK_ATTENTION_READER = Symbol('TASK_ATTENTION_READER');
export interface TaskAttentionReader {
    read(
        space: string,
        actor: string,
        filters: TaskListFilters,
        reference: AttentionReference,
        after: string | null,
        limit: number,
    ): Promise<{
        rows: { task: TaskItem; sortKey: string }[];
        counts: TaskAttentionCounts;
    }>;
}
