import { describe, it, expect } from 'vitest';
import { routineReference } from '../application/routine-clock.js';
import { taskAttention } from './task-attention.js';
describe('task attention and Sao Paulo calendar', () => {
    const task = {
        status: 'PENDING' as const,
        urgency: 'NORMAL' as const,
        deadline: { date: '2026-10-18', time: '10:00' },
    };
    it('uses the local calendar across the UTC day boundary', () =>
        expect(
            routineReference(new Date('2026-10-19T01:00:00Z')).referenceDate,
        ).toBe('2026-10-18'));
    it('considers an explicit local deadline overdue only after its instant', () => {
        expect(
            taskAttention(
                task,
                routineReference(new Date('2026-10-18T12:00:00Z')),
            ),
        ).toMatchObject({ today: true, overdue: false });
        expect(
            taskAttention(
                task,
                routineReference(new Date('2026-10-18T13:00:00Z')),
            ).overdue,
        ).toBe(false);
        expect(
            taskAttention(
                task,
                routineReference(new Date('2026-10-18T13:00:00.001Z')),
            ),
        ).toMatchObject({ today: true, overdue: true, urgent: false });
    });
    it('keeps date-only deadlines through the entire local day and urgency independent', () => {
        expect(
            taskAttention(
                { ...task, deadline: { date: '2026-10-18', time: null } },
                routineReference(new Date('2026-10-19T02:59:59.999Z')),
            ).overdue,
        ).toBe(false);
        expect(
            taskAttention(
                { ...task, deadline: null, urgency: 'URGENT' },
                routineReference(new Date('2026-10-19T03:00:00Z')),
            ),
        ).toMatchObject({ noDeadline: true, overdue: false, urgent: true });
    });
});
