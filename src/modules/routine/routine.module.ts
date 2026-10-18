import { Module } from '@nestjs/common';
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
            TaskOrmEntity,
            RoutineHistoryOrmEntity,
            RoutineReceiptOrmEntity,
            RoutineAuditOrmEntity,
        ]),
    ],
    providers: [
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
    controllers: [TaskController],
    exports: [ROUTINE_ATTENTION_QUERY],
})
export class RoutineModule {}
