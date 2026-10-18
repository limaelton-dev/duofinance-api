import {
    Body,
    Controller,
    Header,
    HttpCode,
    Param,
    Post,
} from '@nestjs/common';
import { z } from 'zod';
import {
    CurrentActor,
    type RequestActor,
} from '../../../shared/technical/http/current-actor.decorator.js';
import { IdempotencyKey } from '../../../shared/technical/http/idempotency-key.decorator.js';
import { TaskMaintenance } from '../application/task-maintenance.js';
import {
    params,
    parseZodInput,
    version,
    deadline,
    urgency,
} from './routine.dto.js';
const deadlineInput = z.object({ expectedVersion: version, deadline }).strict();
const urgencyInput = z.object({ expectedVersion: version, urgency }).strict();
const cancelInput = z.object({ expectedVersion: version }).strict();
@Controller('spaces/:spaceId/tasks/:taskId')
export class TaskMaintenanceController {
    constructor(private readonly maintenance: TaskMaintenance) {}
    @Post('deadline')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    deadline(
        @CurrentActor() a: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        const p = params(raw);
        return this.maintenance.execute(
            a.personId.value,
            p.spaceId,
            p.taskId!,
            key,
            { kind: 'DEADLINE', ...parseZodInput(deadlineInput, body) },
        );
    }
    @Post('urgency')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    urgency(
        @CurrentActor() a: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        const p = params(raw);
        return this.maintenance.execute(
            a.personId.value,
            p.spaceId,
            p.taskId!,
            key,
            { kind: 'URGENCY', ...parseZodInput(urgencyInput, body) },
        );
    }
    @Post('cancel')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    cancel(
        @CurrentActor() a: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        const p = params(raw);
        return this.maintenance.execute(
            a.personId.value,
            p.spaceId,
            p.taskId!,
            key,
            { kind: 'CANCEL', ...parseZodInput(cancelInput, body) },
        );
    }
}
