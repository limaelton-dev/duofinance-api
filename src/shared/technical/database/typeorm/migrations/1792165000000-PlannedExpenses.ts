import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PlannedExpenses1792165000000 implements MigrationInterface {
    name = 'PlannedExpenses1792165000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" ADD "expected_payment_date" date`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" ALTER COLUMN "fact_date" DROP NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" DROP CONSTRAINT "CHK_financial_versions_values", ADD CONSTRAINT "CHK_financial_versions_values" CHECK (amount_in_cents >= 1 AND amount_in_cents <= 9007199254740991 AND version = 1 AND (fact_date IS NOT NULL OR expected_payment_date IS NOT NULL) AND ((split_mode IS NOT NULL AND split_mode IN ('AMOUNTS','PERCENTAGES') AND split_input IS NOT NULL) OR (split_mode IS NULL AND split_input IS NULL AND expected_payer_member_id IS NULL AND rule_snapshot IS NULL AND rule_source_version = 0 AND suggested_target_date IS NULL)) AND rule_source_version >= 0 AND (rule_snapshot IS NULL) = (rule_source_version = 0) AND (suggested_target_date IS NULL OR rule_snapshot IS NOT NULL))`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_expense_command_receipts" DROP CONSTRAINT "CHK_expense_receipt", ADD CONSTRAINT "CHK_expense_receipt" CHECK (operation IN ('RECORD_SHARED_CASH_EXPENSE','RECORD_PERSONAL_EXPENSE','RECORD_EXPENSE_DISBURSEMENT','RECORD_CREDIT_CARD_PURCHASE','RECORD_EXTERNAL_LIABILITY','SETTLE_EXTERNAL_LIABILITY','CREATE_PLANNED_EXPENSE') AND status = 'COMPLETED' AND octet_length(request_hash) = 32)`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [row]: { present: boolean }[] = await queryRunner.query(
            `SELECT EXISTS(SELECT 1 FROM financial_commitment_versions WHERE expected_payment_date IS NOT NULL UNION ALL SELECT 1 FROM financial_expense_command_receipts WHERE operation='CREATE_PLANNED_EXPENSE') AS present`,
        );
        if (row.present)
            throw new Error('Planned expenses prevent schema rollback');
        await queryRunner.query(
            `ALTER TABLE "financial_expense_command_receipts" DROP CONSTRAINT "CHK_expense_receipt", ADD CONSTRAINT "CHK_expense_receipt" CHECK (operation IN ('RECORD_SHARED_CASH_EXPENSE','RECORD_PERSONAL_EXPENSE','RECORD_EXPENSE_DISBURSEMENT','RECORD_CREDIT_CARD_PURCHASE','RECORD_EXTERNAL_LIABILITY','SETTLE_EXTERNAL_LIABILITY') AND status = 'COMPLETED' AND octet_length(request_hash) = 32)`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" DROP CONSTRAINT "CHK_financial_versions_values", ADD CONSTRAINT "CHK_financial_versions_values" CHECK (amount_in_cents >= 1 AND amount_in_cents <= 9007199254740991 AND version = 1 AND ((split_mode IS NOT NULL AND split_mode IN ('AMOUNTS','PERCENTAGES') AND split_input IS NOT NULL) OR (split_mode IS NULL AND split_input IS NULL AND expected_payer_member_id IS NULL AND rule_snapshot IS NULL AND rule_source_version = 0 AND suggested_target_date IS NULL)) AND rule_source_version >= 0 AND (rule_snapshot IS NULL) = (rule_source_version = 0) AND (suggested_target_date IS NULL OR rule_snapshot IS NOT NULL))`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" ALTER COLUMN "fact_date" SET NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" DROP COLUMN "expected_payment_date"`,
        );
    }
}
