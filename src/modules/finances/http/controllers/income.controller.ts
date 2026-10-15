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
import type { Response } from 'express';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import {
    CurrentActor,
    type RequestActor,
} from '../../../../shared/technical/http/current-actor.decorator.js';
import { IdempotencyKey } from '../../../../shared/technical/http/idempotency-key.decorator.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { RecordIncomeHandler } from '../../application/handlers/record-income.handler.js';
import { IncomeQueries } from '../../application/queries/income.queries.js';
import { SettlementRuleParamsDto } from '../dto/configure-default-settlement-rule.dto.js';
import {
    RecordIncomePipe,
    RecordIncomeReceiptPipe,
    type RecordIncomeDto,
    type RecordIncomeReceiptDto,
} from '../dto/record-income.dto.js';

class IncomeParamsDto extends SettlementRuleParamsDto {
    @IsUUID('all') commitmentId!: string;
}
class IncomeOptionsQueryDto {
    @IsOptional() @IsString() cursor?: string;
}
class IncomeListQueryDto extends IncomeOptionsQueryDto {
    @IsOptional() @IsEnum(['ALL', 'PENDING', 'RECEIVED']) status?:
        'ALL' | 'PENDING' | 'RECEIVED';
}

@Controller('spaces/:spaceId')
export class IncomeController {
    constructor(
        private readonly handler: RecordIncomeHandler,
        private readonly queries: IncomeQueries,
    ) {}

    @Get('income-options')
    @Header('Cache-Control', 'no-store')
    options(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @Query() query: IncomeOptionsQueryDto,
    ) {
        return this.queries.options(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            query.cursor,
        );
    }

    @Get('incomes')
    @Header('Cache-Control', 'no-store')
    list(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @Query() query: IncomeListQueryDto,
    ) {
        return this.queries.list(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            query.status ?? 'ALL',
            query.cursor,
        );
    }

    @Post('incomes')
    @Header('Cache-Control', 'no-store')
    async create(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @IdempotencyKey() key: string,
        @Body(RecordIncomePipe) input: RecordIncomeDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.execute({
            ...input,
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(params.spaceId.toLowerCase()),
            idempotencyKey: key,
        });
        response.setHeader(
            'Location',
            `/v2/spaces/${result.spaceId}/financial-commitments/${result.commitment.id}`,
        );
        if (result.replayed) response.status(200);
        return result;
    }

    @Get('financial-commitments/:commitmentId/receipt-options')
    @Header('Cache-Control', 'no-store')
    receiptOptions(
        @CurrentActor() actor: RequestActor,
        @Param() params: IncomeParamsDto,
        @Query() query: IncomeOptionsQueryDto,
    ) {
        return this.queries.receiptOptions(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            params.commitmentId.toLowerCase(),
            query.cursor,
        );
    }

    @Post('financial-commitments/:commitmentId/receipts')
    @Header('Cache-Control', 'no-store')
    async recordReceipt(
        @CurrentActor() actor: RequestActor,
        @Param() params: IncomeParamsDto,
        @IdempotencyKey() key: string,
        @Body(RecordIncomeReceiptPipe) input: RecordIncomeReceiptDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.recordReceipt({
            ...input,
            commitmentId: params.commitmentId.toLowerCase(),
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(params.spaceId.toLowerCase()),
            idempotencyKey: key,
        });
        response.setHeader(
            'Location',
            `/v2/spaces/${result.spaceId}/financial-commitments/${result.commitment.id}`,
        );
        if (result.replayed) response.status(200);
        return result;
    }
}
