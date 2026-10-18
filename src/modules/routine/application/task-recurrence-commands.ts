import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RoutineCommands, resolveAssignee } from './routine-commands.js';
import { ROUTINE_STORE, type RoutineStore } from './routine-store.js';
import {
    TASK_RECURRENCE_STORE,
    type TaskRecurrenceStore,
} from './task-recurrence-store.js';
import { routineReference } from './routine-clock.js';
import {
    validateRecurrence,
    type TaskRecurrence,
    type TaskRecurrenceRule,
} from '../domain/task-recurrence.js';
import type { Urgency } from '../domain/task.js';
import { RoutineError } from '../domain/routine-error.js';
export interface CreateRecurrenceInput {
    description: string;
    assigneeMemberId?: string | null;
    urgency: Urgency;
    deadline: { time: string | null } | null;
    rule: TaskRecurrenceRule;
    startsOn: string;
    endsOn: string | null;
}
@Injectable()
export class TaskRecurrenceCommands {
    constructor(
        private readonly commands: RoutineCommands,
        @Inject(ROUTINE_STORE) private readonly history: RoutineStore,
        @Inject(TASK_RECURRENCE_STORE)
        private readonly store: TaskRecurrenceStore,
    ) {}
    create(
        actor: string,
        space: string,
        key: string,
        input: CreateRecurrenceInput,
    ) {
        return this.commands.execute(
            actor,
            space,
            key,
            'CREATE_TASK_RECURRENCE',
            space,
            input,
            async (context, now) => {
                const recurrence: TaskRecurrence = {
                    ...input,
                    id: randomUUID(),
                    spaceId: space,
                    creator: {
                        personId: actor,
                        memberId: context.actorMemberId,
                    },
                    assignee: resolveAssignee(context, input.assigneeMemberId),
                    status: 'ACTIVE',
                    version: 1,
                    createdAt: now,
                    cancelledAt: null,
                    cancelledOn: null,
                };
                delete (
                    recurrence as TaskRecurrence & {
                        assigneeMemberId?: string | null;
                    }
                ).assigneeMemberId;
                validateRecurrence(recurrence);
                await this.store.insert(recurrence);
                await this.history.event({
                    id: randomUUID(),
                    spaceId: space,
                    aggregateId: recurrence.id,
                    sequence: 1,
                    type: 'RECURRENCE_CREATED',
                    actorId: actor,
                    registeredAt: new Date(now),
                    data: { recurrence },
                });
                return recurrence;
            },
        );
    }
    cancel(
        actor: string,
        space: string,
        id: string,
        key: string,
        input: { expectedVersion: number },
    ) {
        return this.commands.execute(
            actor,
            space,
            key,
            'CANCEL_TASK_RECURRENCE',
            id,
            input,
            async (_context, now) => {
                const before = await this.store.find(space, id, true);
                if (before.version !== input.expectedVersion)
                    throw new RoutineError('CONCURRENT_MODIFICATION');
                if (before.status !== 'ACTIVE')
                    throw new RoutineError('INVALID_TASK_TRANSITION');
                const after: TaskRecurrence = {
                    ...before,
                    status: 'CANCELLED',
                    version: before.version + 1,
                    cancelledAt: now,
                    cancelledOn: routineReference(new Date(now)).referenceDate,
                };
                await this.store.update(before, after);
                await this.history.event({
                    id: randomUUID(),
                    spaceId: space,
                    aggregateId: id,
                    sequence: after.version,
                    type: 'RECURRENCE_CANCELLED',
                    actorId: actor,
                    registeredAt: new Date(now),
                    data: { cancelledOn: after.cancelledOn, cancelledAt: now },
                });
                return after;
            },
        );
    }
}
