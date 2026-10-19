import { FinancesModule } from './modules/finances/finances.module.js';
import { ClosureModule } from './composition/space-closure/closure.module.js';
import { RoutineModule } from './modules/routine/routine.module.js';
import { ShoppingModule } from './modules/shopping/shopping.module.js';
import { mapShoppingError } from './modules/shopping/http/shopping-error.mapper.js';
import { mapRoutineError } from './modules/routine/http/routine-error.mapper.js';
import { TodayModule } from './composition/today/today.module.js';
import { ShoppingTasksModule } from './composition/shopping-tasks/shopping-tasks.module.js';
import { mapFinancesError } from './modules/finances/http/filters/finances-error.mapper.js';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './shared/technical/database/database.module.js';
import { envSchema } from './config/env.schema.js';
import { SpacesModule } from './modules/spaces/spaces.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { APP_FILTER } from '@nestjs/core';
import { ApiExceptionFilter } from './shared/technical/http/api-exception.filter.js';
import { mapIdentityError } from './modules/identity/http/filters/identity-error.mapper.js';
import { mapSpacesError } from './modules/spaces/http/filters/spaces-error.mapper.js';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            cache: true,
            validationSchema: envSchema,
        }),
        DatabaseModule,
        SpacesModule,
        IdentityModule,
        FinancesModule,
        RoutineModule,
        ShoppingModule,
        TodayModule,
        ShoppingTasksModule,
        ClosureModule,
    ],
    controllers: [],
    providers: [
        {
            provide: APP_FILTER,
            useFactory: () =>
                new ApiExceptionFilter([
                    mapIdentityError,
                    mapSpacesError,
                    mapFinancesError,
                    mapRoutineError,
                    mapShoppingError,
                ]),
        },
    ],
})
export class AppModule {}
