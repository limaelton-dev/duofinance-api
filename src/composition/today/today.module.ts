import { Module } from '@nestjs/common';
import { SpacesModule } from '../../modules/spaces/spaces.module.js';
import { FinancesModule } from '../../modules/finances/finances.module.js';
import { TODAY_CLOCK } from './today.clock.js';
import { TodayController } from './today.controller.js';
import { TodayQuery } from './today.query.js';

@Module({
    imports: [SpacesModule, FinancesModule],
    controllers: [TodayController],
    providers: [
        TodayQuery,
        { provide: TODAY_CLOCK, useValue: { now: () => new Date() } },
    ],
})
export class TodayModule {}
