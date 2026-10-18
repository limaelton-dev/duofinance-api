import { describe, it, expect } from 'vitest';
import {
    isScheduled,
    eligibleOccurrence,
    occurrenceSnapshot,
    validateRecurrence,
    addDays,
    type TaskRecurrence,
    type TaskRecurrenceRule,
} from './task-recurrence.js';
const recurrence: TaskRecurrence = {
    id: 'r',
    spaceId: 's',
    description: 'Rotina',
    creator: { personId: 'a', memberId: 'ma' },
    assignee: { personId: 'b', memberId: 'mb' },
    urgency: 'NORMAL',
    deadline: null,
    rule: { frequency: 'DAILY' },
    startsOn: '2026-10-01',
    endsOn: null,
    status: 'ACTIVE',
    version: 1,
    createdAt: '2026-10-18T14:00:00Z',
    cancelledOn: null,
    cancelledAt: null,
};
describe('task recurrence calendar and snapshots', () => {
    it.each<[TaskRecurrenceRule, string[], string[]]>([
        [{ frequency: 'DAILY' }, ['2026-10-18'], []],
        [
            { frequency: 'WEEKLY', weekday: 2 },
            ['2026-10-13', '2026-10-20'],
            ['2026-10-14'],
        ],
        [
            { frequency: 'WEEKDAYS', weekdays: [2, 5] },
            ['2026-10-13', '2026-10-16'],
            ['2026-10-17'],
        ],
        [
            { frequency: 'MONTHLY', day: 31 },
            ['2026-01-31', '2026-02-28', '2026-03-31', '2024-02-29'],
            ['2026-03-28'],
        ],
        [
            { frequency: 'ANNUAL', month: 2, day: 29 },
            ['2024-02-29', '2025-02-28', '2028-02-29'],
            ['2028-02-28'],
        ],
    ])('preserves the calendar for %j', (rule, valid, invalid) => {
        for (const date of valid) expect(isScheduled(rule, date)).toBe(true);
        for (const date of invalid) expect(isScheduled(rule, date)).toBe(false);
    });
    it('uses inclusive boundaries and retains dates through the cancellation day', () => {
        const r = {
            ...recurrence,
            startsOn: '2026-10-13',
            endsOn: '2026-10-20',
            cancelledOn: '2026-10-18',
            status: 'CANCELLED' as const,
        };
        expect(eligibleOccurrence(r, '2026-10-12')).toBe(false);
        expect(eligibleOccurrence(r, '2026-10-13')).toBe(true);
        expect(eligibleOccurrence(r, '2026-10-18')).toBe(true);
        expect(eligibleOccurrence(r, '2026-10-19')).toBe(false);
    });
    it('does not manufacture a deadline and copies independent occurrence snapshots', () => {
        const a = occurrenceSnapshot(
                recurrence,
                '2026-10-17',
                'a',
                '2026-10-18T14:00:00Z',
            ),
            b = occurrenceSnapshot(
                recurrence,
                '2026-10-18',
                'b',
                '2026-10-18T14:00:00Z',
            );
        expect(a.deadline).toBeNull();
        expect(a.assignee).toEqual(recurrence.assignee);
        expect(a.assignee).not.toBe(recurrence.assignee);
        expect(a.id).not.toBe(b.id);
    });
    it('validates day sets, dates, bounds and impossible annual dates', () => {
        for (const rule of [
            { frequency: 'WEEKDAYS', weekdays: [] },
            { frequency: 'WEEKDAYS', weekdays: [2, 2] },
            { frequency: 'WEEKLY', weekday: 0 },
            { frequency: 'MONTHLY', day: 32 },
            { frequency: 'ANNUAL', month: 4, day: 31 },
        ] as TaskRecurrenceRule[])
            expect(() => validateRecurrence({ ...recurrence, rule })).toThrow();
        expect(() =>
            validateRecurrence({ ...recurrence, endsOn: '2026-09-30' }),
        ).toThrow();
        expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    });
});
