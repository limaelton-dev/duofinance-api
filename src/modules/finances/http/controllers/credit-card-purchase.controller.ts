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
import { RecordCreditCardPurchaseHandler } from '../../application/handlers/record-credit-card-purchase.handler.js';
import { CreditCardPurchaseQueries } from '../../application/queries/credit-card-purchase.queries.js';
import { SettlementRuleParamsDto } from '../dto/configure-default-settlement-rule.dto.js';
import {
    RecordCreditCardPurchasePipe,
    RecordExternalLiabilityPipe,
    type RecordCreditCardPurchaseDto,
    type RecordExternalLiabilityDto,
} from '../dto/record-credit-card-purchase.dto.js';
class ExternalLiabilityParamsDto extends SettlementRuleParamsDto {
    @IsUUID('all') commitmentId!: string;
}
class CreditCardQueryDto {
    @IsOptional() @IsString() cursor?: string;
}
@Controller('spaces/:spaceId')
export class CreditCardPurchaseController {
    constructor(
        private readonly handler: RecordCreditCardPurchaseHandler,
        private readonly queries: CreditCardPurchaseQueries,
    ) {}
    @Get('credit-card-purchase-options')
    @Header('Cache-Control', 'no-store')
    options(
        @CurrentActor() actor: RequestActor,
        @Param() p: SettlementRuleParamsDto,
        @Query() q: CreditCardQueryDto,
    ) {
        return this.queries.options(
            PersonId.from(actor.personId.value),
            SpaceId.from(p.spaceId.toLowerCase()),
            q.cursor,
        );
    }
    @Get('financial-commitments/:commitmentId/external-liability-options')
    @Header('Cache-Control', 'no-store')
    externalOptions(
        @CurrentActor() actor: RequestActor,
        @Param() p: ExternalLiabilityParamsDto,
        @Query() q: CreditCardQueryDto,
    ) {
        return this.queries.externalOptions(
            PersonId.from(actor.personId.value),
            SpaceId.from(p.spaceId.toLowerCase()),
            p.commitmentId.toLowerCase(),
            q.cursor,
        );
    }
    @Post('credit-card-purchases')
    @Header('Cache-Control', 'no-store')
    async create(
        @CurrentActor() actor: RequestActor,
        @Param() p: SettlementRuleParamsDto,
        @IdempotencyKey() key: string,
        @Body(RecordCreditCardPurchasePipe) input: RecordCreditCardPurchaseDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.execute({
            ...input,
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(p.spaceId.toLowerCase()),
            idempotencyKey: key,
        });
        response.setHeader(
            'Location',
            `/v2/spaces/${result.spaceId}/financial-commitments/${result.commitment.id}`,
        );
        if (result.replayed) response.status(200);
        return result;
    }
    @Post('financial-commitments/:commitmentId/external-liabilities')
    @Header('Cache-Control', 'no-store')
    async add(
        @CurrentActor() actor: RequestActor,
        @Param() p: ExternalLiabilityParamsDto,
        @IdempotencyKey() key: string,
        @Body(RecordExternalLiabilityPipe) input: RecordExternalLiabilityDto,
        @Res({ passthrough: true }) response: Response,
    ) {
        const result = await this.handler.execute({
            ...input,
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(p.spaceId.toLowerCase()),
            commitmentId: p.commitmentId.toLowerCase(),
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
