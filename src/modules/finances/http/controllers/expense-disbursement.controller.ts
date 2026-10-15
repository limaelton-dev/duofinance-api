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
import { IsOptional, IsString, IsUUID } from 'class-validator';
import {
    CurrentActor,
    type RequestActor,
} from '../../../../shared/technical/http/current-actor.decorator.js';
import { IdempotencyKey } from '../../../../shared/technical/http/idempotency-key.decorator.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { RecordExpenseDisbursementHandler } from '../../application/handlers/record-expense-disbursement.handler.js';
import { GetExpenseDisbursementOptionsQuery } from '../../application/queries/expense-disbursement.queries.js';
import { SettlementRuleParamsDto } from '../dto/configure-default-settlement-rule.dto.js';
import {
    RecordExpenseDisbursementPipe,
    type RecordExpenseDisbursementDto,
} from '../dto/record-expense-disbursement.dto.js';
class DisbursementParamsDto extends SettlementRuleParamsDto {
    @IsUUID('all') commitmentId!: string;
}
class DisbursementQueryDto {
    @IsOptional() @IsString() cursor?: string;
}
@Controller('spaces/:spaceId/financial-commitments/:commitmentId')
export class ExpenseDisbursementController {
    constructor(
        private readonly handler: RecordExpenseDisbursementHandler,
        private readonly query: GetExpenseDisbursementOptionsQuery,
    ) {}
    @Get('disbursement-options')
    @Header('Cache-Control', 'no-store')
    options(
        @CurrentActor() actor: RequestActor,
        @Param() params: DisbursementParamsDto,
        @Query() query: DisbursementQueryDto,
    ) {
        return this.query.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            params.commitmentId.toLowerCase(),
            query.cursor,
        );
    }
    @Post('disbursements')
    @Header('Cache-Control', 'no-store')
    async create(
        @CurrentActor() actor: RequestActor,
        @Param() params: DisbursementParamsDto,
        @IdempotencyKey() key: string,
        @Body(RecordExpenseDisbursementPipe)
        input: RecordExpenseDisbursementDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.execute({
            ...input,
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(params.spaceId.toLowerCase()),
            commitmentId: params.commitmentId.toLowerCase(),
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
