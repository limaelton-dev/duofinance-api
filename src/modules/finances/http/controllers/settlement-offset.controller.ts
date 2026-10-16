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
import {
    CurrentActor,
    type RequestActor,
} from '../../../../shared/technical/http/current-actor.decorator.js';
import { IdempotencyKey } from '../../../../shared/technical/http/idempotency-key.decorator.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { RecordSettlementOffsetHandler } from '../../application/handlers/record-settlement-offset.handler.js';
import { SettlementOffsetQueries } from '../../application/queries/settlement-offset.queries.js';
import { SettlementRuleParamsDto } from '../dto/configure-default-settlement-rule.dto.js';
import {
    RecordSettlementOffsetPipe,
    type RecordSettlementOffsetDto,
    SettlementOffsetParamsDto,
    SettlementOffsetOptionsQueryDto,
    SettlementOffsetHistoryQueryDto,
} from '../dto/settlement-offset.dto.js';
@Controller('spaces/:spaceId/settlement-offsets')
export class SettlementOffsetController {
    constructor(
        private readonly handler: RecordSettlementOffsetHandler,
        private readonly queries: SettlementOffsetQueries,
    ) {}
    @Get('options')
    @Header('Cache-Control', 'no-store')
    options(
        @CurrentActor() actor: RequestActor,
        @Param() p: SettlementRuleParamsDto,
        @Query() q: SettlementOffsetOptionsQueryDto,
    ) {
        return this.queries.options(
            PersonId.from(actor.personId.value),
            SpaceId.from(p.spaceId.toLowerCase()),
            {
                cycleIds:
                    q.cycleIds?.split(',').map((id) => id.toLowerCase()) ?? [],
                obligationIds:
                    q.obligationIds?.split(',').map((id) => id.toLowerCase()) ??
                    [],
            },
            q.direction,
            q.cursor,
        );
    }
    @Get()
    @Header('Cache-Control', 'no-store')
    history(
        @CurrentActor() actor: RequestActor,
        @Param() p: SettlementRuleParamsDto,
        @Query() q: SettlementOffsetHistoryQueryDto,
    ) {
        return this.queries.history(
            PersonId.from(actor.personId.value),
            SpaceId.from(p.spaceId.toLowerCase()),
            q.cycleId?.toLowerCase() ?? null,
            q.obligationId?.toLowerCase() ?? null,
            q.cursor,
        );
    }
    @Get(':offsetId')
    @Header('Cache-Control', 'no-store')
    detail(
        @CurrentActor() actor: RequestActor,
        @Param() p: SettlementOffsetParamsDto,
    ) {
        return this.queries.detail(
            PersonId.from(actor.personId.value),
            SpaceId.from(p.spaceId.toLowerCase()),
            p.offsetId.toLowerCase(),
        );
    }
    @Post()
    @Header('Cache-Control', 'no-store')
    async create(
        @CurrentActor() actor: RequestActor,
        @Param() p: SettlementRuleParamsDto,
        @IdempotencyKey() idempotencyKey: string,
        @Body(RecordSettlementOffsetPipe) input: RecordSettlementOffsetDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.execute({
            ...input,
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(p.spaceId.toLowerCase()),
            idempotencyKey,
        });
        if (result.replayed) response.status(200);
        response.setHeader(
            'Location',
            `/v2/spaces/${result.spaceId}/settlement-offsets/${result.offset.id}`,
        );
        return result;
    }
}
