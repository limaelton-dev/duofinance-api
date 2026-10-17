import {
    Body,
    Controller,
    Get,
    Header,
    HttpCode,
    Param,
    Post,
    Query,
    Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
    CurrentActor,
    type RequestActor,
} from '../../../../shared/technical/http/current-actor.decorator.js';
import { IdempotencyKey } from '../../../../shared/technical/http/idempotency-key.decorator.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancialFulfillmentReversals } from '../../application/handlers/financial-fulfillment-reversals.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import {
    FinancialReversalPipe,
    FinancialReversalListPipe,
    type FinancialReversalDto,
    type FinancialReversalListDto,
} from '../dto/financial-reversal.dto.js';
import { uuid } from '../dto/record-shared-cash-expense.dto.js';

@Controller('spaces/:spaceId/financial-commitments/:commitmentId')
export class FinancialReversalController {
    constructor(private readonly reversals: FinancialFulfillmentReversals) {}
    private ids(actor: RequestActor, space: string, id: string) {
        const parsed = uuid.safeParse(id);
        if (!parsed.success)
            throw new FinancesError('VALIDATION_ERROR', ['commitmentId']);
        return {
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(space.toLowerCase()),
            commitmentId: parsed.data,
        };
    }
    @Post('reversal-preview')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    preview(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') space: string,
        @Param('commitmentId') id: string,
        @Body(FinancialReversalPipe) input: FinancialReversalDto,
    ) {
        const ids = this.ids(actor, space, id);
        return this.reversals.preview(
            ids.actorId,
            ids.spaceId,
            ids.commitmentId,
            input,
        );
    }
    @Post('reversals')
    @Header('Cache-Control', 'no-store')
    async reverse(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') space: string,
        @Param('commitmentId') id: string,
        @IdempotencyKey() key: string,
        @Body(FinancialReversalPipe) input: FinancialReversalDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.reversals.confirm(
            { ...this.ids(actor, space, id), ...input, idempotencyKey: key },
            input,
        );
        if (result.replayed) response.status(200);
        return result;
    }
    @Get('reversals')
    @Header('Cache-Control', 'no-store')
    list(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') space: string,
        @Param('commitmentId') id: string,
        @Query(FinancialReversalListPipe) input: FinancialReversalListDto,
    ) {
        const ids = this.ids(actor, space, id);
        return this.reversals.list(
            ids.actorId,
            ids.spaceId,
            ids.commitmentId,
            input,
        );
    }
}
