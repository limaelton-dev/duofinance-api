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
import { TaskCompletion } from '../application/task-completion.js';
import { params, parseZodInput, version } from './routine.dto.js';
export const taskVersionInput = z.object({ expectedVersion: version }).strict();
@Controller('spaces/:spaceId/tasks/:taskId')
export class TaskCompletionController {
    constructor(private readonly completion: TaskCompletion) {}
    @Post('complete')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    complete(
        @CurrentActor() a: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        const p = params(raw);
        return this.completion.execute(
            'COMPLETE',
            a.personId.value,
            p.spaceId,
            p.taskId!,
            key,
            parseZodInput(taskVersionInput, body),
        );
    }
    @Post('reopen')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    reopen(
        @CurrentActor() a: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        const p = params(raw);
        return this.completion.execute(
            'REOPEN',
            a.personId.value,
            p.spaceId,
            p.taskId!,
            key,
            parseZodInput(taskVersionInput, body),
        );
    }
}
