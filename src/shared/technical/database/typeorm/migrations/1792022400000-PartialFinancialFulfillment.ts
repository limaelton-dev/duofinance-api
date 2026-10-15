import type { MigrationInterface, QueryRunner } from 'typeorm';
export class PartialFinancialFulfillment1792022400000 implements MigrationInterface {
    name = 'PartialFinancialFulfillment1792022400000';
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE financial_disbursements DROP CONSTRAINT "UQ_financial_disbursements_commitment"`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_receipts DROP CONSTRAINT "UQ_financial_receipts_commitment"`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_disbursements ADD sequence integer NOT NULL DEFAULT 1`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_receipts ADD sequence integer NOT NULL DEFAULT 1`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_disbursements ALTER COLUMN sequence DROP DEFAULT`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_receipts ALTER COLUMN sequence DROP DEFAULT`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_disbursements ADD CONSTRAINT "UQ_disbursement_sequence" UNIQUE(commitment_id,sequence), ADD CONSTRAINT "CHK_disbursement_sequence" CHECK(sequence>0)`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_receipts ADD CONSTRAINT "UQ_receipt_sequence" UNIQUE(commitment_id,sequence), ADD CONSTRAINT "CHK_receipt_sequence" CHECK(sequence>0)`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligations DROP CONSTRAINT "UQ_obligations_origin_direction"`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_disbursements ADD recorded_by_person_id uuid`,
        );
        await queryRunner.query(
            `UPDATE financial_disbursements d SET recorded_by_person_id=c.created_by FROM financial_commitments c WHERE c.space_id=d.space_id AND c.id=d.commitment_id`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_disbursements ALTER COLUMN recorded_by_person_id SET NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_disbursements ADD CONSTRAINT "FK_financial_disbursements_recorder" FOREIGN KEY (recorded_by_person_id) REFERENCES persons(id) ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligations ADD recognized_amount_in_cents bigint`,
        );
        await queryRunner.query(
            `UPDATE inter_member_obligations SET recognized_amount_in_cents=original_amount_in_cents`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligations ALTER COLUMN recognized_amount_in_cents SET NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligations DROP CONSTRAINT "CHK_obligations_state"`,
        );
        await queryRunner.query(`ALTER TABLE inter_member_obligations ADD CONSTRAINT "CHK_obligations_state" CHECK (
            original_amount_in_cents BETWEEN 1 AND 9007199254740991 AND recognized_amount_in_cents BETWEEN 0 AND 9007199254740991 AND remaining_amount_in_cents BETWEEN 0 AND recognized_amount_in_cents AND debtor_member_id<>creditor_member_id AND version>0 AND fact_date<=(registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND
            ((status='OPEN' AND remaining_amount_in_cents>0 AND remaining_amount_in_cents=recognized_amount_in_cents) OR (status='PARTIALLY_SETTLED' AND remaining_amount_in_cents>0 AND remaining_amount_in_cents<recognized_amount_in_cents) OR (status IN ('SETTLED','RECONCILED') AND remaining_amount_in_cents=0)))`);
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_obligations_open_origin" ON inter_member_obligations(space_id,commitment_id) WHERE remaining_amount_in_cents>0`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligation_changes DROP CONSTRAINT "CHK_obligation_changes_type"`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligation_changes ADD CONSTRAINT "CHK_obligation_changes_type" CHECK ((version=1 AND type='CREATED' AND allocation_id IS NULL) OR (version>1 AND type='SETTLEMENT_APPLIED' AND allocation_id IS NOT NULL) OR (version>1 AND type='RECONCILED' AND allocation_id IS NULL))`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_expense_command_receipts DROP CONSTRAINT "CHK_expense_receipt"`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_expense_command_receipts ADD CONSTRAINT "CHK_expense_receipt" CHECK (operation IN ('RECORD_SHARED_CASH_EXPENSE','RECORD_PERSONAL_EXPENSE','RECORD_EXPENSE_DISBURSEMENT') AND status='COMPLETED' AND octet_length(request_hash)=32)`,
        );
    }
    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DO $$ BEGIN IF
            EXISTS(SELECT 1 FROM financial_disbursements GROUP BY commitment_id HAVING count(*)>1) OR
            EXISTS(SELECT 1 FROM financial_receipts GROUP BY commitment_id HAVING count(*)>1) OR
            EXISTS(SELECT 1 FROM financial_disbursements d JOIN financial_commitment_versions v ON v.space_id=d.space_id AND v.commitment_id=d.commitment_id AND v.version=1 WHERE d.amount_in_cents<>v.amount_in_cents) OR
            EXISTS(SELECT 1 FROM financial_receipts r JOIN financial_income_versions v ON v.space_id=r.space_id AND v.commitment_id=r.commitment_id WHERE r.amount_in_cents<>v.amount_in_cents) OR
            EXISTS(SELECT 1 FROM inter_member_obligation_changes WHERE type='RECONCILED') OR
            EXISTS(SELECT 1 FROM inter_member_obligations WHERE recognized_amount_in_cents<>original_amount_in_cents OR status='RECONCILED') OR
            EXISTS(SELECT 1 FROM financial_expense_command_receipts WHERE operation='RECORD_EXPENSE_DISBURSEMENT')
            THEN RAISE EXCEPTION 'Partial financial fulfillment cannot be reverted without losing recorded facts or reconciliation history'; END IF; END $$`);
        await queryRunner.query(
            `ALTER TABLE financial_expense_command_receipts DROP CONSTRAINT "CHK_expense_receipt"`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_expense_command_receipts ADD CONSTRAINT "CHK_expense_receipt" CHECK (operation IN ('RECORD_SHARED_CASH_EXPENSE','RECORD_PERSONAL_EXPENSE') AND status='COMPLETED' AND octet_length(request_hash)=32)`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligation_changes DROP CONSTRAINT "CHK_obligation_changes_type"`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligation_changes ADD CONSTRAINT "CHK_obligation_changes_type" CHECK ((version=1 AND type='CREATED' AND allocation_id IS NULL) OR (version>1 AND type='SETTLEMENT_APPLIED' AND allocation_id IS NOT NULL))`,
        );
        await queryRunner.query(`DROP INDEX "UQ_obligations_open_origin"`);
        await queryRunner.query(
            `ALTER TABLE inter_member_obligations DROP CONSTRAINT "CHK_obligations_state"`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligations ADD CONSTRAINT "CHK_obligations_state" CHECK (original_amount_in_cents BETWEEN 1 AND 9007199254740991 AND remaining_amount_in_cents BETWEEN 0 AND original_amount_in_cents AND debtor_member_id<>creditor_member_id AND version>0 AND fact_date<=(registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((status='OPEN' AND remaining_amount_in_cents=original_amount_in_cents) OR (status='PARTIALLY_SETTLED' AND remaining_amount_in_cents>0 AND remaining_amount_in_cents<original_amount_in_cents) OR (status='SETTLED' AND remaining_amount_in_cents=0)))`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligations DROP COLUMN recognized_amount_in_cents`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_disbursements DROP CONSTRAINT "FK_financial_disbursements_recorder"`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_disbursements DROP COLUMN recorded_by_person_id`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_disbursements DROP COLUMN sequence`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_receipts DROP COLUMN sequence`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_disbursements ADD CONSTRAINT "UQ_financial_disbursements_commitment" UNIQUE(commitment_id)`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_receipts ADD CONSTRAINT "UQ_financial_receipts_commitment" UNIQUE(commitment_id)`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligations ADD CONSTRAINT "UQ_obligations_origin_direction" UNIQUE(commitment_id,debtor_member_id,creditor_member_id)`,
        );
    }
}
