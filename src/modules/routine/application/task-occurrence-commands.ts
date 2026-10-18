import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RoutineCommands } from './routine-commands.js';
import { ROUTINE_STORE, type RoutineStore } from './routine-store.js';
import {
    TASK_RECURRENCE_STORE,
    type TaskRecurrenceStore,
} from './task-recurrence-store.js';
import {
    occurrenceSnapshot,
    type TaskOccurrence,
} from '../domain/task-recurrence.js';
import { completeTask, reopenTask } from '../domain/task-completion.js';
import type { Task } from '../domain/task.js';
import { RoutineError } from '../domain/routine-error.js';
export interface OccurrenceCommandInput {
    expectedRecurrenceVersion: number;
    expectedOccurrenceVersion: number | null;
}
@Injectable()
export class TaskOccurrenceCommands {
    constructor(
        private readonly commands: RoutineCommands,
        @Inject(ROUTINE_STORE) private readonly history: RoutineStore,
        @Inject(TASK_RECURRENCE_STORE)
        private readonly store: TaskRecurrenceStore,
    ) {}
    execute(
        action: 'COMPLETE' | 'REOPEN' | 'SKIP',
        actor: string,
        space: string,
        id: string,
        date: string,
        key: string,
        input: OccurrenceCommandInput,
    ) {
        return this.commands.execute(
            actor,
            space,
            key,
            `${action}_TASK_OCCURRENCE`,
            `${id}/${date}`,
            input,
            async (context, now) => {
                const recurrence = await this.store.find(space, id, true);
                if (recurrence.version !== input.expectedRecurrenceVersion)
                    throw new RoutineError('CONCURRENT_MODIFICATION');
                const before = await this.store.occurrence(space, id, date);
                if (
                    (before?.version ?? null) !==
                    input.expectedOccurrenceVersion
                )
                    throw new RoutineError('CONCURRENT_MODIFICATION');
                const snapshot =
                    before ??
                    occurrenceSnapshot(recurrence, date, randomUUID(), now);
                if (
                    (action === 'REOPEN' && snapshot.status !== 'COMPLETED') ||
                    (action !== 'REOPEN' && snapshot.status !== 'PENDING')
                )
                    throw new RoutineError('INVALID_TASK_TRANSITION');
                const changed =
                    action === 'COMPLETE'
                        ? completeTask(
                              snapshot as Task,
                              {
                                  personId: actor,
                                  memberId: context.actorMemberId,
                              },
                              now,
                          )
                        : action === 'REOPEN'
                          ? reopenTask(snapshot as Task)
                          : {
                                ...snapshot,
                                status: 'SKIPPED' as const,
                                version: snapshot.version + 1,
                            };
                const after: TaskOccurrence = {
                    ...changed,
                    recurrenceId: id,
                    scheduledDate: date,
                    version: before ? before.version + 1 : 1,
                };
                await this.store.saveOccurrence(before, after);
                await this.history.event({
                    id: randomUUID(),
                    spaceId: space,
                    aggregateId: after.id,
                    sequence: after.version,
                    type:
                        action === 'COMPLETE'
                            ? 'COMPLETED'
                            : action === 'REOPEN'
                              ? 'REOPENED'
                              : 'SKIPPED',
                    actorId: actor,
                    registeredAt: new Date(now),
                    data: {
                        recurrenceId: id,
                        scheduledDate: date,
                        materialized: before === null,
                        snapshot: before === null ? snapshot : null,
                        before: before?.completion ?? null,
                        after: after.completion,
                        assignee: snapshot.assignee,
                        deadline: snapshot.deadline,
                        urgency: snapshot.urgency,
                    },
                });
                return {
                    ...after,
                    kind: 'OCCURRENCE' as const,
                    materialized: true,
                    recurrenceVersion: recurrence.version,
                };
            },
        );
    }
}
