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
import { RecordPersonalExpenseHandler } from '../../application/handlers/record-personal-expense.handler.js';
import {
    GetPersonalExpenseOptionsQuery,
    ListPersonalExpensesQuery,
} from '../../application/queries/personal-expense.queries.js';
import { SettlementRuleParamsDto } from '../dto/configure-default-settlement-rule.dto.js';
import {
    RecordPersonalExpensePipe,
    type RecordPersonalExpenseDto,
} from '../dto/record-personal-expense.dto.js';
class PersonalExpenseQueryDto {
    @IsOptional()
    @IsString({ message: 'Informe um cursor válido.' })
    cursor?: string;
}
@Controller('spaces/:spaceId')
export class PersonalExpenseController {
    constructor(
        private readonly handler: RecordPersonalExpenseHandler,
        private readonly options: GetPersonalExpenseOptionsQuery,
        private readonly list: ListPersonalExpensesQuery,
    ) {}
    @Get('personal-expense-options')
    @Header('Cache-Control', 'no-store')
    getOptions(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
    ) {
        return this.options.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
        );
    }
    @Get('personal-expenses')
    @Header('Cache-Control', 'no-store')
    getList(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @Query() query: PersonalExpenseQueryDto,
    ) {
        return this.list.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            query.cursor,
        );
    }
    @Post('personal-expenses')
    @Header('Cache-Control', 'no-store')
    async post(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @IdempotencyKey() key: string,
        @Body(RecordPersonalExpensePipe) input: RecordPersonalExpenseDto,
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
}
