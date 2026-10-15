import { MigrationInterface, QueryRunner } from 'typeorm';

export class RecordCreditCardPurchase1792087652424 implements MigrationInterface {
    name = 'RecordCreditCardPurchase1792087652424';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "CHK_obligations_origin_xor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_expense_command_receipts" DROP CONSTRAINT "CHK_expense_receipt"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_expense_command_receipts" ADD CONSTRAINT "CHK_expense_receipt" CHECK (operation IN ('RECORD_SHARED_CASH_EXPENSE','RECORD_PERSONAL_EXPENSE','RECORD_EXPENSE_DISBURSEMENT','RECORD_CREDIT_CARD_PURCHASE','RECORD_EXTERNAL_LIABILITY') AND status = 'COMPLETED' AND octet_length(request_hash) = 32)`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_external_liabilities" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "sequence" integer NOT NULL, "version" integer NOT NULL, "holder_member_id" uuid, "holder_person_id" uuid, "recorded_by_person_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, "remaining_amount_in_cents" bigint NOT NULL, "fact_date" date NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_external_liabilities_sequence" UNIQUE ("commitment_id", "sequence"), CONSTRAINT "UQ_external_liabilities_origin" UNIQUE ("space_id", "commitment_id", "id"), CONSTRAINT "CHK_external_liabilities_values" CHECK ("amount_in_cents" >= 1 AND "amount_in_cents" <= 9007199254740991 AND remaining_amount_in_cents = amount_in_cents AND sequence > 0 AND version = 1 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((holder_member_id IS NOT NULL AND holder_person_id IS NULL) OR (holder_member_id IS NULL AND holder_person_id IS NOT NULL))), CONSTRAINT "PK_014e3500882bb1118066260fa79" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD "external_liability_id" uuid`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "CHK_obligations_origin_xor" CHECK (num_nonnulls(disbursement_id, receipt_id, external_liability_id) = 1)`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liabilities" ADD CONSTRAINT "FK_external_liabilities_personal_holder" FOREIGN KEY ("holder_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liabilities" ADD CONSTRAINT "FK_external_liabilities_recorder" FOREIGN KEY ("recorded_by_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liabilities" ADD CONSTRAINT "FK_external_liabilities_holder" FOREIGN KEY ("space_id", "holder_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liabilities" ADD CONSTRAINT "FK_external_liabilities_version" FOREIGN KEY ("space_id", "commitment_id", "version") REFERENCES "financial_commitment_versions"("space_id","commitment_id","version") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "FK_obligations_external_liability" FOREIGN KEY ("space_id", "commitment_id", "external_liability_id") REFERENCES "financial_external_liabilities"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DO $$ BEGIN IF EXISTS (SELECT 1 FROM financial_external_liabilities) OR EXISTS (SELECT 1 FROM financial_expense_command_receipts WHERE operation IN ('RECORD_CREDIT_CARD_PURCHASE','RECORD_EXTERNAL_LIABILITY')) THEN RAISE EXCEPTION 'Cannot revert credit card purchases while external liabilities or command receipts exist'; END IF; END $$`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "CHK_obligations_origin_xor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_expense_command_receipts" DROP CONSTRAINT "CHK_expense_receipt"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_expense_command_receipts" ADD CONSTRAINT "CHK_expense_receipt" CHECK (operation IN ('RECORD_SHARED_CASH_EXPENSE','RECORD_PERSONAL_EXPENSE','RECORD_EXPENSE_DISBURSEMENT') AND status = 'COMPLETED' AND octet_length(request_hash) = 32)`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "FK_obligations_external_liability"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liabilities" DROP CONSTRAINT "FK_external_liabilities_version"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liabilities" DROP CONSTRAINT "FK_external_liabilities_holder"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liabilities" DROP CONSTRAINT "FK_external_liabilities_recorder"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liabilities" DROP CONSTRAINT "FK_external_liabilities_personal_holder"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP COLUMN "external_liability_id"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "CHK_obligations_origin_xor" CHECK ((disbursement_id IS NOT NULL) <> (receipt_id IS NOT NULL))`,
        );
        await queryRunner.query(`DROP TABLE "financial_external_liabilities"`);
    }
}
