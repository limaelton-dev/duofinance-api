import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import {
    CurrentActor,
    type RequestActor,
} from '../../../../shared/technical/http/current-actor.decorator.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import {
    GetSettlementCycleQuery,
    GetSettlementCyclesQuery,
    GetSelectedSettlementCyclesQuery,
} from '../../application/queries/settlement-cycle.queries.js';
import { SettlementRuleParamsDto } from '../dto/configure-default-settlement-rule.dto.js';
import {
    SettlementCycleParamsDto,
    SettlementCycleQueryDto,
    SettlementCyclesQueryDto,
    SelectedSettlementCyclesQueryDto,
} from '../dto/settlement-cycle-query.dto.js';
@Controller('spaces/:spaceId/settlement-cycles')
export class SettlementCycleController {
    constructor(
        private readonly cycles: GetSettlementCyclesQuery,
        private readonly cycle: GetSettlementCycleQuery,
        private readonly selected: GetSelectedSettlementCyclesQuery,
    ) {}
    @Get()
    @Header('Cache-Control', 'no-store')
    list(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @Query() query: SettlementCyclesQueryDto,
    ) {
        return this.cycles.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            query.view,
            query.cursor,
        );
    }
    @Get('summary')
    @Header('Cache-Control', 'no-store')
    summary(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @Query() query: SelectedSettlementCyclesQueryDto,
    ) {
        return this.selected.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            query.cycleIds.split(','),
            query.direction,
            query.cursor,
        );
    }
    @Get(':cycleId')
    @Header('Cache-Control', 'no-store')
    detail(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementCycleParamsDto,
        @Query() query: SettlementCycleQueryDto,
    ) {
        return this.cycle.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            params.cycleId.toLowerCase(),
            query.direction,
            query.cursor,
        );
    }
}
