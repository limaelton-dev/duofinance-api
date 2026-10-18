import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
    assignTask,
    validateTask,
    type Deadline,
    type Task,
    type Urgency,
} from '../domain/task.js';
import { RoutineError } from '../domain/routine-error.js';
import { RoutineCommands, resolveAssignee } from './routine-commands.js';
import { ROUTINE_STORE, type RoutineStore } from './routine-store.js';
export interface CreateTaskInput {
    description: string;
    assigneeMemberId?: string | null;
    deadline?: Deadline;
    urgency: Urgency;
}
@Injectable()
export class TaskCreation {
    constructor(
        private readonly commands: RoutineCommands,
        @Inject(ROUTINE_STORE) private readonly store: RoutineStore,
    ) {}
    create(actor: string, space: string, key: string, input: CreateTaskInput) {
        return this.commands.execute(
            actor,
            space,
            key,
            'CREATE_TASK',
            space,
            input,
            async (context, now) => {
                const task: Task = {
                    id: randomUUID(),
                    spaceId: space,
                    description: input.description,
                    creator: {
                        personId: actor,
                        memberId: context.actorMemberId,
                    },
                    assignee: resolveAssignee(context, input.assigneeMemberId),
                    deadline: input.deadline ?? null,
                    urgency: input.urgency,
                    status: 'PENDING',
                    version: 1,
                    createdAt: now,
                    completion: null,
                };
                validateTask(task);
                await this.store.insert(task);
                await this.store.event({
                    id: randomUUID(),
                    spaceId: space,
                    aggregateId: task.id,
                    sequence: 1,
                    type: 'CREATED',
                    actorId: actor,
                    registeredAt: new Date(now),
                    data: { task },
                });
                return task;
            },
        );
    }
    assign(
        actor: string,
        space: string,
        id: string,
        key: string,
        input: { expectedVersion: number; assigneeMemberId: string | null },
    ) {
        return this.commands.execute(
            actor,
            space,
            key,
            'ASSIGN_TASK',
            id,
            input,
            async (context, now) => {
                const before = await this.store.find(space, id);
                if (before.version !== input.expectedVersion)
                    throw new RoutineError('CONCURRENT_MODIFICATION');
                const after = assignTask(
                    before,
                    resolveAssignee(context, input.assigneeMemberId),
                );
                await this.store.update(before, after);
                await this.store.event({
                    id: randomUUID(),
                    spaceId: space,
                    aggregateId: id,
                    sequence: after.version,
                    type: 'ASSIGNED',
                    actorId: actor,
                    registeredAt: new Date(now),
                    data: { before: before.assignee, after: after.assignee },
                });
                return after;
            },
        );
    }
}
