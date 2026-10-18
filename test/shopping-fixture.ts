import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../dist/app.module.js';
import { configureApp } from '../dist/configure-app.js';
import { SHOPPING_CLOCK } from '../dist/modules/shopping/application/shopping-clock.js';
import { ROUTINE_CLOCK } from '../dist/modules/routine/application/routine-clock.js';
import { TODAY_CLOCK } from '../dist/composition/today/today.clock.js';

export { prepareRoutineDatabase as prepareShoppingDatabase } from './routine-fixture.js';

export async function shoppingApp(clock: () => Date) {
    const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SHOPPING_CLOCK)
        .useValue({ now: clock })
        .overrideProvider(ROUTINE_CLOCK)
        .useValue({ now: clock })
        .overrideProvider(TODAY_CLOCK)
        .useValue({ now: clock })
        .compile();
    const app: INestApplication<Server> = module.createNestApplication();
    configureApp(app);
    await app.init();
    const db = app.get(DataSource);
    await db.query('TRUNCATE persons CASCADE');
    return { app, db };
}

export async function shoppingSnapshot(db: DataSource) {
    const tables: { tablename: string }[] = await db.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'shopping_%' ORDER BY tablename",
    );
    return Object.fromEntries(
        await Promise.all(
            tables.map(async ({ tablename }) => [
                tablename,
                await db.query(
                    `SELECT * FROM ${tablename} ORDER BY to_jsonb(${tablename})::text`,
                ),
            ]),
        ),
    );
}
