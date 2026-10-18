import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../dist/app.module.js';
import { configureApp } from '../dist/configure-app.js';
import migrationSource from '../dist/shared/technical/database/typeorm/data-source.js';
import { ROUTINE_CLOCK } from '../dist/modules/routine/application/routine-clock.js';
import { TODAY_CLOCK } from '../dist/composition/today/today.clock.js';
import { TEST_DATABASE_URL } from './setup-env.js';
export async function prepareRoutineDatabase() {
    if (
        migrationSource.options.type !== 'postgres' ||
        migrationSource.options.url !== TEST_DATABASE_URL
    )
        throw new Error('Expected disposable PostgreSQL');
    await migrationSource.initialize();
    try {
        await migrationSource.dropDatabase();
        await migrationSource.runMigrations();
    } finally {
        await migrationSource.destroy();
    }
}
export async function routineApp(clock: () => Date) {
    const module = await Test.createTestingModule({ imports: [AppModule] })
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
export async function routineSnapshot(db: DataSource) {
    const tables: { tablename: string }[] = await db.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'routine_%' ORDER BY tablename",
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
