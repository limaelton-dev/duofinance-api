import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReverseSettlementResolution1792164211588 implements MigrationInterface {
    name = 'ReverseSettlementResolution1792164211588';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE inter_member_obligation_changes DROP CONSTRAINT "CHK_obligation_changes_type"`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligation_changes ADD CONSTRAINT "CHK_obligation_changes_type" CHECK ((version = 1 AND type = 'CREATED' AND allocation_id IS NULL) OR (version > 1 AND type = 'SETTLEMENT_APPLIED' AND allocation_id IS NOT NULL) OR (version > 1 AND type IN ('RECONCILED','ASSIGNMENT_CHANGED','OFFSET_APPLIED','WAIVED','REVERSED') AND allocation_id IS NULL))`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_settlement_adjustment_receipts DROP CONSTRAINT "CHK_settlement_adjustment_receipt"`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_settlement_adjustment_receipts ADD CONSTRAINT "CHK_settlement_adjustment_receipt" CHECK (operation IN ('CONFIGURE_COMMITMENT_SETTLEMENT_RULE','MOVE_OBLIGATION','FINALIZE_SETTLEMENT_CYCLE','WAIVE_INTER_MEMBER_OBLIGATION','REVERSE_SETTLEMENT_TRANSFER','REVERSE_SETTLEMENT_OFFSET') AND octet_length(request_hash) = 32)`,
        );
        await queryRunner.query(
            `CREATE TABLE "settlement_reversals" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "original_kind" character varying(8) NOT NULL, "original_transfer_id" uuid, "original_offset_id" uuid, "amount_in_cents" bigint NOT NULL, "fact_date" date NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_by" uuid NOT NULL, CONSTRAINT "UQ_settlement_reversal_offset" UNIQUE ("original_offset_id"), CONSTRAINT "UQ_settlement_reversal_transfer" UNIQUE ("original_transfer_id"), CONSTRAINT "UQ_settlement_reversal_space_id" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_settlement_reversal_values" CHECK (amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((original_kind = 'TRANSFER' AND original_transfer_id IS NOT NULL AND original_offset_id IS NULL) OR (original_kind = 'OFFSET' AND original_offset_id IS NOT NULL AND original_transfer_id IS NULL))), CONSTRAINT "PK_52c4e655c30b7d9f8c91bbdfd38" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "settlement_reversal_applications" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "reversal_id" uuid NOT NULL, "original_transfer_allocation_id" uuid, "original_offset_allocation_id" uuid, "original_obligation_id" uuid NOT NULL, "effect_obligation_id" uuid, "source_cycle_id" uuid, "correction_cycle_id" uuid, "debtor_member_id" uuid NOT NULL, "creditor_member_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, CONSTRAINT "UQ_reversal_application_offset" UNIQUE ("original_offset_allocation_id"), CONSTRAINT "UQ_reversal_application_transfer" UNIQUE ("original_transfer_allocation_id"), CONSTRAINT "CHK_reversal_application_values" CHECK (amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND debtor_member_id <> creditor_member_id AND num_nonnulls(original_transfer_allocation_id,original_offset_allocation_id) = 1), CONSTRAINT "PK_ce544cb48d4184eb2df34be127a" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_reversal_application_source_cycle" ON "settlement_reversal_applications"  ("space_id", "source_cycle_id") `,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_reversal_application_origin" ON "settlement_reversal_applications"  ("space_id", "original_obligation_id") `,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversals" ADD CONSTRAINT "FK_reversal_actor" FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversals" ADD CONSTRAINT "FK_reversal_original_offset" FOREIGN KEY ("space_id", "original_offset_id") REFERENCES "settlement_offsets"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversals" ADD CONSTRAINT "FK_reversal_original_transfer" FOREIGN KEY ("space_id", "original_transfer_id") REFERENCES "settlement_transfers"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" ADD CONSTRAINT "FK_reversal_application_creditor" FOREIGN KEY ("space_id", "creditor_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" ADD CONSTRAINT "FK_reversal_application_debtor" FOREIGN KEY ("space_id", "debtor_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" ADD CONSTRAINT "FK_reversal_application_correction_cycle" FOREIGN KEY ("space_id", "correction_cycle_id") REFERENCES "settlement_cycles"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" ADD CONSTRAINT "FK_reversal_application_source_cycle" FOREIGN KEY ("space_id", "source_cycle_id") REFERENCES "settlement_cycles"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" ADD CONSTRAINT "FK_reversal_application_effect_obligation" FOREIGN KEY ("space_id", "effect_obligation_id") REFERENCES "inter_member_obligations"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" ADD CONSTRAINT "FK_reversal_application_original_obligation" FOREIGN KEY ("space_id", "original_obligation_id") REFERENCES "inter_member_obligations"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" ADD CONSTRAINT "FK_reversal_application_offset" FOREIGN KEY ("space_id", "original_offset_allocation_id") REFERENCES "settlement_offset_allocations"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" ADD CONSTRAINT "FK_reversal_application_transfer" FOREIGN KEY ("space_id", "original_transfer_allocation_id") REFERENCES "settlement_allocations"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" ADD CONSTRAINT "FK_reversal_application_reversal" FOREIGN KEY ("space_id", "reversal_id") REFERENCES "settlement_reversals"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DO $$ BEGIN IF EXISTS (SELECT 1 FROM settlement_reversals) OR EXISTS (SELECT 1 FROM settlement_reversal_applications) OR EXISTS (SELECT 1 FROM inter_member_obligation_changes WHERE type='REVERSED') OR EXISTS (SELECT 1 FROM financial_settlement_adjustment_receipts WHERE operation IN ('REVERSE_SETTLEMENT_TRANSFER','REVERSE_SETTLEMENT_OFFSET')) OR EXISTS (SELECT 1 FROM financial_settlement_adjustment_audit WHERE action IN ('REVERSE_SETTLEMENT_TRANSFER','REVERSE_SETTLEMENT_OFFSET')) THEN RAISE EXCEPTION 'Cannot remove settlement reversal history'; END IF; END $$`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligation_changes DROP CONSTRAINT "CHK_obligation_changes_type"`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligation_changes ADD CONSTRAINT "CHK_obligation_changes_type" CHECK ((version = 1 AND type = 'CREATED' AND allocation_id IS NULL) OR (version > 1 AND type = 'SETTLEMENT_APPLIED' AND allocation_id IS NOT NULL) OR (version > 1 AND type IN ('RECONCILED','ASSIGNMENT_CHANGED','OFFSET_APPLIED','WAIVED') AND allocation_id IS NULL))`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_settlement_adjustment_receipts DROP CONSTRAINT "CHK_settlement_adjustment_receipt"`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_settlement_adjustment_receipts ADD CONSTRAINT "CHK_settlement_adjustment_receipt" CHECK (operation IN ('CONFIGURE_COMMITMENT_SETTLEMENT_RULE','MOVE_OBLIGATION','FINALIZE_SETTLEMENT_CYCLE','WAIVE_INTER_MEMBER_OBLIGATION') AND octet_length(request_hash) = 32)`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" DROP CONSTRAINT "FK_reversal_application_reversal"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" DROP CONSTRAINT "FK_reversal_application_transfer"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" DROP CONSTRAINT "FK_reversal_application_offset"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" DROP CONSTRAINT "FK_reversal_application_original_obligation"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" DROP CONSTRAINT "FK_reversal_application_effect_obligation"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" DROP CONSTRAINT "FK_reversal_application_source_cycle"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" DROP CONSTRAINT "FK_reversal_application_correction_cycle"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" DROP CONSTRAINT "FK_reversal_application_debtor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" DROP CONSTRAINT "FK_reversal_application_creditor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversals" DROP CONSTRAINT "FK_reversal_original_transfer"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversals" DROP CONSTRAINT "FK_reversal_original_offset"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversals" DROP CONSTRAINT "FK_reversal_actor"`,
        );
        await queryRunner.query(
            `DROP TABLE "settlement_reversal_applications"`,
        );
        await queryRunner.query(`DROP TABLE "settlement_reversals"`);
    }
}
