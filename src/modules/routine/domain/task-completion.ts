import { RoutineError } from './routine-error.js';
import type { Task, Participant } from './task.js';
type CompletableTask = Omit<Task, 'shoppingListId' | 'status'> & {
    status: Task['status'] | 'SKIPPED';
};
export function completeTask<T extends CompletableTask>(
    task: T,
    executor: Participant,
    completedAt: string,
): Omit<T, 'status' | 'completion' | 'version'> & {
    status: 'COMPLETED';
    version: number;
    completion: NonNullable<Task['completion']>;
} {
    if (task.status !== 'PENDING')
        throw new RoutineError('INVALID_TASK_TRANSITION');
    return {
        ...task,
        status: 'COMPLETED' as const,
        version: task.version + 1,
        completion: {
            executor: { ...executor },
            completedAt,
            assignee: task.assignee ? { ...task.assignee } : null,
        },
    };
}
export function reopenTask<T extends CompletableTask>(
    task: T,
): Omit<T, 'status' | 'completion' | 'version'> & {
    status: 'PENDING';
    version: number;
    completion: null;
} {
    if (task.status !== 'COMPLETED')
        throw new RoutineError('INVALID_TASK_TRANSITION');
    return {
        ...task,
        status: 'PENDING' as const,
        version: task.version + 1,
        completion: null,
    };
}
