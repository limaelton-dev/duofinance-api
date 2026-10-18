import { Module } from '@nestjs/common';
import { RoutineModule } from '../../modules/routine/routine.module.js';
import { SpacesModule } from '../../modules/spaces/spaces.module.js';
import { FinancesModule } from '../../modules/finances/finances.module.js';
import { ShoppingModule } from '../../modules/shopping/shopping.module.js';
import { TODAY_CLOCK } from './today.clock.js';
import { TodayController } from './today.controller.js';
import { TodayQuery } from './today.query.js';

@Module({
    imports: [SpacesModule, FinancesModule, RoutineModule, ShoppingModule],
    controllers: [TodayController],
    providers: [
        TodayQuery,
        { provide: TODAY_CLOCK, useValue: { now: () => new Date() } },
    ],
})
export class TodayModule {}
