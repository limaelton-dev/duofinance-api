import { describe, it, expect } from 'vitest';
import { assignTask, validDate, validateTask, type Task } from './task.js';
const task: Task = {
    id: 'task',
    spaceId: 'space',
    description: 'Limpar cozinha',
    creator: { personId: 'a', memberId: 'ma' },
    assignee: null,
    deadline: null,
    urgency: 'NORMAL',
    status: 'PENDING',
    version: 1,
    createdAt: '2026-10-18T12:00:00Z',
    completion: null,
    shoppingListId: null,
};
describe('one-off task invariants', () => {
    it('changes responsibility without changing author or inventing an executor', () => {
        const changed = assignTask(task, { personId: 'b', memberId: 'mb' });
        expect(changed).toMatchObject({
            creator: task.creator,
            assignee: { personId: 'b', memberId: 'mb' },
            completion: null,
            version: 2,
        });
        expect(assignTask(changed, null).assignee).toBeNull();
        expect(task.assignee).toBeNull();
    });
    it.each(['COMPLETED', 'CANCELLED'] as const)(
        'rejects assignment in %s',
        (status) =>
            expect(() => assignTask({ ...task, status }, null)).toThrow(),
    );
    it.each(['2026-02-29', '2026-99-99', '0000-01-01', '18/10/2026'])(
        'rejects invalid civil date %s',
        (date) => expect(validDate(date)).toBe(false),
    );
    it('accepts independent urgency and optional date/time', () => {
        for (const deadline of [
            null,
            { date: '2024-02-29', time: null },
            { date: '2026-10-18', time: '23:59' },
        ])
            expect(() =>
                validateTask({ ...task, deadline, urgency: 'URGENT' }),
            ).not.toThrow();
        expect(() => validateTask({ ...task, description: ' ' })).toThrow();
        expect(() =>
            validateTask({
                ...task,
                deadline: { date: '2026-10-18', time: '24:00' },
            }),
        ).toThrow();
    });
});
