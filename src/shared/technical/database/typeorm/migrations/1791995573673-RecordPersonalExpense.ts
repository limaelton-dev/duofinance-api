import type { MigrationInterface, QueryRunner } from 'typeorm';
export class RecordPersonalExpense1791995573673 implements MigrationInterface {
    name = 'RecordPersonalExpense1791995573673';
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" ADD "personal_owner_person_id" uuid`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" ADD "payer_person_id" uuid`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" ALTER COLUMN "split_mode" DROP NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" ALTER COLUMN "split_input" DROP NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" ALTER COLUMN "payer_member_id" DROP NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" ADD CONSTRAINT "FK_financial_commitments_personal_owner" FOREIGN KEY ("personal_owner_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" ADD CONSTRAINT "FK_financial_disbursements_personal_payer" FOREIGN KEY ("payer_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_commitments DROP CONSTRAINT "CHK_financial_commitments_scope", ADD CONSTRAINT "CHK_financial_commitments_scope" CHECK (kind = 'EXPENSE' AND modality = 'ONE_TIME' AND version > 0 AND length(description) BETWEEN 1 AND 160 AND description = btrim(description) AND (personal_owner_person_id IS NULL OR personal_owner_person_id = created_by))`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_commitment_versions DROP CONSTRAINT "CHK_financial_versions_values", ADD CONSTRAINT "CHK_financial_versions_values" CHECK (amount_in_cents >= 1 AND amount_in_cents <= 9007199254740991 AND version = 1 AND ((split_mode IS NOT NULL AND split_mode IN ('AMOUNTS','PERCENTAGES') AND split_input IS NOT NULL) OR (split_mode IS NULL AND split_input IS NULL AND expected_payer_member_id IS NULL AND rule_snapshot IS NULL AND rule_source_version = 0 AND suggested_target_date IS NULL)) AND rule_source_version >= 0 AND (rule_snapshot IS NULL) = (rule_source_version = 0) AND (suggested_target_date IS NULL OR rule_snapshot IS NOT NULL))`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_disbursements DROP CONSTRAINT "CHK_financial_disbursements_values", ADD CONSTRAINT "CHK_financial_disbursements_values" CHECK (amount_in_cents >= 1 AND amount_in_cents <= 9007199254740991 AND method IN ('PIX','DEBIT','CASH') AND version = 1 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((payer_member_id IS NOT NULL AND payer_person_id IS NULL) OR (payer_member_id IS NULL AND payer_person_id IS NOT NULL)))`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_expense_command_receipts DROP CONSTRAINT "CHK_expense_receipt", ADD CONSTRAINT "CHK_expense_receipt" CHECK (operation IN ('RECORD_SHARED_CASH_EXPENSE','RECORD_PERSONAL_EXPENSE') AND status = 'COMPLETED' AND octet_length(request_hash) = 32)`,
        );
    }
    public async down(queryRunner: QueryRunner): Promise<void> {
        const [row]: { present: boolean }[] = await queryRunner.query(
            `SELECT EXISTS(SELECT 1 FROM financial_commitments WHERE personal_owner_person_id IS NOT NULL UNION ALL SELECT 1 FROM financial_disbursements WHERE payer_person_id IS NOT NULL UNION ALL SELECT 1 FROM financial_expense_command_receipts WHERE operation = 'RECORD_PERSONAL_EXPENSE') AS present`,
        );
        if (row.present)
            throw new Error('Personal financial facts prevent schema rollback');
        await queryRunner.query(
            `ALTER TABLE financial_expense_command_receipts DROP CONSTRAINT "CHK_expense_receipt", ADD CONSTRAINT "CHK_expense_receipt" CHECK (operation = 'RECORD_SHARED_CASH_EXPENSE' AND status = 'COMPLETED' AND octet_length(request_hash) = 32)`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_disbursements DROP CONSTRAINT "CHK_financial_disbursements_values", ADD CONSTRAINT "CHK_financial_disbursements_values" CHECK (amount_in_cents >= 1 AND amount_in_cents <= 9007199254740991 AND method IN ('PIX','DEBIT','CASH') AND version = 1 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date)`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_commitment_versions DROP CONSTRAINT "CHK_financial_versions_values", ADD CONSTRAINT "CHK_financial_versions_values" CHECK (amount_in_cents >= 1 AND amount_in_cents <= 9007199254740991 AND version = 1 AND split_mode IN ('AMOUNTS','PERCENTAGES') AND rule_source_version >= 0 AND (rule_snapshot IS NULL) = (rule_source_version = 0) AND (suggested_target_date IS NULL OR rule_snapshot IS NOT NULL))`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_commitments DROP CONSTRAINT "CHK_financial_commitments_scope", ADD CONSTRAINT "CHK_financial_commitments_scope" CHECK (kind = 'EXPENSE' AND modality = 'ONE_TIME' AND version > 0 AND length(description) BETWEEN 1 AND 160 AND description = btrim(description))`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" DROP CONSTRAINT "FK_financial_disbursements_personal_payer"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" DROP CONSTRAINT "FK_financial_commitments_personal_owner"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" ALTER COLUMN "payer_member_id" SET NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" ALTER COLUMN "split_input" SET NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" ALTER COLUMN "split_mode" SET NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" DROP COLUMN "payer_person_id"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" DROP COLUMN "personal_owner_person_id"`,
        );
    }
}
