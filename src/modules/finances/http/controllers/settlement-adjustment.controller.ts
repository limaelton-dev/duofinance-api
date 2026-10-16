import {
    Body,
    Controller,
    Get,
    Header,
    HttpCode,
    Param,
    Post,
    Put,
    Query,
} from '@nestjs/common';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import {
    CurrentActor,
    type RequestActor,
} from '../../../../shared/technical/http/current-actor.decorator.js';
import { IdempotencyKey } from '../../../../shared/technical/http/idempotency-key.decorator.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { SettlementAdjustmentHandler } from '../../application/handlers/settlement-adjustment.handler.js';
import { SettlementAssignmentOptionsQuery } from '../../application/queries/settlement-assignment-options.query.js';
import { SettlementRuleParamsDto } from '../dto/configure-default-settlement-rule.dto.js';
import {
    ConfigureCommitmentSettlementRulePipe,
    MoveObligationPipe,
    type ConfigureCommitmentSettlementRuleDto,
    type MoveObligationDto,
} from '../dto/settlement-adjustment.dto.js';
class CommitmentParams extends SettlementRuleParamsDto {
    @IsUUID('all', { message: 'Informe um compromisso válido.' })
    commitmentId!: string;
}
class ObligationParams extends SettlementRuleParamsDto {
    @IsUUID('all', { message: 'Informe uma pendência válida.' })
    obligationId!: string;
}
class OptionsQuery {
    @IsOptional() @IsString() cursor?: string;
}
@Controller('spaces/:spaceId')
export class SettlementAdjustmentController {
    constructor(
        private readonly handler: SettlementAdjustmentHandler,
        private readonly query: SettlementAssignmentOptionsQuery,
    ) {}
    @Put('financial-commitments/:commitmentId/settlement-rule')
    @Header('Cache-Control', 'no-store')
    configure(
        @CurrentActor() actor: RequestActor,
        @Param() p: CommitmentParams,
        @IdempotencyKey() idempotencyKey: string,
        @Body(ConfigureCommitmentSettlementRulePipe)
        input: ConfigureCommitmentSettlementRuleDto,
    ) {
        return this.handler.configure({
            ...input,
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(p.spaceId.toLowerCase()),
            commitmentId: p.commitmentId.toLowerCase(),
            idempotencyKey,
        });
    }
    @Get('inter-member-obligations/:obligationId/settlement-options')
    @Header('Cache-Control', 'no-store')
    options(
        @CurrentActor() actor: RequestActor,
        @Param() p: ObligationParams,
        @Query() query: OptionsQuery,
    ) {
        return this.query.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(p.spaceId.toLowerCase()),
            p.obligationId.toLowerCase(),
            query.cursor,
        );
    }
    @Post('inter-member-obligations/:obligationId/settlement-assignment')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    move(
        @CurrentActor() actor: RequestActor,
        @Param() p: ObligationParams,
        @IdempotencyKey() idempotencyKey: string,
        @Body(MoveObligationPipe) input: MoveObligationDto,
    ) {
        return this.handler.move({
            ...input,
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(p.spaceId.toLowerCase()),
            obligationId: p.obligationId.toLowerCase(),
            idempotencyKey,
        });
    }
}
