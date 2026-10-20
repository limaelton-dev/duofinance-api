import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import migrationSource from '../dist/shared/technical/database/typeorm/data-source.js';
import { TEST_DATABASE_URL } from './setup-env.js';

const sqlTables = [
    'financial_occurrence_cancellations',
    'financial_occurrence_shares',
    'financial_occurrence_value_changes',
    'financial_recurrence_terminations',
];

async function schemaCatalog(db: DataSource): Promise<unknown[]> {
    return db.query(`
        SELECT 'column' AS kind, c.relname AS object, a.attname AS name,
            jsonb_build_object('type', format_type(a.atttypid, a.atttypmod),
                'notNull', a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid)) AS definition
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
            AND c.relname <> 'migrations' AND a.attnum > 0 AND NOT a.attisdropped
        UNION ALL
        SELECT 'constraint', c.relname, con.conname, to_jsonb(pg_get_constraintdef(con.oid, true))
        FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname <> 'migrations'
        UNION ALL
        SELECT 'index', t.relname, i.relname, to_jsonb(pg_get_indexdef(i.oid))
        FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public' AND t.relname <> 'migrations'
        ORDER BY 1, 2, 3
    `);
}

describe('Current database schema', () => {
    let db: DataSource;

    beforeAll(async () => {
        if (
            migrationSource.options.type !== 'postgres' ||
            migrationSource.options.url !== TEST_DATABASE_URL
        ) {
            throw new Error(
                'Schema checks require the disposable test database',
            );
        }
        db = new DataSource({ ...migrationSource.options });
        await db.initialize();
        await db.dropDatabase();
        await db.runMigrations();
    });

    afterAll(async () => {
        if (db?.isInitialized) await db.destroy();
    });

    it('creates every mapped table and every SQL-backed recurrence table', async () => {
        const tables = await db.query<{ tablename: string }[]>(`
            SELECT tablename FROM pg_tables
            WHERE schemaname = 'public' AND tablename <> 'migrations'
            ORDER BY tablename
        `);
        expect(tables.map((row) => row.tablename)).toEqual(
            [
                ...db.entityMetadatas.map((entity) => entity.tableName),
                ...sqlTables,
            ].sort(),
        );
        expect(await db.showMigrations()).toBe(false);
        expect(await db.runMigrations()).toEqual([]);
    });

    it('preserves SQL recurrence keys, checks and actor references', async () => {
        const constraints = await db.query<
            { conname: string; definition: string }[]
        >(`
            SELECT conname, pg_get_constraintdef(oid, true) AS definition
            FROM pg_constraint
            WHERE conrelid IN (${sqlTables.map((table) => `'${table}'::regclass`).join(', ')})
                AND contype <> 'n'
            ORDER BY conname
        `);
        expect(constraints).toEqual(
            Object.entries({
                CHK_financial_occurrence_shares:
                    "CHECK (amount_in_cents >= 0 AND amount_in_cents <= '9007199254740991'::bigint)",
                CHK_occurrence_value_changes:
                    "CHECK (version > 1 AND (previous_amount_in_cents IS NULL OR previous_amount_in_cents >= 1 AND previous_amount_in_cents <= '9007199254740991'::bigint) AND amount_in_cents >= 1 AND amount_in_cents <= '9007199254740991'::bigint)",
                FK_occurrence_cancellations_actor:
                    'FOREIGN KEY (actor_id) REFERENCES persons(id) ON DELETE RESTRICT',
                FK_occurrence_cancellations_occurrence:
                    'FOREIGN KEY (space_id, commitment_id, occurrence_id) REFERENCES financial_occurrences(space_id, commitment_id, id) ON DELETE RESTRICT',
                FK_occurrence_shares_member:
                    'FOREIGN KEY (space_id, member_id) REFERENCES space_members(space_id, id) ON DELETE RESTRICT',
                FK_occurrence_shares_occurrence:
                    'FOREIGN KEY (space_id, commitment_id, occurrence_id) REFERENCES financial_occurrences(space_id, commitment_id, id) ON DELETE RESTRICT',
                FK_occurrence_value_changes_actor:
                    'FOREIGN KEY (actor_id) REFERENCES persons(id) ON DELETE RESTRICT',
                FK_occurrence_value_changes_occurrence:
                    'FOREIGN KEY (space_id, commitment_id, occurrence_id) REFERENCES financial_occurrences(space_id, commitment_id, id) ON DELETE RESTRICT',
                FK_recurrence_terminations_actor:
                    'FOREIGN KEY (actor_id) REFERENCES persons(id) ON DELETE RESTRICT',
                FK_recurrence_terminations_commitment:
                    'FOREIGN KEY (space_id, commitment_id) REFERENCES financial_commitments(space_id, id) ON DELETE RESTRICT',
                PK_financial_occurrence_shares:
                    'PRIMARY KEY (occurrence_id, member_id)',
                PK_occurrence_cancellations: 'PRIMARY KEY (occurrence_id)',
                PK_occurrence_value_changes:
                    'PRIMARY KEY (occurrence_id, version)',
                PK_recurrence_terminations: 'PRIMARY KEY (commitment_id)',
            })
                .sort(([left], [right]) => left.localeCompare(right, 'en'))
                .map(([conname, definition]) => ({ conname, definition })),
        );
    });

    it('preserves expression indexes, descending order and partial predicates', async () => {
        const indexes = await db.query<
            { indexname: string; indexdef: string }[]
        >(`
            SELECT indexname, indexdef FROM pg_indexes
            WHERE schemaname = 'public' AND indexname IN (
                'IDX_external_liabilities_open_holder',
                'IDX_routine_occurrence_assignee',
                'IDX_routine_recurrence_assignee',
                'IDX_settlement_transfers_space_registered'
            ) ORDER BY indexname
        `);
        expect(indexes).toEqual([
            {
                indexname: 'IDX_external_liabilities_open_holder',
                indexdef:
                    'CREATE INDEX "IDX_external_liabilities_open_holder" ON public.financial_external_liabilities USING btree (space_id, holder_member_id, holder_person_id, fact_date DESC, id DESC) WHERE (remaining_amount_in_cents > 0)',
            },
            {
                indexname: 'IDX_routine_occurrence_assignee',
                indexdef:
                    "CREATE INDEX \"IDX_routine_occurrence_assignee\" ON public.routine_task_occurrences USING btree (space_id, (((snapshot -> 'assignee'::text) ->> 'personId'::text)), status, scheduled_date)",
            },
            {
                indexname: 'IDX_routine_recurrence_assignee',
                indexdef:
                    "CREATE INDEX \"IDX_routine_recurrence_assignee\" ON public.routine_task_recurrences USING btree (space_id, (((snapshot -> 'assignee'::text) ->> 'personId'::text)))",
            },
            {
                indexname: 'IDX_settlement_transfers_space_registered',
                indexdef:
                    'CREATE INDEX "IDX_settlement_transfers_space_registered" ON public.settlement_transfers USING btree (space_id, registered_at DESC, id DESC)',
            },
        ]);
    });

    it('has no entity drift or unvalidated constraints and indexes', async () => {
        const drift = await db.driver.createSchemaBuilder().log();
        expect(drift.upQueries).toEqual([]);
        expect(drift.downQueries).toEqual([]);
        expect(
            await db.query(`SELECT conname FROM pg_constraint
                WHERE connamespace = 'public'::regnamespace AND NOT convalidated`),
        ).toEqual([]);
        expect(
            await db.query(`SELECT indexrelid::regclass::text FROM pg_index
                WHERE indrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)
                    AND (NOT indisvalid OR NOT indisready)`),
        ).toEqual([]);
    });

    it('reverts the empty schema completely and recreates the same catalog', async () => {
        const before = await schemaCatalog(db);
        while (
            (
                await db.query(
                    'SELECT COUNT(*)::integer AS count FROM migrations',
                )
            )[0].count > 0
        ) {
            await db.undoLastMigration();
        }
        expect(
            await db.query(`SELECT tablename FROM pg_tables
                WHERE schemaname = 'public' AND tablename <> 'migrations'`),
        ).toEqual([]);
        await db.runMigrations();
        expect(await schemaCatalog(db)).toEqual(before);
        expect((await db.driver.createSchemaBuilder().log()).upQueries).toEqual(
            [],
        );
    });
});
