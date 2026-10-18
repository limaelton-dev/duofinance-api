import type {
    TaskRecurrence,
    TaskOccurrence,
} from '../domain/task-recurrence.js';
export const TASK_RECURRENCE_STORE = Symbol('TASK_RECURRENCE_STORE');
export interface TaskRecurrenceStore {
    find(space: string, id: string, lock?: boolean): Promise<TaskRecurrence>;
    insert(recurrence: TaskRecurrence): Promise<void>;
    update(before: TaskRecurrence, after: TaskRecurrence): Promise<void>;
    page(
        space: string,
        after: string | null,
        limit: number,
    ): Promise<TaskRecurrence[]>;
    occurrence(
        space: string,
        id: string,
        date: string,
    ): Promise<TaskOccurrence | null>;
    saveOccurrence(
        before: TaskOccurrence | null,
        after: TaskOccurrence,
    ): Promise<void>;
    occurrences(
        space: string,
        id: string,
        from: string,
        to: string,
    ): Promise<TaskOccurrence[]>;
}
