import { MigrationInterface, QueryRunner } from 'typeorm';

export class RecordIncomeAndReceipt1792022348501 implements MigrationInterface {
    name = 'RecordIncomeAndReceipt1792022348501';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" DROP CONSTRAINT "CHK_financial_commitments_scope"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" ADD CONSTRAINT "CHK_financial_commitments_scope" CHECK (kind IN ('EXPENSE','INCOME') AND modality = 'ONE_TIME' AND version > 0 AND length(description) BETWEEN 1 AND 160 AND description = btrim(description) AND (personal_owner_person_id IS NULL OR personal_owner_person_id = created_by))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_income_versions" ("commitment_id" uuid NOT NULL, "space_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, "expected_receipt_date" date NOT NULL, "owner_person_id" uuid, "split_input" jsonb, "expected_recipient_member_id" uuid, "rule_snapshot" jsonb, "rule_source_version" integer NOT NULL, CONSTRAINT "UQ_income_versions_space" UNIQUE ("space_id", "commitment_id"), CONSTRAINT "CHK_income_versions_values" CHECK (amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND ((owner_person_id IS NOT NULL AND split_input IS NULL AND expected_recipient_member_id IS NULL AND rule_snapshot IS NULL AND rule_source_version = 0) OR (owner_person_id IS NULL AND split_input IS NOT NULL AND (rule_snapshot IS NULL) = (rule_source_version = 0)))), CONSTRAINT "PK_62b2fe3e149abebbca4e1c226cc" PRIMARY KEY ("commitment_id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_income_shares" ("commitment_id" uuid NOT NULL, "member_id" uuid NOT NULL, "space_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, CONSTRAINT "CHK_income_shares_values" CHECK (amount_in_cents >= 0 AND amount_in_cents <= 9007199254740991), CONSTRAINT "PK_e28c00d398bca722360a44265e8" PRIMARY KEY ("commitment_id", "member_id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_receipts" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, "fact_date" date NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "recorded_by_person_id" uuid NOT NULL, "recipient_person_id" uuid, "recipient_member_id" uuid, CONSTRAINT "UQ_financial_receipts_origin" UNIQUE ("space_id", "commitment_id", "id"), CONSTRAINT "UQ_financial_receipts_commitment" UNIQUE ("commitment_id"), CONSTRAINT "CHK_financial_receipts_values" CHECK (amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((recipient_person_id IS NOT NULL AND recipient_member_id IS NULL) OR (recipient_person_id IS NULL AND recipient_member_id IS NOT NULL))), CONSTRAINT "PK_346bc406f82e17f3eb446ba0d94" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_income_command_receipts" ("actor_id" uuid NOT NULL, "operation" character varying(32) NOT NULL, "idempotency_key" uuid NOT NULL, "request_hash" bytea NOT NULL, "status" character varying(16) NOT NULL, "commitment_id" uuid NOT NULL, "result" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_income_command_receipts" CHECK (operation IN ('RECORD_INCOME','RECORD_INCOME_RECEIPT') AND status = 'COMPLETED' AND octet_length(request_hash) = 32), CONSTRAINT "PK_68b291af2dc53155163870cfd7b" PRIMARY KEY ("actor_id", "operation", "idempotency_key"))`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD "receipt_id" uuid`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ALTER COLUMN "disbursement_id" DROP NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "CHK_obligations_origin_xor" CHECK ((disbursement_id IS NOT NULL) <> (receipt_id IS NOT NULL))`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "FK_obligations_receipt" FOREIGN KEY ("space_id", "commitment_id", "receipt_id") REFERENCES "financial_receipts"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_versions" ADD CONSTRAINT "FK_income_versions_expected_recipient" FOREIGN KEY ("space_id", "expected_recipient_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_versions" ADD CONSTRAINT "FK_income_versions_owner" FOREIGN KEY ("owner_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_versions" ADD CONSTRAINT "FK_income_versions_commitment" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_shares" ADD CONSTRAINT "FK_income_shares_member" FOREIGN KEY ("space_id", "member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_shares" ADD CONSTRAINT "FK_income_shares_version" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_income_versions"("space_id","commitment_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_receipts" ADD CONSTRAINT "FK_financial_receipts_person" FOREIGN KEY ("recipient_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_receipts" ADD CONSTRAINT "FK_financial_receipts_recorder" FOREIGN KEY ("recorded_by_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_receipts" ADD CONSTRAINT "FK_financial_receipts_member" FOREIGN KEY ("space_id", "recipient_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_receipts" ADD CONSTRAINT "FK_financial_receipts_income" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_income_versions"("space_id","commitment_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_command_receipts" ADD CONSTRAINT "FK_income_command_commitment" FOREIGN KEY ("commitment_id") REFERENCES "financial_commitments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_command_receipts" ADD CONSTRAINT "FK_income_command_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const rows: { exists: boolean }[] = await queryRunner.query(
            `SELECT EXISTS (SELECT 1 FROM financial_commitments WHERE kind = 'INCOME') AS exists`,
        );
        if (rows[0]?.exists)
            throw new Error(
                'CARD-012 rollback refused: income data must be preserved',
            );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "FK_obligations_receipt"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "CHK_obligations_origin_xor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ALTER COLUMN "disbursement_id" SET NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP COLUMN "receipt_id"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_income_command_receipts"`,
        );
        await queryRunner.query(`DROP TABLE "financial_receipts"`);
        await queryRunner.query(`DROP TABLE "financial_income_shares"`);
        await queryRunner.query(`DROP TABLE "financial_income_versions"`);
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" DROP CONSTRAINT "CHK_financial_commitments_scope"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" ADD CONSTRAINT "CHK_financial_commitments_scope" CHECK (kind = 'EXPENSE' AND modality = 'ONE_TIME' AND version > 0 AND length(description) BETWEEN 1 AND 160 AND description = btrim(description) AND (personal_owner_person_id IS NULL OR personal_owner_person_id = created_by))`,
        );
    }
}
