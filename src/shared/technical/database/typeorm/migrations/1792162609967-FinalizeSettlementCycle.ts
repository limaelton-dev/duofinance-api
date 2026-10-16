import { MigrationInterface, QueryRunner } from 'typeorm';

export class FinalizeSettlementCycle1792162609967 implements MigrationInterface {
    name = 'FinalizeSettlementCycle1792162609967';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE financial_settlement_adjustment_receipts DROP CONSTRAINT "CHK_settlement_adjustment_receipt"`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_settlement_adjustment_receipts ADD CONSTRAINT "CHK_settlement_adjustment_receipt" CHECK (operation IN ('CONFIGURE_COMMITMENT_SETTLEMENT_RULE','MOVE_OBLIGATION','FINALIZE_SETTLEMENT_CYCLE') AND octet_length(request_hash) = 32)`,
        );
        await queryRunner.query(
            `CREATE TABLE "settlement_cycle_changes" ("cycle_id" uuid NOT NULL, "version" integer NOT NULL, "space_id" uuid NOT NULL, "actor_id" uuid NOT NULL, "type" character varying(24) NOT NULL, "snapshot" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_cycle_change_finalization" CHECK (version > 1 AND type = 'FINALIZED'), CONSTRAINT "PK_37edf60fe2ac9fae5daa1d72cf7" PRIMARY KEY ("cycle_id", "version"))`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_cycle_changes" ADD CONSTRAINT "FK_cycle_change_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_cycle_changes" ADD CONSTRAINT "FK_cycle_change_cycle" FOREIGN KEY ("space_id", "cycle_id") REFERENCES "settlement_cycles"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DO $$ BEGIN IF EXISTS (SELECT 1 FROM settlement_cycle_changes) OR EXISTS (SELECT 1 FROM financial_settlement_adjustment_receipts WHERE operation='FINALIZE_SETTLEMENT_CYCLE') OR EXISTS (SELECT 1 FROM financial_settlement_adjustment_audit WHERE action='FINALIZE_SETTLEMENT_CYCLE') THEN RAISE EXCEPTION 'Cannot remove settlement cycle finalization history'; END IF; END $$`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_settlement_adjustment_receipts DROP CONSTRAINT "CHK_settlement_adjustment_receipt"`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_settlement_adjustment_receipts ADD CONSTRAINT "CHK_settlement_adjustment_receipt" CHECK (operation IN ('CONFIGURE_COMMITMENT_SETTLEMENT_RULE','MOVE_OBLIGATION') AND octet_length(request_hash) = 32)`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_cycle_changes" DROP CONSTRAINT "FK_cycle_change_cycle"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_cycle_changes" DROP CONSTRAINT "FK_cycle_change_actor"`,
        );
        await queryRunner.query(`DROP TABLE "settlement_cycle_changes"`);
    }
}
