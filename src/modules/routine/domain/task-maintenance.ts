import { RoutineError } from './routine-error.js';
import {
    validateTask,
    type Task,
    type Deadline,
    type Urgency,
} from './task.js';
export type TaskMaintenanceChange =
    | { kind: 'DEADLINE'; deadline: Deadline }
    | { kind: 'URGENCY'; urgency: Urgency }
    | { kind: 'CANCEL' };
export function maintainTask(task: Task, change: TaskMaintenanceChange): Task {
    if (task.status !== 'PENDING')
        throw new RoutineError('INVALID_TASK_TRANSITION');
    const after: Task = {
        ...task,
        version: task.version + 1,
        ...(change.kind === 'DEADLINE'
            ? { deadline: change.deadline }
            : change.kind === 'URGENCY'
              ? { urgency: change.urgency }
              : { status: 'CANCELLED' }),
    };
    validateTask(after);
    return after;
}
