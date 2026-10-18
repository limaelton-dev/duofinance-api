import {
    Body,
    Controller,
    Get,
    Header,
    HttpCode,
    Param,
    Post,
    Query,
} from '@nestjs/common';
import {
    CurrentActor,
    type RequestActor,
} from '../../../shared/technical/http/current-actor.decorator.js';
import { IdempotencyKey } from '../../../shared/technical/http/idempotency-key.decorator.js';
import { TaskCreation } from '../application/task-creation.js';
import { TaskQueries } from '../application/task-queries.js';
import { TaskAttentionQuery } from '../application/task-attention-query.js';
import {
    params,
    parseZodInput,
    createTask,
    assignTask,
    pageQuery,
    attentionQuery,
} from './routine.dto.js';
@Controller('spaces/:spaceId')
export class TaskController {
    constructor(
        private readonly creation: TaskCreation,
        private readonly queries: TaskQueries,
        private readonly attention: TaskAttentionQuery,
    ) {}
    @Get('routine-context')
    @Header('Cache-Control', 'no-store')
    context(@CurrentActor() a: RequestActor, @Param() p: unknown) {
        return this.queries.context(a.personId.value, params(p).spaceId);
    }
    @Post('tasks')
    @Header('Cache-Control', 'no-store')
    create(
        @CurrentActor() a: RequestActor,
        @Param() p: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        return this.creation.create(
            a.personId.value,
            params(p).spaceId,
            key,
            parseZodInput(createTask, body),
        );
    }
    @Post('tasks/:taskId/assignment')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    assign(
        @CurrentActor() a: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        const p = params(raw);
        return this.creation.assign(
            a.personId.value,
            p.spaceId,
            p.taskId!,
            key,
            parseZodInput(assignTask, body),
        );
    }
    @Get('tasks')
    @Header('Cache-Control', 'no-store')
    list(
        @CurrentActor() a: RequestActor,
        @Param() p: unknown,
        @Query() q: unknown,
    ) {
        return this.attention.list(
            a.personId.value,
            params(p).spaceId,
            parseZodInput(attentionQuery, q),
        );
    }
    @Get('tasks/:taskId')
    @Header('Cache-Control', 'no-store')
    detail(@CurrentActor() a: RequestActor, @Param() raw: unknown) {
        const p = params(raw);
        return this.queries.detail(a.personId.value, p.spaceId, p.taskId!);
    }
    @Get('tasks/:taskId/history')
    @Header('Cache-Control', 'no-store')
    history(
        @CurrentActor() a: RequestActor,
        @Param() raw: unknown,
        @Query() q: unknown,
    ) {
        const p = params(raw);
        return this.queries.history(
            a.personId.value,
            p.spaceId,
            p.taskId!,
            parseZodInput(pageQuery, q),
        );
    }
}
