import {
    Body,
    Controller,
    Get,
    Header,
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
import { ReverseSettlementHandler } from '../../application/handlers/reverse-settlement.handler.js';
import { SettlementReversalOptionsQuery } from '../../application/queries/settlement-reversal-options.query.js';
import {
    ReverseSettlementPipe,
    type ReverseSettlementDto,
    TransferReversalParamsDto,
    OffsetReversalParamsDto,
} from '../dto/settlement-reversal.dto.js';
@Controller('spaces/:spaceId')
export class SettlementReversalController {
    constructor(
        private readonly handler: ReverseSettlementHandler,
        private readonly query: SettlementReversalOptionsQuery,
    ) {}
    @Get('settlement-transfers/:transferId/reversal-options')
    @Header('Cache-Control', 'no-store')
    transferOptions(
        @CurrentActor() actor: RequestActor,
        @Param() p: TransferReversalParamsDto,
    ) {
        return this.query.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(p.spaceId.toLowerCase()),
            'TRANSFER',
            p.transferId.toLowerCase(),
        );
    }
    @Get('settlement-offsets/:offsetId/reversal-options')
    @Header('Cache-Control', 'no-store')
    offsetOptions(
        @CurrentActor() actor: RequestActor,
        @Param() p: OffsetReversalParamsDto,
    ) {
        return this.query.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(p.spaceId.toLowerCase()),
            'OFFSET',
            p.offsetId.toLowerCase(),
        );
    }
    @Post('settlement-transfers/:transferId/reversals')
    @Header('Cache-Control', 'no-store')
    async transfer(
        @CurrentActor() actor: RequestActor,
        @Param() p: TransferReversalParamsDto,
        @IdempotencyKey() idempotencyKey: string,
        @Body(ReverseSettlementPipe) input: ReverseSettlementDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.execute({
            ...input,
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(p.spaceId.toLowerCase()),
            originalKind: 'TRANSFER',
            originalId: p.transferId.toLowerCase(),
            idempotencyKey,
        });
        if (result.replayed) response.status(200);
        return result;
    }
    @Post('settlement-offsets/:offsetId/reversals')
    @Header('Cache-Control', 'no-store')
    async offset(
        @CurrentActor() actor: RequestActor,
        @Param() p: OffsetReversalParamsDto,
        @IdempotencyKey() idempotencyKey: string,
        @Body(ReverseSettlementPipe) input: ReverseSettlementDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.execute({
            ...input,
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(p.spaceId.toLowerCase()),
            originalKind: 'OFFSET',
            originalId: p.offsetId.toLowerCase(),
            idempotencyKey,
        });
        if (result.replayed) response.status(200);
        return result;
    }
}
