import { RoutineError } from './routine-error.js';
import type { Task, Participant } from './task.js';
export function completeTask(
    task: Task,
    executor: Participant,
    completedAt: string,
): Task {
    if (task.status !== 'PENDING')
        throw new RoutineError('INVALID_TASK_TRANSITION');
    return {
        ...task,
        status: 'COMPLETED',
        version: task.version + 1,
        completion: {
            executor: { ...executor },
            completedAt,
            assignee: task.assignee ? { ...task.assignee } : null,
        },
    };
}
export function reopenTask(task: Task): Task {
    if (task.status !== 'COMPLETED')
        throw new RoutineError('INVALID_TASK_TRANSITION');
    return {
        ...task,
        status: 'PENDING',
        version: task.version + 1,
        completion: null,
    };
}
