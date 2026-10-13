import {
    Body,
    Controller,
    Get,
    Header,
    Param,
    Post,
    Query,
    Res,
} from '@nestjs/common';
import {
    IsIn,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
    MinLength,
} from 'class-validator';
import type { Response } from 'express';
import {
    CurrentActor,
    type RequestActor,
} from '../../../../shared/technical/http/current-actor.decorator.js';
import { IdempotencyKey } from '../../../../shared/technical/http/idempotency-key.decorator.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { RecordManualSettlementTransferHandler } from '../../application/handlers/record-manual-settlement-transfer.handler.js';
import {
    GetSettlementTransferOptionsQuery,
    GetSettlementTransferQuery,
    ListSettlementTransfersQuery,
} from '../../application/queries/settlement-transfer.queries.js';
import { SettlementRuleParamsDto } from '../dto/configure-default-settlement-rule.dto.js';
import {
    RecordManualSettlementTransferPipe,
    type RecordManualSettlementTransferDto,
} from '../dto/record-manual-settlement-transfer.dto.js';

class TransferParams extends SettlementRuleParamsDto {
    @IsUUID('all', { message: 'Informe uma transferência válida.' })
    transferId!: string;
}
class OptionsQuery {
    @IsOptional() @IsIn(['PAYABLE', 'RECEIVABLE']) direction?:
        'PAYABLE' | 'RECEIVABLE';
    @IsOptional() @IsUUID('all') cycleId?: string;
    @IsOptional() @IsString() @MinLength(1) @MaxLength(512) cursor?: string;
}
class HistoryQuery {
    @IsOptional() @IsUUID('all') cycleId?: string;
    @IsOptional() @IsUUID('all') obligationId?: string;
    @IsOptional() @IsString() @MinLength(1) @MaxLength(512) cursor?: string;
}
@Controller('spaces/:spaceId/settlement-transfers')
export class SettlementTransferController {
    constructor(
        private readonly record: RecordManualSettlementTransferHandler,
        private readonly options: GetSettlementTransferOptionsQuery,
        private readonly detail: GetSettlementTransferQuery,
        private readonly history: ListSettlementTransfersQuery,
    ) {}
    @Get('options')
    @Header('Cache-Control', 'no-store')
    getOptions(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @Query() query: OptionsQuery,
    ) {
        return this.options.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            query.direction,
            query.cycleId?.toLowerCase() ?? null,
            query.cursor,
        );
    }
    @Post()
    @Header('Cache-Control', 'no-store')
    async post(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @IdempotencyKey() key: string,
        @Body(RecordManualSettlementTransferPipe)
        input: RecordManualSettlementTransferDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.record.execute({
            ...input,
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(params.spaceId.toLowerCase()),
            idempotencyKey: key,
        });
        response.status(result.replayed ? 200 : 201);
        response.setHeader(
            'Location',
            `/v2/spaces/${result.spaceId}/settlement-transfers/${result.transfer.id}`,
        );
        return result;
    }
    @Get()
    @Header('Cache-Control', 'no-store')
    list(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @Query() query: HistoryQuery,
    ) {
        return this.history.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            query.cycleId?.toLowerCase() ?? null,
            query.obligationId?.toLowerCase() ?? null,
            query.cursor,
        );
    }
    @Get(':transferId')
    @Header('Cache-Control', 'no-store')
    getDetail(
        @CurrentActor() actor: RequestActor,
        @Param() params: TransferParams,
    ) {
        return this.detail.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            params.transferId.toLowerCase(),
        );
    }
}
