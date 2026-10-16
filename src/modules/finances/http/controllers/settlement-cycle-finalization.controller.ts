import {
    Body,
    Controller,
    Header,
    HttpCode,
    Param,
    Post,
} from '@nestjs/common';
import {
    CurrentActor,
    type RequestActor,
} from '../../../../shared/technical/http/current-actor.decorator.js';
import { IdempotencyKey } from '../../../../shared/technical/http/idempotency-key.decorator.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinalizeSettlementCycleHandler } from '../../application/handlers/finalize-settlement-cycle.handler.js';
import { SettlementCycleParamsDto } from '../dto/settlement-cycle-query.dto.js';
import {
    FinalizeSettlementCyclePipe,
    type FinalizeSettlementCycleDto,
} from '../dto/finalize-settlement-cycle.dto.js';
@Controller('spaces/:spaceId/settlement-cycles/:cycleId/finalize')
export class SettlementCycleFinalizationController {
    constructor(private readonly handler: FinalizeSettlementCycleHandler) {}
    @Post()
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    finalize(
        @CurrentActor() actor: RequestActor,
        @Param() p: SettlementCycleParamsDto,
        @IdempotencyKey() idempotencyKey: string,
        @Body(FinalizeSettlementCyclePipe) input: FinalizeSettlementCycleDto,
    ) {
        return this.handler.execute({
            ...input,
            actorId: PersonId.from(actor.personId.value),
            spaceId: SpaceId.from(p.spaceId.toLowerCase()),
            cycleId: p.cycleId.toLowerCase(),
            idempotencyKey,
        });
    }
}
