import type { Task } from './task.js';
export interface TaskItem extends Omit<Task, 'status' | 'version'> {
    status: Task['status'] | 'SKIPPED';
    version: number | null;
    kind?: 'ONE_OFF' | 'OCCURRENCE';
    recurrenceId?: string;
    scheduledDate?: string;
    recurrenceVersion?: number;
    materialized?: boolean;
}
