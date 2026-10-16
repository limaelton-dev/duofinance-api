import { MigrationInterface, QueryRunner } from 'typeorm';

export class WaiveInterMemberObligation1792163371690 implements MigrationInterface {
    name = 'WaiveInterMemberObligation1792163371690';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE inter_member_obligations DROP CONSTRAINT "CHK_obligations_state"`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligations ADD CONSTRAINT "CHK_obligations_state" CHECK (original_amount_in_cents BETWEEN 1 AND 9007199254740991 AND recognized_amount_in_cents BETWEEN 0 AND 9007199254740991 AND remaining_amount_in_cents BETWEEN 0 AND 9007199254740991 AND remaining_amount_in_cents <= recognized_amount_in_cents AND debtor_member_id <> creditor_member_id AND version > 0 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((status = 'OPEN' AND remaining_amount_in_cents > 0 AND remaining_amount_in_cents = recognized_amount_in_cents) OR (status = 'PARTIALLY_SETTLED' AND remaining_amount_in_cents > 0 AND remaining_amount_in_cents < recognized_amount_in_cents) OR (status IN ('SETTLED','RECONCILED','WAIVED') AND remaining_amount_in_cents = 0)))`,
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
            `CREATE TABLE "obligation_waivers" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "obligation_id" uuid NOT NULL, "creditor_member_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, "fact_date" date NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_by" uuid NOT NULL, "reason" character varying(500), CONSTRAINT "UQ_obligation_waiver_space_id" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_obligation_waiver_values" CHECK (amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND (reason IS NULL OR (length(reason) BETWEEN 1 AND 500 AND reason = btrim(reason)))), CONSTRAINT "PK_00bbf487ff78d0a5a780160ce1d" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_obligation_waiver_origin" ON "obligation_waivers"  ("space_id", "obligation_id", "registered_at", "id") `,
        );
        await queryRunner.query(
            `ALTER TABLE "obligation_waivers" ADD CONSTRAINT "FK_obligation_waiver_actor" FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "obligation_waivers" ADD CONSTRAINT "FK_obligation_waiver_creditor" FOREIGN KEY ("space_id", "creditor_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "obligation_waivers" ADD CONSTRAINT "FK_obligation_waiver_origin" FOREIGN KEY ("space_id", "obligation_id") REFERENCES "inter_member_obligations"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DO $$ BEGIN IF EXISTS (SELECT 1 FROM obligation_waivers) OR EXISTS (SELECT 1 FROM inter_member_obligation_changes WHERE type='WAIVED') OR EXISTS (SELECT 1 FROM financial_settlement_adjustment_receipts WHERE operation='WAIVE_INTER_MEMBER_OBLIGATION') OR EXISTS (SELECT 1 FROM financial_settlement_adjustment_audit WHERE action='WAIVE_INTER_MEMBER_OBLIGATION') THEN RAISE EXCEPTION 'Cannot remove obligation waiver history'; END IF; END $$`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligations DROP CONSTRAINT "CHK_obligations_state"`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligations ADD CONSTRAINT "CHK_obligations_state" CHECK (original_amount_in_cents BETWEEN 1 AND 9007199254740991 AND recognized_amount_in_cents BETWEEN 0 AND 9007199254740991 AND remaining_amount_in_cents BETWEEN 0 AND 9007199254740991 AND remaining_amount_in_cents <= recognized_amount_in_cents AND debtor_member_id <> creditor_member_id AND version > 0 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((status = 'OPEN' AND remaining_amount_in_cents > 0 AND remaining_amount_in_cents = recognized_amount_in_cents) OR (status = 'PARTIALLY_SETTLED' AND remaining_amount_in_cents > 0 AND remaining_amount_in_cents < recognized_amount_in_cents) OR (status IN ('SETTLED','RECONCILED') AND remaining_amount_in_cents = 0)))`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligation_changes DROP CONSTRAINT "CHK_obligation_changes_type"`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligation_changes ADD CONSTRAINT "CHK_obligation_changes_type" CHECK ((version = 1 AND type = 'CREATED' AND allocation_id IS NULL) OR (version > 1 AND type = 'SETTLEMENT_APPLIED' AND allocation_id IS NOT NULL) OR (version > 1 AND type IN ('RECONCILED','ASSIGNMENT_CHANGED','OFFSET_APPLIED') AND allocation_id IS NULL))`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_settlement_adjustment_receipts DROP CONSTRAINT "CHK_settlement_adjustment_receipt"`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_settlement_adjustment_receipts ADD CONSTRAINT "CHK_settlement_adjustment_receipt" CHECK (operation IN ('CONFIGURE_COMMITMENT_SETTLEMENT_RULE','MOVE_OBLIGATION','FINALIZE_SETTLEMENT_CYCLE') AND octet_length(request_hash) = 32)`,
        );
        await queryRunner.query(
            `ALTER TABLE "obligation_waivers" DROP CONSTRAINT "FK_obligation_waiver_origin"`,
        );
        await queryRunner.query(
            `ALTER TABLE "obligation_waivers" DROP CONSTRAINT "FK_obligation_waiver_creditor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "obligation_waivers" DROP CONSTRAINT "FK_obligation_waiver_actor"`,
        );
        await queryRunner.query(`DROP TABLE "obligation_waivers"`);
    }
}
