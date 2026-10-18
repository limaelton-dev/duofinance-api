import { Module } from '@nestjs/common';
import {
    TaskRecurrenceOrmEntity,
    TaskOccurrenceOrmEntity,
} from './infrastructure/task-recurrence.orm-entity.js';
import { TASK_RECURRENCE_STORE } from './application/task-recurrence-store.js';
import { TypeOrmTaskRecurrenceStore } from './infrastructure/typeorm-task-recurrence-store.js';
import { TaskRecurrenceCommands } from './application/task-recurrence-commands.js';
import { TaskOccurrenceCommands } from './application/task-occurrence-commands.js';
import { TaskRecurrenceQueries } from './application/task-recurrence-queries.js';
import { TaskRecurrenceController } from './http/task-recurrence.controller.js';
import { TaskMaintenance } from './application/task-maintenance.js';
import { TaskMaintenanceController } from './http/task-maintenance.controller.js';
import { TaskCompletion } from './application/task-completion.js';
import { TaskCompletionController } from './http/task-completion.controller.js';
import { TASK_ATTENTION_READER } from './application/task-attention-reader.js';
import { TypeOrmTaskAttentionReader } from './infrastructure/typeorm-task-attention-reader.js';
import { TaskAttentionQuery } from './application/task-attention-query.js';
import { RoutineAttentionQuery } from './application/routine-attention-query.js';
import { ROUTINE_ATTENTION_QUERY } from './application/ports/public/routine-attention-query.port.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../../shared/technical/database/database.module.js';
import { SpacesModule } from '../spaces/spaces.module.js';
import {
    TaskOrmEntity,
    RoutineHistoryOrmEntity,
    RoutineReceiptOrmEntity,
    RoutineAuditOrmEntity,
} from './infrastructure/routine.orm-entity.js';
import { TypeOrmRoutineStore } from './infrastructure/typeorm-routine-store.js';
import { ROUTINE_STORE } from './application/routine-store.js';
import { ROUTINE_CLOCK } from './application/routine-clock.js';
import { RoutineCommands } from './application/routine-commands.js';
import { TaskCreation } from './application/task-creation.js';
import { TaskQueries } from './application/task-queries.js';
import { TaskController } from './http/task.controller.js';
@Module({
    imports: [
        DatabaseModule,
        SpacesModule,
        TypeOrmModule.forFeature([
            TaskRecurrenceOrmEntity,
            TaskOccurrenceOrmEntity,
            TaskOrmEntity,
            RoutineHistoryOrmEntity,
            RoutineReceiptOrmEntity,
            RoutineAuditOrmEntity,
        ]),
    ],
    providers: [
        {
            provide: TASK_RECURRENCE_STORE,
            useClass: TypeOrmTaskRecurrenceStore,
        },
        TaskRecurrenceCommands,
        TaskOccurrenceCommands,
        TaskRecurrenceQueries,
        TaskMaintenance,
        TaskCompletion,
        {
            provide: TASK_ATTENTION_READER,
            useClass: TypeOrmTaskAttentionReader,
        },
        { provide: ROUTINE_ATTENTION_QUERY, useClass: RoutineAttentionQuery },
        TaskAttentionQuery,
        { provide: ROUTINE_STORE, useClass: TypeOrmRoutineStore },
        { provide: ROUTINE_CLOCK, useValue: { now: () => new Date() } },
        RoutineCommands,
        TaskCreation,
        TaskQueries,
    ],
    controllers: [
        TaskRecurrenceController,
        TaskController,
        TaskCompletionController,
        TaskMaintenanceController,
    ],
    exports: [ROUTINE_ATTENTION_QUERY],
})
export class RoutineModule {}
