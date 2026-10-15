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
import { IsUUID, IsOptional, IsString } from 'class-validator';
import {
    CurrentActor,
    type RequestActor,
} from '../../../../shared/technical/http/current-actor.decorator.js';
import { IdempotencyKey } from '../../../../shared/technical/http/idempotency-key.decorator.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { RecordSharedCashExpenseHandler } from '../../application/handlers/record-shared-cash-expense.handler.js';
import {
    GetSharedCashExpenseOptionsQuery,
    GetFinancialCommitmentQuery,
} from '../../application/queries/shared-cash-expense.queries.js';
import { SettlementRuleParamsDto } from '../dto/configure-default-settlement-rule.dto.js';
import {
    RecordSharedCashExpensePipe,
    type RecordSharedCashExpenseDto,
} from '../dto/record-shared-cash-expense.dto.js';
class FinancialCommitmentParamsDto extends SettlementRuleParamsDto {
    @IsUUID('all', { message: 'Informe uma despesa válida.' })
    commitmentId!: string;
}
class OptionsQueryDto {
    @IsOptional()
    @IsString({ message: 'Informe um cursor válido.' })
    cursor?: string;
}
@Controller('spaces/:spaceId')
export class SharedCashExpenseController {
    constructor(
        private readonly handler: RecordSharedCashExpenseHandler,
        private readonly options: GetSharedCashExpenseOptionsQuery,
        private readonly detail: GetFinancialCommitmentQuery,
    ) {}
    @Get('shared-cash-expense-options')
    @Header('Cache-Control', 'no-store')
    getOptions(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @Query() query: OptionsQueryDto,
    ) {
        return this.options.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            query.cursor,
        );
    }
    @Post('shared-cash-expenses')
    @Header('Cache-Control', 'no-store')
    async post(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @IdempotencyKey() key: string,
        @Body(RecordSharedCashExpensePipe) input: RecordSharedCashExpenseDto,
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
    @Get('financial-commitments/:commitmentId')
    @Header('Cache-Control', 'no-store')
    getDetail(
        @CurrentActor() actor: RequestActor,
        @Param() params: FinancialCommitmentParamsDto,
    ) {
        return this.detail.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            params.commitmentId.toLowerCase(),
        );
    }
}
