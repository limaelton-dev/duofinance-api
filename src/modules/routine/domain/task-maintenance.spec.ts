import { describe, it, expect } from 'vitest';
import { maintainTask } from './task-maintenance.js';
import type { Task } from './task.js';
const task: Task = {
    id: 't',
    spaceId: 's',
    description: 'Fazer',
    creator: { personId: 'a', memberId: null },
    assignee: { personId: 'a', memberId: null },
    deadline: { date: '2026-10-17', time: '12:00' },
    urgency: 'NORMAL',
    status: 'PENDING',
    version: 1,
    createdAt: '2026-10-18T12:00:00Z',
    completion: null,
    shoppingListId: null,
};
describe('pending task maintenance', () => {
    it('changes or removes deadline without changing responsibility or urgency', () => {
        const after = maintainTask(task, { kind: 'DEADLINE', deadline: null });
        expect(after).toEqual({ ...task, deadline: null, version: 2 });
        expect(task.deadline?.time).toBe('12:00');
    });
    it('changes urgency independently and cancels explicitly', () => {
        const urgent = maintainTask(task, {
            kind: 'URGENCY',
            urgency: 'URGENT',
        });
        expect(urgent).toEqual({ ...task, urgency: 'URGENT', version: 2 });
        expect(maintainTask(urgent, { kind: 'CANCEL' })).toMatchObject({
            status: 'CANCELLED',
            version: 3,
            completion: null,
            deadline: task.deadline,
        });
    });
    it.each(['COMPLETED', 'CANCELLED'] as const)(
        'protects %s from maintenance',
        (status) => {
            for (const change of [
                { kind: 'CANCEL' },
                { kind: 'URGENCY', urgency: 'HIGH' },
                { kind: 'DEADLINE', deadline: null },
            ] as const)
                expect(() =>
                    maintainTask({ ...task, status }, change),
                ).toThrow();
        },
    );
    it('rejects invalid deadlines in domain', () =>
        expect(() =>
            maintainTask(task, {
                kind: 'DEADLINE',
                deadline: { date: '2026-02-29', time: null },
            }),
        ).toThrow());
});
