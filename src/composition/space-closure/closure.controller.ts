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
} from '../../shared/technical/http/current-actor.decorator.js';
import { IdempotencyKey } from '../../shared/technical/http/idempotency-key.decorator.js';
import { ClosureService } from './closure.service.js';
import {
    closureParams,
    startClosure,
    cutoffDate,
    diagnosticPage,
    historyPage,
    parseZodInput,
    futureDestination,
} from './closure.dto.js';

@Controller('spaces/:spaceId/closure')
export class ClosureController {
    constructor(private readonly service: ClosureService) {}
    @Post()
    @Header('Cache-Control', 'no-store')
    start(
        @CurrentActor() actor: RequestActor,
        @Param() p: unknown,
        @IdempotencyKey() key: string,
        @Body() b: unknown,
    ) {
        return this.service.start(
            actor.personId.value,
            parseZodInput(closureParams, p).spaceId,
            key,
            parseZodInput(startClosure, b),
        );
    }
    @Post('cutoff-date')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    cutoff(
        @CurrentActor() actor: RequestActor,
        @Param() p: unknown,
        @IdempotencyKey() key: string,
        @Body() b: unknown,
    ) {
        return this.service.cutoff(
            actor.personId.value,
            parseZodInput(closureParams, p).spaceId,
            key,
            parseZodInput(cutoffDate, b),
        );
    }
    @Get()
    @Header('Cache-Control', 'no-store')
    read(@CurrentActor() actor: RequestActor, @Param() p: unknown) {
        return this.service.read(
            actor.personId.value,
            parseZodInput(closureParams, p).spaceId,
        );
    }
    @Post('future-destinations')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    destination(
        @CurrentActor() actor: RequestActor,
        @Param() p: unknown,
        @IdempotencyKey() key: string,
        @Body() b: unknown,
    ) {
        return this.service.destination(
            actor.personId.value,
            parseZodInput(closureParams, p).spaceId,
            key,
            parseZodInput(futureDestination, b),
        );
    }
    @Get('diagnostic')
    @Header('Cache-Control', 'no-store')
    diagnostic(
        @CurrentActor() actor: RequestActor,
        @Param() p: unknown,
        @Query() q: unknown,
    ) {
        return this.service.diagnostic(
            actor.personId.value,
            parseZodInput(closureParams, p).spaceId,
            parseZodInput(diagnosticPage, q),
        );
    }
    @Get('history')
    @Header('Cache-Control', 'no-store')
    history(
        @CurrentActor() actor: RequestActor,
        @Param() p: unknown,
        @Query() q: unknown,
    ) {
        return this.service.history(
            actor.personId.value,
            parseZodInput(closureParams, p).spaceId,
            parseZodInput(historyPage, q),
        );
    }
}
