import { Module } from '@nestjs/common';
import { ShoppingModule } from '../../modules/shopping/shopping.module.js';
import { RoutineModule } from '../../modules/routine/routine.module.js';
import { ShoppingTasksController } from './shopping-tasks.controller.js';

@Module({
    imports: [ShoppingModule, RoutineModule],
    controllers: [ShoppingTasksController],
})
export class ShoppingTasksModule {}
