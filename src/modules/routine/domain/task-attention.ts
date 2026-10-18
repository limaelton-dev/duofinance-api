import type { TaskItem } from './task-item.js';
export interface AttentionReference {
    referenceDate: string;
    referenceTime: string;
    referenceInstant: string;
}
export type TaskAttention =
    'TODAY' | 'URGENT' | 'OVERDUE' | 'UPCOMING' | 'NO_DEADLINE';
export function taskAttention(
    task: Pick<TaskItem, 'status' | 'deadline' | 'urgency'>,
    reference: AttentionReference,
) {
    const pending = task.status === 'PENDING';
    const today = pending && task.deadline?.date === reference.referenceDate;
    const overdue =
        pending &&
        task.deadline !== null &&
        (task.deadline.time === null
            ? task.deadline.date < reference.referenceDate
            : `${task.deadline.date}T${task.deadline.time}:00.000` <
              `${reference.referenceDate}T${reference.referenceTime}:${reference.referenceInstant.slice(17, 23)}`);
    return {
        today,
        overdue,
        urgent: pending && task.urgency === 'URGENT',
        upcoming:
            pending &&
            task.deadline !== null &&
            task.deadline.date > reference.referenceDate,
        noDeadline: pending && task.deadline === null,
        group: overdue
            ? 'OVERDUE'
            : today
              ? 'TODAY'
              : task.deadline
                ? 'UPCOMING'
                : 'NO_DEADLINE',
    };
}
