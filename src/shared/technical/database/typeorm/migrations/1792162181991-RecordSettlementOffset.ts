import { MigrationInterface, QueryRunner } from 'typeorm';

export class RecordSettlementOffset1792162181991 implements MigrationInterface {
    name = 'RecordSettlementOffset1792162181991';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE inter_member_obligation_changes DROP CONSTRAINT "CHK_obligation_changes_type"`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligation_changes ADD CONSTRAINT "CHK_obligation_changes_type" CHECK ((version = 1 AND type = 'CREATED' AND allocation_id IS NULL) OR (version > 1 AND type = 'SETTLEMENT_APPLIED' AND allocation_id IS NOT NULL) OR (version > 1 AND type IN ('RECONCILED','ASSIGNMENT_CHANGED','OFFSET_APPLIED') AND allocation_id IS NULL))`,
        );
        await queryRunner.query(
            `CREATE TABLE "settlement_offsets" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, "fact_date" date NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_by" uuid NOT NULL, CONSTRAINT "UQ_settlement_offsets_space_id" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_settlement_offset_values" CHECK (amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date), CONSTRAINT "PK_2a109c11b075c09f888e2257b26" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "settlement_offset_allocations" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "offset_id" uuid NOT NULL, "obligation_id" uuid NOT NULL, "cycle_id" uuid, "debtor_member_id" uuid NOT NULL, "creditor_member_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, CONSTRAINT "UQ_offset_allocation_obligation" UNIQUE ("offset_id", "obligation_id"), CONSTRAINT "UQ_offset_allocation_space_id" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_offset_allocation_values" CHECK (amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND debtor_member_id <> creditor_member_id), CONSTRAINT "PK_360361a4577c1b315ae596f99b9" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_offset_allocation_obligation" ON "settlement_offset_allocations"  ("space_id", "obligation_id") `,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_offset_allocation_cycle" ON "settlement_offset_allocations"  ("space_id", "cycle_id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "settlement_offset_command_receipts" ("actor_id" uuid NOT NULL, "idempotency_key" uuid NOT NULL, "space_id" uuid NOT NULL, "offset_id" uuid NOT NULL, "request_hash" bytea NOT NULL, "result" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_offset_receipt_hash" CHECK (octet_length(request_hash) = 32), CONSTRAINT "PK_b18030c8444a3e283df8974996c" PRIMARY KEY ("actor_id", "idempotency_key"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "settlement_offset_audit" ("id" uuid NOT NULL, "actor_id" uuid NOT NULL, "idempotency_key" uuid NOT NULL, "space_id" uuid NOT NULL, "offset_id" uuid NOT NULL, "action" character varying(40) NOT NULL, "payload" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_offset_audit_command" UNIQUE ("actor_id", "idempotency_key"), CONSTRAINT "PK_e8e2dc565631f1f1215233f46e7" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offsets" ADD CONSTRAINT "FK_settlement_offset_actor" FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offsets" ADD CONSTRAINT "FK_settlement_offset_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" ADD CONSTRAINT "FK_offset_allocation_creditor" FOREIGN KEY ("space_id", "creditor_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" ADD CONSTRAINT "FK_offset_allocation_debtor" FOREIGN KEY ("space_id", "debtor_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" ADD CONSTRAINT "FK_offset_allocation_cycle" FOREIGN KEY ("space_id", "cycle_id") REFERENCES "settlement_cycles"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" ADD CONSTRAINT "FK_offset_allocation_obligation" FOREIGN KEY ("space_id", "obligation_id") REFERENCES "inter_member_obligations"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" ADD CONSTRAINT "FK_offset_allocation_offset" FOREIGN KEY ("space_id", "offset_id") REFERENCES "settlement_offsets"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_command_receipts" ADD CONSTRAINT "FK_offset_receipt_offset" FOREIGN KEY ("space_id", "offset_id") REFERENCES "settlement_offsets"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_command_receipts" ADD CONSTRAINT "FK_offset_receipt_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_audit" ADD CONSTRAINT "FK_offset_audit_offset" FOREIGN KEY ("space_id", "offset_id") REFERENCES "settlement_offsets"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_audit" ADD CONSTRAINT "FK_offset_audit_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DO $$ BEGIN IF EXISTS (SELECT 1 FROM settlement_offsets) OR EXISTS (SELECT 1 FROM settlement_offset_allocations) OR EXISTS (SELECT 1 FROM settlement_offset_command_receipts) OR EXISTS (SELECT 1 FROM settlement_offset_audit) OR EXISTS (SELECT 1 FROM inter_member_obligation_changes WHERE type='OFFSET_APPLIED') THEN RAISE EXCEPTION 'Cannot remove settlement offset history'; END IF; END $$`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligation_changes DROP CONSTRAINT "CHK_obligation_changes_type"`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligation_changes ADD CONSTRAINT "CHK_obligation_changes_type" CHECK ((version = 1 AND type = 'CREATED' AND allocation_id IS NULL) OR (version > 1 AND type = 'SETTLEMENT_APPLIED' AND allocation_id IS NOT NULL) OR (version > 1 AND type IN ('RECONCILED','ASSIGNMENT_CHANGED') AND allocation_id IS NULL))`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_audit" DROP CONSTRAINT "FK_offset_audit_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_audit" DROP CONSTRAINT "FK_offset_audit_offset"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_command_receipts" DROP CONSTRAINT "FK_offset_receipt_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_command_receipts" DROP CONSTRAINT "FK_offset_receipt_offset"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" DROP CONSTRAINT "FK_offset_allocation_offset"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" DROP CONSTRAINT "FK_offset_allocation_obligation"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" DROP CONSTRAINT "FK_offset_allocation_cycle"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" DROP CONSTRAINT "FK_offset_allocation_debtor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" DROP CONSTRAINT "FK_offset_allocation_creditor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offsets" DROP CONSTRAINT "FK_settlement_offset_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offsets" DROP CONSTRAINT "FK_settlement_offset_actor"`,
        );
        await queryRunner.query(`DROP TABLE "settlement_offset_audit"`);
        await queryRunner.query(
            `DROP TABLE "settlement_offset_command_receipts"`,
        );
        await queryRunner.query(`DROP TABLE "settlement_offset_allocations"`);
        await queryRunner.query(`DROP TABLE "settlement_offsets"`);
    }
}
