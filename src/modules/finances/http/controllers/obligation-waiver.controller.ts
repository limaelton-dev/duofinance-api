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
import { WaiveObligationHandler } from '../../application/handlers/waive-obligation.handler.js';
import { ObligationWaiverQueries } from '../../application/queries/obligation-waiver.queries.js';
import {
    WaiveObligationPipe,
    type WaiveObligationDto,
    ObligationWaiverParamsDto,
    WaiverDetailParamsDto,
    WaiverHistoryQueryDto,
} from '../dto/obligation-waiver.dto.js';
@Controller('spaces/:spaceId/inter-member-obligations/:obligationId')
export class ObligationWaiverController {
    constructor(
        private readonly handler: WaiveObligationHandler,
        private readonly queries: ObligationWaiverQueries,
    ) {}
    @Get('waiver-options')
    @Header('Cache-Control', 'no-store')
    options(
        @CurrentActor() actor: RequestActor,
        @Param() p: ObligationWaiverParamsDto,
    ) {
        return this.queries.options(
            PersonId.from(actor.personId.value),
            SpaceId.from(p.spaceId.toLowerCase()),
            p.obligationId.toLowerCase(),
        );
    }
    @Get('waivers')
    @Header('Cache-Control', 'no-store')
    history(
        @CurrentActor() actor: RequestActor,
        @Param() p: ObligationWaiverParamsDto,
        @Query() q: WaiverHistoryQueryDto,
    ) {
        return this.queries.history(
            PersonId.from(actor.personId.value),
            SpaceId.from(p.spaceId.toLowerCase()),
            p.obligationId.toLowerCase(),
            q.cursor,
        );
    }
    @Get('waivers/:waiverId')
    @Header('Cache-Control', 'no-store')
    detail(
        @CurrentActor() actor: RequestActor,
        @Param() p: WaiverDetailParamsDto,
    ) {
        return this.queries.detail(
            PersonId.from(actor.personId.value),
            SpaceId.from(p.spaceId.toLowerCase()),
            p.obligationId.toLowerCase(),
            p.waiverId.toLowerCase(),
        );
    }
    @Post('waivers')
    @Header('Cache-Control', 'no-store')
    async create(
        @CurrentActor() actor: RequestActor,
        @Param() p: ObligationWaiverParamsDto,
        @IdempotencyKey() idempotencyKey: string,
        @Body(WaiveObligationPipe) input: WaiveObligationDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.execute({
            ...input,
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(p.spaceId.toLowerCase()),
            obligationId: p.obligationId.toLowerCase(),
            idempotencyKey,
        });
        if (result.replayed) response.status(200);
        response.setHeader(
            'Location',
            `/v2/spaces/${result.spaceId}/inter-member-obligations/${result.obligation.id}/waivers/${result.waiver.id}`,
        );
        return result;
    }
}
