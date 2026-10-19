import { RoutineError } from './routine-error.js';
import {
    validDate,
    validateTask,
    type Participant,
    type Urgency,
    type Task,
} from './task.js';
export type TaskRecurrenceRule =
    | { frequency: 'DAILY' }
    | { frequency: 'WEEKLY'; weekday: number }
    | { frequency: 'WEEKDAYS'; weekdays: number[] }
    | { frequency: 'MONTHLY'; day: number }
    | { frequency: 'ANNUAL'; month: number; day: number };
export interface TaskRecurrence {
    id: string;
    spaceId: string;
    description: string;
    creator: Participant;
    assignee: Participant | null;
    urgency: Urgency;
    deadline: { time: string | null } | null;
    rule: TaskRecurrenceRule;
    startsOn: string;
    endsOn: string | null;
    status: 'ACTIVE' | 'CANCELLED';
    version: number;
    createdAt: string;
    cancelledAt: string | null;
    cancelledOn: string | null;
}
export interface TaskOccurrence extends Omit<
    Task,
    'status' | 'shoppingListId'
> {
    recurrenceId: string;
    scheduledDate: string;
    status: Task['status'] | 'SKIPPED';
}
export function addDays(date: string, days: number): string {
    const instant = new Date(date + 'T12:00:00Z');
    instant.setUTCDate(instant.getUTCDate() + days);
    if (instant.getUTCFullYear() < 1) return '0001-01-01';
    if (instant.getUTCFullYear() > 9999) return '9999-12-31';
    return instant.toISOString().slice(0, 10);
}
export function isScheduled(rule: TaskRecurrenceRule, date: string): boolean {
    if (!validDate(date)) return false;
    const instant = new Date(date + 'T12:00:00Z'),
        year = instant.getUTCFullYear(),
        month = instant.getUTCMonth() + 1,
        day = instant.getUTCDate(),
        weekday = instant.getUTCDay() || 7;
    const lastDay = (m: number) => {
        const end = new Date(0);
        end.setUTCFullYear(year, m, 0);
        return end.getUTCDate();
    };
    switch (rule.frequency) {
        case 'DAILY':
            return true;
        case 'WEEKLY':
            return weekday === rule.weekday;
        case 'WEEKDAYS':
            return rule.weekdays.includes(weekday);
        case 'MONTHLY':
            return day === Math.min(rule.day, lastDay(month));
        case 'ANNUAL':
            return (
                month === rule.month &&
                day === Math.min(rule.day, lastDay(month))
            );
    }
}
export function eligibleOccurrence(
    recurrence: TaskRecurrence,
    date: string,
): boolean {
    return (
        date >= recurrence.startsOn &&
        (!recurrence.endsOn || date <= recurrence.endsOn) &&
        (!recurrence.cancelledOn || date <= recurrence.cancelledOn) &&
        isScheduled(recurrence.rule, date)
    );
}
export function validateRecurrence(recurrence: TaskRecurrence) {
    validateTask({
        ...recurrence,
        deadline: recurrence.deadline
            ? { date: recurrence.startsOn, time: recurrence.deadline.time }
            : null,
    });
    if (
        !validDate(recurrence.startsOn) ||
        (recurrence.endsOn !== null &&
            (!validDate(recurrence.endsOn) ||
                recurrence.endsOn < recurrence.startsOn))
    )
        throw new RoutineError('VALIDATION_ERROR', 'endsOn');
    const rule = recurrence.rule;
    const inRange = (n: number, min: number, max: number) =>
        Number.isInteger(n) && n >= min && n <= max;
    if (
        (rule.frequency === 'WEEKLY' && !inRange(rule.weekday, 1, 7)) ||
        (rule.frequency === 'WEEKDAYS' &&
            (!rule.weekdays.length ||
                new Set(rule.weekdays).size !== rule.weekdays.length ||
                !rule.weekdays.every((n) => inRange(n, 1, 7)))) ||
        (rule.frequency === 'MONTHLY' && !inRange(rule.day, 1, 31)) ||
        (rule.frequency === 'ANNUAL' &&
            (!inRange(rule.month, 1, 12) ||
                !inRange(
                    rule.day,
                    1,
                    new Date(Date.UTC(2024, rule.month, 0)).getUTCDate(),
                )))
    )
        throw new RoutineError('VALIDATION_ERROR', 'rule');
}
export function occurrenceSnapshot(
    recurrence: TaskRecurrence,
    date: string,
    id: string,
    now: string,
): TaskOccurrence {
    if (!eligibleOccurrence(recurrence, date))
        throw new RoutineError('OCCURRENCE_NOT_FOUND');
    return {
        id,
        spaceId: recurrence.spaceId,
        recurrenceId: recurrence.id,
        scheduledDate: date,
        description: recurrence.description,
        creator: { ...recurrence.creator },
        assignee: recurrence.assignee ? { ...recurrence.assignee } : null,
        deadline: recurrence.deadline
            ? { date, time: recurrence.deadline.time }
            : null,
        urgency: recurrence.urgency,
        status: 'PENDING',
        version: 1,
        createdAt: now,
        completion: null,
    };
}
