import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../../shared/technical/database/database.module.js';
import { SpacesModule } from '../spaces/spaces.module.js';
import {
    ShoppingListOrmEntity,
    ShoppingItemOrmEntity,
    ShoppingHistoryOrmEntity,
    ShoppingReceiptOrmEntity,
    ShoppingAuditOrmEntity,
} from './infrastructure/shopping.orm-entity.js';
import { TypeOrmShoppingStore } from './infrastructure/typeorm-shopping-store.js';
import { SHOPPING_STORE } from './application/shopping-store.js';
import { SHOPPING_CLOCK } from './application/shopping-clock.js';
import { ShoppingCommands } from './application/shopping-commands.js';
import { ShoppingLists } from './application/shopping-lists.js';
import { ShoppingItems } from './application/shopping-items.js';
import { ShoppingQueries } from './application/shopping-queries.js';
import { ShoppingListController } from './http/shopping-list.controller.js';
import { ShoppingItemController } from './http/shopping-item.controller.js';

@Module({
    imports: [
        DatabaseModule,
        SpacesModule,
        TypeOrmModule.forFeature([
            ShoppingListOrmEntity,
            ShoppingItemOrmEntity,
            ShoppingHistoryOrmEntity,
            ShoppingReceiptOrmEntity,
            ShoppingAuditOrmEntity,
        ]),
    ],
    providers: [
        { provide: SHOPPING_STORE, useClass: TypeOrmShoppingStore },
        { provide: SHOPPING_CLOCK, useValue: { now: () => new Date() } },
        ShoppingCommands,
        ShoppingLists,
        ShoppingItems,
        ShoppingQueries,
    ],
    controllers: [ShoppingListController, ShoppingItemController],
})
export class ShoppingModule {}
