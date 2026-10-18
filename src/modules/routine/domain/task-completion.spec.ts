import { describe, it, expect } from 'vitest';
import { completeTask, reopenTask } from './task-completion.js';
import type { Task } from './task.js';
const task: Task = {
    id: 't',
    spaceId: 's',
    description: 'Limpar',
    creator: { personId: 'a', memberId: 'ma' },
    assignee: { personId: 'b', memberId: 'mb' },
    deadline: { date: '2026-10-17', time: null },
    urgency: 'NORMAL',
    status: 'PENDING',
    version: 1,
    createdAt: '2026-10-18T12:00:00Z',
    completion: null,
    shoppingListId: null,
};
describe('completion and reopening', () => {
    it('keeps responsibility distinct from execution and preserves the completed snapshot', () => {
        const completed = completeTask(
            task,
            task.creator,
            '2026-10-18T13:00:00Z',
        );
        expect(completed.completion).toEqual({
            executor: task.creator,
            assignee: task.assignee,
            completedAt: '2026-10-18T13:00:00Z',
        });
        const reopened = reopenTask(completed);
        expect(reopened).toMatchObject({
            status: 'PENDING',
            version: 3,
            completion: null,
            assignee: task.assignee,
            deadline: task.deadline,
            urgency: 'NORMAL',
        });
        expect(completed.completion?.executor).toEqual(task.creator);
        expect(
            completeTask(reopened, task.assignee!, '2026-10-18T14:00:00Z')
                .completion?.executor,
        ).toEqual(task.assignee);
    });
    it.each(['COMPLETED', 'CANCELLED'] as const)(
        'does not complete %s',
        (status) =>
            expect(() =>
                completeTask({ ...task, status }, task.creator, task.createdAt),
            ).toThrow(),
    );
    it.each(['PENDING', 'CANCELLED'] as const)('does not reopen %s', (status) =>
        expect(() => reopenTask({ ...task, status })).toThrow(),
    );
});
