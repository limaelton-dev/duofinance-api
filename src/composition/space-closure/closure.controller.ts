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
    planVersion,
    planConsent,
} from './closure.dto.js';

@Controller('spaces/:spaceId/closure')
export class ClosureController {
    constructor(private readonly service: ClosureService) {}
    @Get('final-summary')
    @Header('Cache-Control', 'no-store')
    finalSummary(@CurrentActor() actor: RequestActor, @Param() p: unknown) {
        return this.service.finalSummary(
            actor.personId.value,
            parseZodInput(closureParams, p).spaceId,
        );
    }
    @Post('confirmation')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    confirm(
        @CurrentActor() actor: RequestActor,
        @Param() p: unknown,
        @IdempotencyKey() key: string,
        @Body() b: unknown,
    ) {
        return this.service.confirm(
            actor.personId.value,
            parseZodInput(closureParams, p).spaceId,
            key,
            parseZodInput(planConsent, b),
        );
    }
    @Post('cancellation')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    cancel(
        @CurrentActor() actor: RequestActor,
        @Param() p: unknown,
        @IdempotencyKey() key: string,
        @Body() b: unknown,
    ) {
        return this.service.cancel(
            actor.personId.value,
            parseZodInput(closureParams, p).spaceId,
            key,
            parseZodInput(planVersion, b),
        );
    }
    @Get('financial-validation')
    @Header('Cache-Control', 'no-store')
    financialValidation(
        @CurrentActor() actor: RequestActor,
        @Param() p: unknown,
    ) {
        return this.service.financialValidation(
            actor.personId.value,
            parseZodInput(closureParams, p).spaceId,
        );
    }
    @Get('plan-review')
    @Header('Cache-Control', 'no-store')
    reviewPlan(@CurrentActor() actor: RequestActor, @Param() p: unknown) {
        return this.service.reviewPlan(
            actor.personId.value,
            parseZodInput(closureParams, p).spaceId,
        );
    }
    @Post('proposal')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    proposePlan(
        @CurrentActor() actor: RequestActor,
        @Param() p: unknown,
        @IdempotencyKey() key: string,
        @Body() b: unknown,
    ) {
        return this.service.decidePlan(
            actor.personId.value,
            parseZodInput(closureParams, p).spaceId,
            key,
            parseZodInput(planConsent, b),
            'PROPOSE',
        );
    }
    @Post('approval')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    approvePlan(
        @CurrentActor() actor: RequestActor,
        @Param() p: unknown,
        @IdempotencyKey() key: string,
        @Body() b: unknown,
    ) {
        return this.service.decidePlan(
            actor.personId.value,
            parseZodInput(closureParams, p).spaceId,
            key,
            parseZodInput(planConsent, b),
            'APPROVE',
        );
    }
    @Post('rejection')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    rejectPlan(
        @CurrentActor() actor: RequestActor,
        @Param() p: unknown,
        @IdempotencyKey() key: string,
        @Body() b: unknown,
    ) {
        return this.service.decidePlan(
            actor.personId.value,
            parseZodInput(closureParams, p).spaceId,
            key,
            parseZodInput(planVersion, b),
            'REJECT',
        );
    }
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
