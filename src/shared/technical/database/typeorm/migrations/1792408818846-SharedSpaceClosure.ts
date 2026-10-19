import { MigrationInterface, QueryRunner } from 'typeorm';
export class SharedSpaceClosure1792408818846 implements MigrationInterface {
    name = 'SharedSpaceClosure1792408818846';
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "space_invitations" DROP CONSTRAINT "CHK_space_invitations_replacement"`,
        );
        await queryRunner.query(
            `CREATE TABLE "space_closure_audit" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "process_id" uuid NOT NULL, "actor_id" uuid NOT NULL, "action" character varying(48) NOT NULL, "idempotency_key" uuid NOT NULL, "plan_revision" integer NOT NULL, "recorded_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_space_closure_audit_revision" CHECK ("plan_revision" >= 1), CONSTRAINT "PK_3fd4098cac3b8cc30206b305b92" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_space_closure_audit_process" ON "space_closure_audit"  ("process_id", "recorded_at", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "space_closure_command_receipts" ("actor_id" uuid NOT NULL, "operation" character varying(48) NOT NULL, "key" uuid NOT NULL, "space_id" uuid NOT NULL, "process_id" uuid NOT NULL, "request_hash" bytea NOT NULL, "http_status" integer NOT NULL, "result" jsonb NOT NULL, "recorded_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_space_closure_receipts_result" CHECK (jsonb_typeof("result") = 'object'), CONSTRAINT "CHK_space_closure_receipts_http_status" CHECK ("http_status" IN (200, 201)), CONSTRAINT "CHK_space_closure_receipts_hash" CHECK (octet_length("request_hash") = 32), CONSTRAINT "PK_space_closure_command_receipts" PRIMARY KEY ("actor_id", "operation", "key"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "space_closure_history" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "process_id" uuid NOT NULL, "action" character varying(48) NOT NULL, "actor_member_id" uuid NOT NULL, "plan_revision" integer NOT NULL, "recorded_at" TIMESTAMP WITH TIME ZONE NOT NULL, "snapshot" jsonb NOT NULL, CONSTRAINT "CHK_space_closure_history_snapshot" CHECK (jsonb_typeof("snapshot") = 'object'), CONSTRAINT "CHK_space_closure_history_revision" CHECK ("plan_revision" >= 1), CONSTRAINT "PK_fea8593a00d8d2c6ac4cf9fab00" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_space_closure_history_page" ON "space_closure_history"  ("space_id", "recorded_at", "id") `,
        );
        await queryRunner.query(`CREATE TABLE "space_closure_processes" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "status" character varying(16) NOT NULL, "requested_by_member_id" uuid NOT NULL, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL, "completed_at" TIMESTAMP WITH TIME ZONE, "cancelled_at" TIMESTAMP WITH TIME ZONE, "cutoff_date" date NOT NULL, "proposed_cutoff_date" date, "plan_revision" integer NOT NULL, "plan_status" character varying(16) NOT NULL, "participants" jsonb NOT NULL, "approvals" jsonb NOT NULL, "confirmations" jsonb NOT NULL, CONSTRAINT "UQ_space_closure_processes_id_space" UNIQUE ("id", "space_id"), CONSTRAINT "CHK_space_closure_processes_resolution" CHECK (
    ("status" = 'OPEN' AND "completed_at" IS NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'COMPLETED' AND "completed_at" IS NOT NULL AND "completed_at" >= "started_at" AND "cancelled_at" IS NULL)
    OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "cancelled_at" >= "started_at" AND "completed_at" IS NULL)), CONSTRAINT "CHK_space_closure_processes_consents" CHECK (jsonb_typeof("approvals") = 'array' AND jsonb_typeof("confirmations") = 'array'), CONSTRAINT "CHK_space_closure_processes_participants" CHECK (jsonb_typeof("participants") = 'array' AND jsonb_array_length("participants") BETWEEN 1 AND 2), CONSTRAINT "CHK_space_closure_processes_cutoff" CHECK ("proposed_cutoff_date" IS NULL OR "proposed_cutoff_date" >= "cutoff_date"), CONSTRAINT "CHK_space_closure_processes_plan_status" CHECK ("plan_status" IN ('DRAFT', 'PROPOSED', 'APPROVED', 'REJECTED')), CONSTRAINT "CHK_space_closure_processes_revision" CHECK ("plan_revision" >= 1), CONSTRAINT "CHK_space_closure_processes_status" CHECK ("status" IN ('OPEN', 'COMPLETED', 'CANCELLED')), CONSTRAINT "PK_ed948e43856d8db7dbb842261db" PRIMARY KEY ("id"))`);
        await queryRunner.query(
            `CREATE INDEX "IDX_space_closure_processes_history" ON "space_closure_processes"  ("space_id", "started_at", "id") `,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_space_closure_processes_open" ON "space_closure_processes"  ("space_id") WHERE "status" = 'OPEN'`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_invitations" ADD "closure_process_id" uuid`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_audit" ADD CONSTRAINT "FK_space_closure_audit_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_audit" ADD CONSTRAINT "FK_space_closure_audit_process" FOREIGN KEY ("process_id", "space_id") REFERENCES "space_closure_processes"("id","space_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_command_receipts" ADD CONSTRAINT "FK_space_closure_receipts_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_command_receipts" ADD CONSTRAINT "FK_space_closure_receipts_process" FOREIGN KEY ("process_id", "space_id") REFERENCES "space_closure_processes"("id","space_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_history" ADD CONSTRAINT "FK_space_closure_history_actor" FOREIGN KEY ("actor_member_id", "space_id") REFERENCES "space_members"("id","space_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_history" ADD CONSTRAINT "FK_space_closure_history_process" FOREIGN KEY ("process_id", "space_id") REFERENCES "space_closure_processes"("id","space_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" ADD CONSTRAINT "FK_space_closure_processes_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" ADD CONSTRAINT "FK_space_closure_processes_requester" FOREIGN KEY ("requested_by_member_id", "space_id") REFERENCES "space_members"("id","space_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_invitations" ADD CONSTRAINT "FK_space_invitations_closure_process" FOREIGN KEY ("closure_process_id", "space_id") REFERENCES "space_closure_processes"("id","space_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(`ALTER TABLE "space_invitations" ADD CONSTRAINT "CHK_space_invitations_replacement" CHECK (
            (status='CANCELLED' AND cancellation_reason IS NOT NULL AND cancellation_reason='REPLACED' AND replaced_by_invitation_id IS NOT NULL AND replaced_by_invitation_id<>id AND closure_process_id IS NULL)
            OR (status='CANCELLED' AND cancellation_reason IS NOT NULL AND cancellation_reason='SPACE_CLOSURE' AND replaced_by_invitation_id IS NULL AND closure_process_id IS NOT NULL)
            OR (status<>'CANCELLED' AND cancellation_reason IS NULL AND replaced_by_invitation_id IS NULL AND closure_process_id IS NULL))`);
    }
    public async down(queryRunner: QueryRunner): Promise<void> {
        const [row] = await queryRunner.query(
            `SELECT EXISTS(SELECT 1 FROM space_closure_processes) AS populated`,
        );
        if (row.populated)
            throw new Error(
                'Preserve o histórico de encerramento antes de reverter esta migration.',
            );
        await queryRunner.query(
            `ALTER TABLE "space_invitations" DROP CONSTRAINT "CHK_space_invitations_replacement"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_invitations" DROP CONSTRAINT "FK_space_invitations_closure_process"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" DROP CONSTRAINT "FK_space_closure_processes_requester"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" DROP CONSTRAINT "FK_space_closure_processes_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_history" DROP CONSTRAINT "FK_space_closure_history_process"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_history" DROP CONSTRAINT "FK_space_closure_history_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_command_receipts" DROP CONSTRAINT "FK_space_closure_receipts_process"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_command_receipts" DROP CONSTRAINT "FK_space_closure_receipts_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_audit" DROP CONSTRAINT "FK_space_closure_audit_process"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_audit" DROP CONSTRAINT "FK_space_closure_audit_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_invitations" DROP COLUMN "closure_process_id"`,
        );
        await queryRunner.query(`DROP TABLE "space_closure_processes"`);
        await queryRunner.query(`DROP TABLE "space_closure_history"`);
        await queryRunner.query(`DROP TABLE "space_closure_command_receipts"`);
        await queryRunner.query(`DROP TABLE "space_closure_audit"`);
        await queryRunner.query(`ALTER TABLE "space_invitations" ADD CONSTRAINT "CHK_space_invitations_replacement" CHECK (
            (status='CANCELLED' AND cancellation_reason IS NOT NULL AND cancellation_reason='REPLACED' AND replaced_by_invitation_id IS NOT NULL AND replaced_by_invitation_id<>id)
            OR (status<>'CANCELLED' AND cancellation_reason IS NULL AND replaced_by_invitation_id IS NULL))`);
    }
}
