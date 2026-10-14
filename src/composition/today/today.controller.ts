import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import {
    CurrentActor,
    type RequestActor,
} from '../../shared/technical/http/current-actor.decorator.js';
import { PersonId } from '../../modules/spaces/domain/person/person-id.js';
import { SpaceId } from '../../modules/spaces/domain/space/space-id.js';
import { TodayQuery } from './today.query.js';

export class TodayParamsDto {
    @IsUUID('all', { message: 'Informe um espaço válido.' }) spaceId!: string;
}

export class TodayFiltersDto {}

@Controller('spaces/:spaceId/today')
export class TodayController {
    constructor(private readonly today: TodayQuery) {}

    @Get()
    @Header('Cache-Control', 'no-store')
    get(
        @CurrentActor() actor: RequestActor,
        @Param() params: TodayParamsDto,
        @Query() _query: TodayFiltersDto,
    ) {
        return this.today.execute(
            PersonId.from(actor.personId.value),
            SpaceId.from(params.spaceId.toLowerCase()),
        );
    }
}
