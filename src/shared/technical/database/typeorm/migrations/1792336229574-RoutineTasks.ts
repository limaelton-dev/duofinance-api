import { MigrationInterface, QueryRunner } from 'typeorm';

export class RoutineTasks1792336229574 implements MigrationInterface {
    name = 'RoutineTasks1792336229574';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE "routine_tasks" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "description" character varying(500) NOT NULL, "creator_person_id" uuid NOT NULL, "creator_member_id" uuid, "assignee_person_id" uuid, "assignee_member_id" uuid, "deadline_date" date, "deadline_time" character varying(5), "urgency" character varying(10) NOT NULL, "status" character varying(12) NOT NULL, "version" integer NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "completion" jsonb, CONSTRAINT "UQ_routine_task_space" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_routine_task_values" CHECK (version > 0 AND length(description) BETWEEN 1 AND 500 AND description=btrim(description) AND urgency IN ('LOW','NORMAL','HIGH','URGENT') AND status IN ('PENDING','COMPLETED','CANCELLED') AND (deadline_time IS NULL OR (deadline_date IS NOT NULL AND deadline_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')) AND ((status='COMPLETED')=(completion IS NOT NULL)) AND (assignee_member_id IS NULL OR assignee_person_id IS NOT NULL)), CONSTRAINT "PK_6474faef320dbde49988984c9e3" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_routine_task_assignee" ON "routine_tasks"  ("space_id", "assignee_person_id", "status") `,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_routine_task_list" ON "routine_tasks"  ("space_id", "status", "urgency", "deadline_date", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "routine_history" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "aggregate_id" uuid NOT NULL, "sequence" integer NOT NULL, "type" character varying(40) NOT NULL, "actor_id" uuid NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "data" jsonb NOT NULL, CONSTRAINT "UQ_routine_history_version" UNIQUE ("aggregate_id", "sequence"), CONSTRAINT "PK_c106e063288c9686f7bd2363ccd" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_routine_history_page" ON "routine_history"  ("space_id", "aggregate_id", "sequence") `,
        );
        await queryRunner.query(
            `CREATE TABLE "routine_command_receipts" ("actor_id" uuid NOT NULL CONSTRAINT "FK_routine_receipt_actor" REFERENCES persons(id) ON DELETE RESTRICT, "operation" character varying(60) NOT NULL, "key" uuid NOT NULL, "digest" character varying(64) NOT NULL, "result" jsonb NOT NULL, CONSTRAINT "PK_659ab1e28b31ce47f8147a8a5f0" PRIMARY KEY ("actor_id", "operation", "key"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "routine_command_audit" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "actor_id" uuid NOT NULL, "action" character varying(60) NOT NULL, "aggregate_id" uuid NOT NULL, "key" uuid NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_aa3fc2df3a4b43eb9eb455c5613" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_routine_audit_space" ON "routine_command_audit"  ("space_id", "registered_at") `,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" ADD CONSTRAINT "FK_routine_task_assignee_member" FOREIGN KEY ("space_id", "assignee_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" ADD CONSTRAINT "FK_routine_task_creator_member" FOREIGN KEY ("space_id", "creator_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" ADD CONSTRAINT "FK_routine_task_assignee" FOREIGN KEY ("assignee_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" ADD CONSTRAINT "FK_routine_task_creator" FOREIGN KEY ("creator_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" ADD CONSTRAINT "FK_routine_task_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_history" ADD CONSTRAINT "FK_routine_history_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_history" ADD CONSTRAINT "FK_routine_history_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_command_audit" ADD CONSTRAINT "FK_routine_audit_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_command_audit" ADD CONSTRAINT "FK_routine_audit_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `LOCK TABLE routine_tasks,routine_history,routine_command_receipts,routine_command_audit IN ACCESS EXCLUSIVE MODE`,
        );
        await queryRunner.query(
            `DO $$ BEGIN IF EXISTS (SELECT 1 FROM routine_tasks) OR EXISTS (SELECT 1 FROM routine_history) OR EXISTS (SELECT 1 FROM routine_command_receipts) OR EXISTS (SELECT 1 FROM routine_command_audit) THEN RAISE EXCEPTION 'Reversão bloqueada para preservar histórico de rotina'; END IF; END $$`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_command_audit" DROP CONSTRAINT "FK_routine_audit_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_command_audit" DROP CONSTRAINT "FK_routine_audit_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_history" DROP CONSTRAINT "FK_routine_history_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_history" DROP CONSTRAINT "FK_routine_history_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" DROP CONSTRAINT "FK_routine_task_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" DROP CONSTRAINT "FK_routine_task_creator"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" DROP CONSTRAINT "FK_routine_task_assignee"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" DROP CONSTRAINT "FK_routine_task_creator_member"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" DROP CONSTRAINT "FK_routine_task_assignee_member"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_routine_audit_space"`,
        );
        await queryRunner.query(`DROP TABLE "routine_command_audit"`);
        await queryRunner.query(`DROP TABLE "routine_command_receipts"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_routine_history_page"`,
        );
        await queryRunner.query(`DROP TABLE "routine_history"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_routine_task_list"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_routine_task_assignee"`,
        );
        await queryRunner.query(`DROP TABLE "routine_tasks"`);
    }
}
