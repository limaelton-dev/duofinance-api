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
import { IsOptional, IsString } from 'class-validator';
import {
    CurrentActor,
    type RequestActor,
} from '../../../../shared/technical/http/current-actor.decorator.js';
import { IdempotencyKey } from '../../../../shared/technical/http/idempotency-key.decorator.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { CreatePlannedExpenseHandler } from '../../application/handlers/create-planned-expense.handler.js';
import { ListPlannedExpensesQuery } from '../../application/queries/planned-expense.queries.js';
import { SettlementRuleParamsDto } from '../dto/configure-default-settlement-rule.dto.js';
import {
    CreatePlannedExpensePipe,
    type CreatePlannedExpenseDto,
} from '../dto/create-planned-expense.dto.js';

class PlannedExpenseQueryDto {
    @IsString({ message: 'Informe o mês no formato YYYY-MM.' })
    month!: string;
    @IsOptional()
    @IsString({ message: 'Informe um cursor válido.' })
    cursor?: string;
}

@Controller('spaces/:spaceId/planned-expenses')
export class PlannedExpenseController {
    constructor(
        private readonly create: CreatePlannedExpenseHandler,
        private readonly list: ListPlannedExpensesQuery,
    ) {}

    @Post()
    @Header('Cache-Control', 'no-store')
    async post(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @IdempotencyKey() key: string,
        @Body(CreatePlannedExpensePipe) input: CreatePlannedExpenseDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.create.execute({
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

    @Get()
    @Header('Cache-Control', 'no-store')
    get(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @Query() query: PlannedExpenseQueryDto,
    ) {
        return this.list.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            query.month,
            query.cursor,
        );
    }
}
