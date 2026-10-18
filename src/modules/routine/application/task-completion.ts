import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RoutineCommands } from './routine-commands.js';
import { ROUTINE_STORE, type RoutineStore } from './routine-store.js';
import { completeTask, reopenTask } from '../domain/task-completion.js';
import { RoutineError } from '../domain/routine-error.js';
@Injectable()
export class TaskCompletion {
    constructor(
        private readonly commands: RoutineCommands,
        @Inject(ROUTINE_STORE) private readonly store: RoutineStore,
    ) {}
    execute(
        action: 'COMPLETE' | 'REOPEN',
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
            `${action}_TASK`,
            id,
            input,
            async (context, now) => {
                const before = await this.store.find(space, id);
                if (before.version !== input.expectedVersion)
                    throw new RoutineError('CONCURRENT_MODIFICATION');
                const after =
                    action === 'COMPLETE'
                        ? completeTask(
                              before,
                              {
                                  personId: actor,
                                  memberId: context.actorMemberId,
                              },
                              now,
                          )
                        : reopenTask(before);
                await this.store.update(before, after);
                await this.store.event({
                    id: randomUUID(),
                    spaceId: space,
                    aggregateId: id,
                    sequence: after.version,
                    type: action === 'COMPLETE' ? 'COMPLETED' : 'REOPENED',
                    actorId: actor,
                    registeredAt: new Date(now),
                    data: {
                        before: before.completion,
                        after: after.completion,
                        assignee: before.assignee,
                        deadline: before.deadline,
                        urgency: before.urgency,
                    },
                });
                return after;
            },
        );
    }
}
