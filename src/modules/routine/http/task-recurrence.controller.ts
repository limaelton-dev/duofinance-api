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
import { TaskRecurrenceCommands } from '../application/task-recurrence-commands.js';
import { TaskOccurrenceCommands } from '../application/task-occurrence-commands.js';
import { TaskRecurrenceQueries } from '../application/task-recurrence-queries.js';
import { parseZodInput, pageQuery } from './routine.dto.js';
import {
    recurrenceParams,
    createTaskRecurrence,
    occurrencePage,
    occurrenceInput,
    cancelRecurrence,
} from './task-recurrence.dto.js';
@Controller('spaces/:spaceId/task-recurrences')
export class TaskRecurrenceController {
    constructor(
        private readonly commands: TaskRecurrenceCommands,
        private readonly occurrences: TaskOccurrenceCommands,
        private readonly queries: TaskRecurrenceQueries,
    ) {}
    @Post()
    @Header('Cache-Control', 'no-store')
    create(
        @CurrentActor() a: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        const p = parseZodInput(recurrenceParams, raw);
        return this.commands.create(
            a.personId.value,
            p.spaceId,
            key,
            parseZodInput(createTaskRecurrence, body),
        );
    }
    @Get()
    @Header('Cache-Control', 'no-store')
    list(
        @CurrentActor() a: RequestActor,
        @Param() raw: unknown,
        @Query() q: unknown,
    ) {
        const p = parseZodInput(recurrenceParams, raw);
        return this.queries.list(
            a.personId.value,
            p.spaceId,
            parseZodInput(pageQuery, q),
        );
    }
    @Get(':recurrenceId')
    @Header('Cache-Control', 'no-store')
    detail(@CurrentActor() a: RequestActor, @Param() raw: unknown) {
        const p = parseZodInput(recurrenceParams, raw);
        return this.queries.detail(
            a.personId.value,
            p.spaceId,
            p.recurrenceId!,
        );
    }
    @Get(':recurrenceId/history')
    @Header('Cache-Control', 'no-store')
    history(
        @CurrentActor() a: RequestActor,
        @Param() raw: unknown,
        @Query() q: unknown,
    ) {
        const p = parseZodInput(recurrenceParams, raw);
        return this.queries.history(
            a.personId.value,
            p.spaceId,
            p.recurrenceId!,
            parseZodInput(pageQuery, q),
        );
    }
    @Get(':recurrenceId/occurrences')
    @Header('Cache-Control', 'no-store')
    occurrenceList(
        @CurrentActor() a: RequestActor,
        @Param() raw: unknown,
        @Query() q: unknown,
    ) {
        const p = parseZodInput(recurrenceParams, raw);
        return this.queries.occurrences(
            a.personId.value,
            p.spaceId,
            p.recurrenceId!,
            parseZodInput(occurrencePage, q),
        );
    }
    @Get(':recurrenceId/occurrences/:scheduledDate')
    @Header('Cache-Control', 'no-store')
    occurrenceDetail(@CurrentActor() a: RequestActor, @Param() raw: unknown) {
        const p = parseZodInput(recurrenceParams, raw);
        return this.queries.occurrenceDetail(
            a.personId.value,
            p.spaceId,
            p.recurrenceId!,
            p.scheduledDate!,
        );
    }
    @Get(':recurrenceId/occurrences/:scheduledDate/history')
    @Header('Cache-Control', 'no-store')
    occurrenceHistory(
        @CurrentActor() a: RequestActor,
        @Param() raw: unknown,
        @Query() q: unknown,
    ) {
        const p = parseZodInput(recurrenceParams, raw);
        return this.queries.history(
            a.personId.value,
            p.spaceId,
            p.recurrenceId!,
            parseZodInput(pageQuery, q),
            p.scheduledDate!,
        );
    }
    @Post(':recurrenceId/cancel')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    cancel(
        @CurrentActor() a: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        const p = parseZodInput(recurrenceParams, raw);
        return this.commands.cancel(
            a.personId.value,
            p.spaceId,
            p.recurrenceId!,
            key,
            parseZodInput(cancelRecurrence, body),
        );
    }
    @Post(':recurrenceId/occurrences/:scheduledDate/complete')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    complete(
        @CurrentActor() a: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        return this.act('COMPLETE', a, raw, key, body);
    }
    @Post(':recurrenceId/occurrences/:scheduledDate/reopen')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    reopen(
        @CurrentActor() a: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        return this.act('REOPEN', a, raw, key, body);
    }
    @Post(':recurrenceId/occurrences/:scheduledDate/skip')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    skip(
        @CurrentActor() a: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        return this.act('SKIP', a, raw, key, body);
    }
    private act(
        action: 'COMPLETE' | 'REOPEN' | 'SKIP',
        a: RequestActor,
        raw: unknown,
        key: string,
        body: unknown,
    ) {
        const p = parseZodInput(recurrenceParams, raw);
        return this.occurrences.execute(
            action,
            a.personId.value,
            p.spaceId,
            p.recurrenceId!,
            p.scheduledDate!,
            key,
            parseZodInput(occurrenceInput, body),
        );
    }
}
