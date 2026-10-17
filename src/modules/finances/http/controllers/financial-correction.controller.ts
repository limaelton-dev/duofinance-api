import {
    Body,
    Controller,
    Header,
    HttpCode,
    Param,
    Post,
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
import { FinancialCommitmentAdjustments } from '../../application/handlers/financial-commitment-adjustments.js';
import { FinancialCommitmentCancellations } from '../../application/handlers/financial-commitment-cancellations.js';
import { FinancialCommitmentChangesHandler } from '../../application/handlers/financial-commitment-changes.handler.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import {
    AdjustmentPipe,
    CancellationPipe,
    type AdjustmentDto,
    type CancellationDto,
} from '../dto/financial-correction.dto.js';
import { uuid } from '../dto/record-shared-cash-expense.dto.js';

@Controller('spaces/:spaceId/financial-commitments/:commitmentId')
export class FinancialCorrectionController {
    constructor(
        private readonly adjustments: FinancialCommitmentAdjustments,
        private readonly cancellations: FinancialCommitmentCancellations,
        private readonly changes: FinancialCommitmentChangesHandler,
    ) {}
    private ids(actor: RequestActor, spaceId: string, id: string) {
        const parsed = uuid.safeParse(id);
        if (!parsed.success)
            throw new FinancesError('VALIDATION_ERROR', ['commitmentId']);
        return {
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(spaceId.toLowerCase()),
            commitmentId: parsed.data,
        };
    }
    @Post('adjustment-preview')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    preview(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') space: string,
        @Param('commitmentId') id: string,
        @Body(AdjustmentPipe) input: AdjustmentDto,
    ) {
        const ids = this.ids(actor, space, id);
        return this.adjustments.preview(
            ids.actorId,
            ids.spaceId,
            ids.commitmentId,
            input,
        );
    }
    @Post('adjustments')
    @Header('Cache-Control', 'no-store')
    async adjust(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') space: string,
        @Param('commitmentId') id: string,
        @IdempotencyKey() key: string,
        @Body(AdjustmentPipe) input: AdjustmentDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.changes.adjust(
            { ...this.ids(actor, space, id), ...input, idempotencyKey: key },
            input,
        );
        if (result.replayed) response.status(200);
        return result;
    }
    @Post('cancellation-preview')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    cancellationPreview(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') space: string,
        @Param('commitmentId') id: string,
        @Body(CancellationPipe) input: CancellationDto,
    ) {
        const ids = this.ids(actor, space, id);
        return this.cancellations.preview(
            ids.actorId,
            ids.spaceId,
            ids.commitmentId,
            input,
        );
    }
    @Post('cancellations')
    @Header('Cache-Control', 'no-store')
    async cancel(
        @CurrentActor() actor: RequestActor,
        @Param('spaceId') space: string,
        @Param('commitmentId') id: string,
        @IdempotencyKey() key: string,
        @Body(CancellationPipe) input: CancellationDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.cancellations.confirm(
            { ...this.ids(actor, space, id), ...input, idempotencyKey: key },
            input,
        );
        if (result.replayed) response.status(200);
        return result;
    }
}
