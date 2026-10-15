import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import {
    CurrentActor,
    type RequestActor,
} from '../../../../shared/technical/http/current-actor.decorator.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancialReviewQueries } from '../../application/queries/financial-review.queries.js';
import { SettlementRuleParamsDto } from '../dto/configure-default-settlement-rule.dto.js';
import {
    FinancialForecastQueryDto,
    FinancialOverviewQueryDto,
    FinancialTimelineQueryDto,
} from '../dto/financial-review-query.dto.js';
@Controller('spaces/:spaceId')
export class FinancialReviewController {
    constructor(private readonly queries: FinancialReviewQueries) {}
    @Get('financial-timeline')
    @Header('Cache-Control', 'no-store')
    timeline(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @Query() query: FinancialTimelineQueryDto,
    ) {
        return this.queries.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            'timeline',
            query.month,
            query.memberId,
            query.cursor,
            query.view,
        );
    }
    @Get('financial-forecast')
    @Header('Cache-Control', 'no-store')
    forecast(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @Query() query: FinancialForecastQueryDto,
    ) {
        return this.queries.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            'forecast',
            query.month,
            query.memberId,
            query.cursor,
        );
    }
    @Get('financial-overview')
    @Header('Cache-Control', 'no-store')
    overview(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @Query() query: FinancialOverviewQueryDto,
    ) {
        return this.queries.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            'overview',
            query.month,
            query.memberId,
        );
    }
}
