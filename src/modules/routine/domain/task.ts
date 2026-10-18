import { RoutineError } from './routine-error.js';

export type Urgency = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type Deadline = { date: string; time: string | null } | null;
export type Participant = { personId: string; memberId: string | null };
export interface Task {
    id: string;
    spaceId: string;
    description: string;
    creator: Participant;
    assignee: Participant | null;
    deadline: Deadline;
    urgency: Urgency;
    status: 'PENDING' | 'COMPLETED' | 'CANCELLED';
    version: number;
    createdAt: string;
    completion: {
        executor: Participant;
        completedAt: string;
        assignee: Participant | null;
    } | null;
}
export function validDate(value: string): boolean {
    const instant = new Date(value + 'T12:00:00Z');
    return (
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        value >= '0001-01-01' &&
        value <= '9999-12-31' &&
        Number.isFinite(instant.getTime()) &&
        instant.toISOString().slice(0, 10) === value
    );
}
export function validateTask(
    input: Pick<Task, 'description' | 'deadline' | 'urgency'>,
) {
    if (
        !input.description.trim() ||
        input.description !== input.description.trim() ||
        input.description.length > 500
    )
        throw new RoutineError('VALIDATION_ERROR', 'description');
    if (!['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(input.urgency))
        throw new RoutineError('VALIDATION_ERROR', 'urgency');
    if (
        input.deadline &&
        (!validDate(input.deadline.date) ||
            (input.deadline.time !== null &&
                !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.deadline.time)))
    )
        throw new RoutineError('VALIDATION_ERROR', 'deadline');
}
export function assignTask(task: Task, assignee: Participant | null): Task {
    if (task.status !== 'PENDING')
        throw new RoutineError('INVALID_TASK_TRANSITION');
    return { ...task, assignee, version: task.version + 1 };
}
