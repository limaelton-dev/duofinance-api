import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RoutineCommands } from './routine-commands.js';
import { ROUTINE_STORE, type RoutineStore } from './routine-store.js';
import {
    maintainTask,
    type TaskMaintenanceChange,
} from '../domain/task-maintenance.js';
import { RoutineError } from '../domain/routine-error.js';
@Injectable()
export class TaskMaintenance {
    constructor(
        private readonly commands: RoutineCommands,
        @Inject(ROUTINE_STORE) private readonly store: RoutineStore,
    ) {}
    execute(
        actor: string,
        space: string,
        id: string,
        key: string,
        input: TaskMaintenanceChange & { expectedVersion: number },
    ) {
        return this.commands.execute(
            actor,
            space,
            key,
            `${input.kind}_TASK`,
            id,
            input,
            async (_context, now) => {
                const before = await this.store.find(space, id);
                if (before.version !== input.expectedVersion)
                    throw new RoutineError('CONCURRENT_MODIFICATION');
                const after = maintainTask(before, input);
                await this.store.update(before, after);
                await this.store.event({
                    id: randomUUID(),
                    spaceId: space,
                    aggregateId: id,
                    sequence: after.version,
                    type:
                        input.kind === 'CANCEL'
                            ? 'CANCELLED'
                            : `${input.kind}_CHANGED`,
                    actorId: actor,
                    registeredAt: new Date(now),
                    data: {
                        before:
                            input.kind === 'DEADLINE'
                                ? before.deadline
                                : input.kind === 'URGENCY'
                                  ? before.urgency
                                  : before.status,
                        after:
                            input.kind === 'DEADLINE'
                                ? after.deadline
                                : input.kind === 'URGENCY'
                                  ? after.urgency
                                  : after.status,
                    },
                });
                return after;
            },
        );
    }
}
