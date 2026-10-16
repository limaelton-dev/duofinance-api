import { MigrationInterface, QueryRunner } from 'typeorm';

// Generated against the migrated disposable database, then reviewed to retain
// only this table/index. Unrelated legacy metadata differences are excluded.
export class FinancialCommandAudit1792154979034 implements MigrationInterface {
    name = 'FinancialCommandAudit1792154979034';
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE "financial_command_audit" ("actor_id" uuid NOT NULL, "action" character varying(40) NOT NULL, "idempotency_key" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_46d635f611e473e2324edaf54a2" PRIMARY KEY ("actor_id", "action", "idempotency_key"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_financial_command_audit_origin" ON "financial_command_audit"  ("space_id", "commitment_id", "registered_at") `,
        );
    }
    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DROP INDEX "public"."IDX_financial_command_audit_origin"`,
        );
        await queryRunner.query(`DROP TABLE "financial_command_audit"`);
    }
}
