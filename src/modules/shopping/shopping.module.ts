import { Module } from '@nestjs/common';
import { SHOPPING_CLOSURE_PORT } from './application/ports/public/shopping-closure.port.js';
import { TypeOrmShoppingClosure } from './infrastructure/typeorm-shopping-closure.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../../shared/technical/database/database.module.js';
import { SpacesModule } from '../spaces/spaces.module.js';
import {
    ShoppingListOrmEntity,
    ShoppingItemOrmEntity,
    PurchaseRecordOrmEntity,
    PurchaseCorrectionOrmEntity,
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
import { ShoppingPurchases } from './application/shopping-purchases.js';
import { ShoppingCorrections } from './application/shopping-corrections.js';
import { ShoppingQueries } from './application/shopping-queries.js';
import { ShoppingListController } from './http/shopping-list.controller.js';
import { ShoppingItemController } from './http/shopping-item.controller.js';
import { ShoppingPurchaseController } from './http/shopping-purchase.controller.js';
import { SHOPPING_LISTS_PORT } from './application/ports/public/shopping-lists.port.js';
import { ShoppingPublicLists } from './application/shopping-public-lists.js';
import { SHOPPING_ATTENTION_QUERY_PORT } from './application/ports/public/shopping-attention-query.port.js';
import { ShoppingAttentionQuery } from './application/shopping-attention-query.js';

@Module({
    imports: [
        DatabaseModule,
        SpacesModule,
        TypeOrmModule.forFeature([
            ShoppingListOrmEntity,
            ShoppingItemOrmEntity,
            PurchaseRecordOrmEntity,
            PurchaseCorrectionOrmEntity,
            ShoppingHistoryOrmEntity,
            ShoppingReceiptOrmEntity,
            ShoppingAuditOrmEntity,
        ]),
    ],
    providers: [
        { provide: SHOPPING_CLOSURE_PORT, useClass: TypeOrmShoppingClosure },
        { provide: SHOPPING_STORE, useClass: TypeOrmShoppingStore },
        { provide: SHOPPING_CLOCK, useValue: { now: () => new Date() } },
        ShoppingCommands,
        ShoppingLists,
        ShoppingItems,
        ShoppingPurchases,
        ShoppingCorrections,
        ShoppingQueries,
        { provide: SHOPPING_LISTS_PORT, useClass: ShoppingPublicLists },
        {
            provide: SHOPPING_ATTENTION_QUERY_PORT,
            useClass: ShoppingAttentionQuery,
        },
    ],
    controllers: [
        ShoppingListController,
        ShoppingItemController,
        ShoppingPurchaseController,
    ],
    exports: [
        SHOPPING_LISTS_PORT,
        SHOPPING_ATTENTION_QUERY_PORT,
        SHOPPING_CLOSURE_PORT,
    ],
})
export class ShoppingModule {}
