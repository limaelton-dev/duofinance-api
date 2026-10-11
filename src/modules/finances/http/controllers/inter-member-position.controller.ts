import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import {
    CurrentActor,
    type RequestActor,
} from '../../../../shared/technical/http/current-actor.decorator.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { GetInterMemberPositionQuery } from '../../application/queries/inter-member-position.query.js';
import { SettlementRuleParamsDto } from '../dto/configure-default-settlement-rule.dto.js';
import { InterMemberPositionQueryDto } from '../dto/inter-member-position-query.dto.js';
@Controller('spaces/:spaceId/inter-member-position')
export class InterMemberPositionController {
    constructor(private readonly position: GetInterMemberPositionQuery) {}
    @Get()
    @Header('Cache-Control', 'no-store')
    get(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @Query() query: InterMemberPositionQueryDto,
    ) {
        return this.position.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            query.direction,
            query.cursor,
        );
    }
}
