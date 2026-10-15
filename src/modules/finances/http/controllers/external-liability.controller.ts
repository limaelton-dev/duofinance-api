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
import { SettleExternalLiabilityHandler } from '../../application/handlers/settle-external-liability.handler.js';
import { ExternalLiabilityQueries } from '../../application/queries/external-liability.queries.js';
import { SettlementRuleParamsDto } from '../dto/configure-default-settlement-rule.dto.js';
import {
    SettleExternalLiabilityPipe,
    type SettleExternalLiabilityDto,
} from '../dto/settle-external-liability.dto.js';
class LiabilityParamsDto extends SettlementRuleParamsDto {
    @IsUUID('all') commitmentId!: string;
    @IsUUID('all') externalLiabilityId!: string;
}
class LiabilityQueryDto {
    @IsOptional() @IsString() cursor?: string;
}
@Controller('spaces/:spaceId')
export class ExternalLiabilityController {
    constructor(
        private readonly handler: SettleExternalLiabilityHandler,
        private readonly query: ExternalLiabilityQueries,
    ) {}
    @Get('external-liabilities')
    @Header('Cache-Control', 'no-store')
    list(
        @CurrentActor() actor: RequestActor,
        @Param() params: SettlementRuleParamsDto,
        @Query() query: LiabilityQueryDto,
    ) {
        return this.query.list(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            query.cursor,
        );
    }
    @Get(
        'financial-commitments/:commitmentId/external-liabilities/:externalLiabilityId/settlement-options',
    )
    @Header('Cache-Control', 'no-store')
    options(
        @CurrentActor() actor: RequestActor,
        @Param() params: LiabilityParamsDto,
    ) {
        return this.query.options(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
            params.commitmentId.toLowerCase(),
            params.externalLiabilityId.toLowerCase(),
        );
    }
    @Post(
        'financial-commitments/:commitmentId/external-liabilities/:externalLiabilityId/settlements',
    )
    @Header('Cache-Control', 'no-store')
    async settle(
        @CurrentActor() actor: RequestActor,
        @Param() params: LiabilityParamsDto,
        @IdempotencyKey() key: string,
        @Body(SettleExternalLiabilityPipe) input: SettleExternalLiabilityDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.execute({
            ...input,
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(params.spaceId.toLowerCase()),
            commitmentId: params.commitmentId.toLowerCase(),
            externalLiabilityId: params.externalLiabilityId.toLowerCase(),
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
