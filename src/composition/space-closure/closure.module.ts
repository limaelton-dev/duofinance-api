import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/technical/database/database.module.js';
import { SpacesModule } from '../../modules/spaces/spaces.module.js';
import { FinancesModule } from '../../modules/finances/finances.module.js';
import { RoutineModule } from '../../modules/routine/routine.module.js';
import { ShoppingModule } from '../../modules/shopping/shopping.module.js';
import { ClosureController } from './closure.controller.js';
import { ClosureService } from './closure.service.js';
import { CLOSURE_CLOCK } from './closure.clock.js';
@Module({
    imports: [
        DatabaseModule,
        SpacesModule,
        FinancesModule,
        RoutineModule,
        ShoppingModule,
    ],
    controllers: [ClosureController],
    providers: [
        ClosureService,
        { provide: CLOSURE_CLOCK, useValue: { now: () => new Date() } },
    ],
})
export class ClosureModule {}
