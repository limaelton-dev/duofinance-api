import { MigrationInterface, QueryRunner } from 'typeorm';

export class RoutineRecurrences1792337903897 implements MigrationInterface {
    name = 'RoutineRecurrences1792337903897';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE "routine_task_recurrences" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "creator_person_id" uuid NOT NULL, "starts_on" date NOT NULL, "ends_on" date, "cancelled_on" date, "status" character varying(12) NOT NULL, "version" integer NOT NULL, "snapshot" jsonb NOT NULL, CONSTRAINT "UQ_routine_recurrence_space" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_routine_recurrence_values" CHECK (version>0 AND (ends_on IS NULL OR ends_on>=starts_on) AND status IN ('ACTIVE','CANCELLED') AND ((status='CANCELLED')=(cancelled_on IS NOT NULL))), CONSTRAINT "PK_a083cc441d271a29fd0187d7ad4" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_routine_recurrence_space" ON "routine_task_recurrences"  ("space_id", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "routine_task_occurrences" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "recurrence_id" uuid NOT NULL, "scheduled_date" date NOT NULL, "status" character varying(12) NOT NULL, "version" integer NOT NULL, "snapshot" jsonb NOT NULL, CONSTRAINT "UQ_routine_occurrence_date" UNIQUE ("recurrence_id", "scheduled_date"), CONSTRAINT "CHK_routine_occurrence_values" CHECK (version>0 AND status IN ('PENDING','COMPLETED','SKIPPED','CANCELLED')), CONSTRAINT "PK_ea5add7b8c4baf236ae8ed87e86" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_routine_occurrence_list" ON "routine_task_occurrences"  ("space_id", "status", "scheduled_date", "id") `,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_task_recurrences" ADD CONSTRAINT "FK_routine_recurrence_creator" FOREIGN KEY ("creator_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_task_recurrences" ADD CONSTRAINT "FK_routine_recurrence_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_task_occurrences" ADD CONSTRAINT "FK_routine_occurrence_rule" FOREIGN KEY ("space_id", "recurrence_id") REFERENCES "routine_task_recurrences"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_routine_recurrence_assignee" ON routine_task_recurrences(space_id,(snapshot->'assignee'->>'personId'))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_routine_occurrence_assignee" ON routine_task_occurrences(space_id,(snapshot->'assignee'->>'personId'),status,scheduled_date)`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `LOCK TABLE routine_task_recurrences,routine_task_occurrences IN ACCESS EXCLUSIVE MODE`,
        );
        await queryRunner.query(
            `DO $$ BEGIN IF EXISTS (SELECT 1 FROM routine_task_recurrences) OR EXISTS (SELECT 1 FROM routine_task_occurrences) OR EXISTS (SELECT 1 FROM routine_history WHERE type LIKE 'RECURRENCE_%' OR data ? 'recurrenceId') THEN RAISE EXCEPTION 'Reversão bloqueada para preservar histórico de recorrências'; END IF; END $$`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_task_occurrences" DROP CONSTRAINT "FK_routine_occurrence_rule"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_task_recurrences" DROP CONSTRAINT "FK_routine_recurrence_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_task_recurrences" DROP CONSTRAINT "FK_routine_recurrence_creator"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_routine_occurrence_list"`,
        );
        await queryRunner.query(`DROP TABLE "routine_task_occurrences"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_routine_recurrence_space"`,
        );
        await queryRunner.query(`DROP TABLE "routine_task_recurrences"`);
    }
}
