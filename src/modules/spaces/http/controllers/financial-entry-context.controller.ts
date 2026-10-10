import { Controller, Get, Header, Inject, Param } from '@nestjs/common';
import {
    CurrentActor,
    type RequestActor,
} from '../../../../shared/technical/http/current-actor.decorator.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../application/ports/public/space-financial-context.port.js';
import { PersonId } from '../../domain/person/person-id.js';
import { SpaceId } from '../../domain/space/space-id.js';
import { SpaceParamsDto } from '../dto/space-params.dto.js';
@Controller('spaces/:spaceId/financial-entry-context')
export class FinancialEntryContextController {
    constructor(
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
    ) {}
    @Get() @Header('Cache-Control', 'no-store') get(
        @CurrentActor() actor: RequestActor,
        @Param() params: SpaceParamsDto,
    ) {
        return this.context.read(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
        );
    }
}
