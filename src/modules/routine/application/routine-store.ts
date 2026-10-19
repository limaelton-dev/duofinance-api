import type { Task } from '../domain/task.js';
import type { LinkedTaskReference } from './ports/public/routine-linked-tasks.port.js';
export const ROUTINE_STORE = Symbol('ROUTINE_STORE');
export interface HistoryEvent {
    id: string;
    spaceId: string;
    aggregateId: string;
    sequence: number;
    type: string;
    actorId: string;
    registeredAt: Date;
    data: object;
}
export interface RoutineStore {
    find(space: string, id: string): Promise<Task>;
    insert(task: Task): Promise<void>;
    update(before: Task, after: Task): Promise<void>;
    linkedTasks(
        space: string,
        list: string,
        after: { createdAt: string; id: string } | null,
        limit: number,
    ): Promise<{ items: LinkedTaskReference[]; totalCount: number }>;
    event(event: HistoryEvent): Promise<void>;
    history(
        space: string,
        id: string,
        after: number,
        limit: number,
    ): Promise<HistoryEvent[]>;
    lockReceipt(actor: string, operation: string, key: string): Promise<void>;
    receipt(
        actor: string,
        operation: string,
        key: string,
    ): Promise<{ digest: string; result: object } | null>;
    finish(input: {
        actorId: string;
        spaceId: string;
        operation: string;
        key: string;
        digest: string;
        result: object;
        aggregateId: string;
        registeredAt: Date;
    }): Promise<void>;
    snapshot<T>(work: () => Promise<T>): Promise<T>;
}
