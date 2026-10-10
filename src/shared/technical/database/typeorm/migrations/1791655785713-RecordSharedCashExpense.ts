import { MigrationInterface, QueryRunner } from 'typeorm';

export class RecordSharedCashExpense1791655785713 implements MigrationInterface {
    name = 'RecordSharedCashExpense1791655785713';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE "financial_commitments" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "kind" character varying(16) NOT NULL, "modality" character varying(16) NOT NULL, "description" character varying(160) NOT NULL, "created_by" uuid NOT NULL, "version" integer NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_financial_commitments_space_id" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_financial_commitments_scope" CHECK (kind = 'EXPENSE' AND modality = 'ONE_TIME' AND version > 0 AND length(description) BETWEEN 1 AND 160 AND description = btrim(description)), CONSTRAINT "PK_ec16b836a513083006ee92bb919" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_financial_commitments_space_registered" ON "financial_commitments"  ("space_id", "registered_at", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_commitment_versions" ("commitment_id" uuid NOT NULL, "version" integer NOT NULL, "space_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, "expected_payer_member_id" uuid NOT NULL, "fact_date" date NOT NULL, "split_mode" character varying(16) NOT NULL, "split_input" jsonb NOT NULL, "rule_snapshot" jsonb, "rule_source_version" integer NOT NULL, "suggested_target_date" date, CONSTRAINT "UQ_financial_versions_space" UNIQUE ("space_id", "commitment_id", "version"), CONSTRAINT "CHK_financial_versions_values" CHECK ("amount_in_cents" >= 1 AND "amount_in_cents" <= 9007199254740991 AND version = 1 AND split_mode IN ('AMOUNTS','PERCENTAGES') AND rule_source_version >= 0 AND (rule_snapshot IS NULL) = (rule_source_version = 0) AND (suggested_target_date IS NULL OR rule_snapshot IS NOT NULL)), CONSTRAINT "PK_84c12685a2edbc990c30df40422" PRIMARY KEY ("commitment_id", "version"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_commitment_shares" ("commitment_id" uuid NOT NULL, "version" integer NOT NULL, "member_id" uuid NOT NULL, "space_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, "split_mode" character varying(16) NOT NULL, "original_amount_in_cents" bigint, "basis_points" integer, CONSTRAINT "CHK_financial_shares_values" CHECK ("amount_in_cents" >= 0 AND "amount_in_cents" <= 9007199254740991 AND ((split_mode = 'AMOUNTS' AND original_amount_in_cents IS NOT NULL AND original_amount_in_cents = amount_in_cents AND basis_points IS NULL) OR (split_mode = 'PERCENTAGES' AND original_amount_in_cents IS NULL AND basis_points IS NOT NULL AND basis_points BETWEEN 0 AND 10000))), CONSTRAINT "PK_fe330172ddbfc1beb57fb732487" PRIMARY KEY ("commitment_id", "version", "member_id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_disbursements" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "version" integer NOT NULL, "payer_member_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, "method" character varying(8) NOT NULL, "fact_date" date NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_financial_disbursements_origin" UNIQUE ("space_id", "commitment_id", "id"), CONSTRAINT "UQ_financial_disbursements_commitment" UNIQUE ("commitment_id"), CONSTRAINT "CHK_financial_disbursements_values" CHECK ("amount_in_cents" >= 1 AND "amount_in_cents" <= 9007199254740991 AND method IN ('PIX','DEBIT','CASH') AND version = 1 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date), CONSTRAINT "PK_7c6e756a33ad009770ab3ba506b" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "settlement_cycles" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "target_date" date NOT NULL, "status" character varying(16) NOT NULL, "version" integer NOT NULL, "finalized_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_settlement_cycles_space_id" UNIQUE ("space_id", "id"), CONSTRAINT "UQ_settlement_cycles_space_date" UNIQUE ("space_id", "target_date"), CONSTRAINT "CHK_settlement_cycles_state" CHECK (version > 0 AND ((status = 'OPEN' AND finalized_at IS NULL) OR (status = 'FINALIZED' AND finalized_at IS NOT NULL))), CONSTRAINT "PK_7e0d542d0bd8221433e210b92b1" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_settlement_cycles_open" ON "settlement_cycles"  ("space_id", "status", "target_date", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "inter_member_obligations" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "disbursement_id" uuid NOT NULL, "debtor_member_id" uuid NOT NULL, "creditor_member_id" uuid NOT NULL, "original_amount_in_cents" bigint NOT NULL, "remaining_amount_in_cents" bigint NOT NULL, "status" character varying(16) NOT NULL, "cycle_id" uuid, "version" integer NOT NULL, "fact_date" date NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_obligations_origin_direction" UNIQUE ("commitment_id", "debtor_member_id", "creditor_member_id"), CONSTRAINT "UQ_obligations_space_id" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_obligations_initial_state" CHECK ("original_amount_in_cents" >= 1 AND "original_amount_in_cents" <= 9007199254740991 AND "remaining_amount_in_cents" >= 0 AND "remaining_amount_in_cents" <= 9007199254740991 AND remaining_amount_in_cents <= original_amount_in_cents AND debtor_member_id <> creditor_member_id AND status = 'OPEN' AND version > 0 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date), CONSTRAINT "PK_a3f35f0eacff91c7440c49527ec" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_obligations_space_cycle" ON "inter_member_obligations"  ("space_id", "cycle_id") `,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_obligations_space_origin" ON "inter_member_obligations"  ("space_id", "commitment_id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "inter_member_obligation_changes" ("obligation_id" uuid NOT NULL, "version" integer NOT NULL, "space_id" uuid NOT NULL, "actor_id" uuid NOT NULL, "type" character varying(16) NOT NULL, "snapshot" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_obligation_changes_initial" CHECK (version = 1 AND type = 'CREATED'), CONSTRAINT "PK_626e767d3e35ca7b2d290ec7e02" PRIMARY KEY ("obligation_id", "version"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_expense_command_receipts" ("actor_id" uuid NOT NULL, "operation" character varying(40) NOT NULL, "idempotency_key" uuid NOT NULL, "request_hash" bytea NOT NULL, "status" character varying(16) NOT NULL, "commitment_id" uuid NOT NULL, "result" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_expense_receipt" CHECK (operation = 'RECORD_SHARED_CASH_EXPENSE' AND status = 'COMPLETED' AND octet_length(request_hash) = 32), CONSTRAINT "PK_12cb2fc5905ff45de68ddff62a5" PRIMARY KEY ("actor_id", "operation", "idempotency_key"))`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_members" ADD CONSTRAINT "UQ_space_members_space_id" UNIQUE ("space_id", "id")`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" ADD CONSTRAINT "FK_financial_commitments_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" ADD CONSTRAINT "FK_financial_commitments_author" FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" ADD CONSTRAINT "FK_financial_versions_expected_payer" FOREIGN KEY ("space_id", "expected_payer_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" ADD CONSTRAINT "FK_financial_versions_commitment" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_shares" ADD CONSTRAINT "FK_financial_shares_member" FOREIGN KEY ("space_id", "member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_shares" ADD CONSTRAINT "FK_financial_shares_version" FOREIGN KEY ("space_id", "commitment_id", "version") REFERENCES "financial_commitment_versions"("space_id","commitment_id","version") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" ADD CONSTRAINT "FK_financial_disbursements_payer" FOREIGN KEY ("space_id", "payer_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" ADD CONSTRAINT "FK_financial_disbursements_version" FOREIGN KEY ("space_id", "commitment_id", "version") REFERENCES "financial_commitment_versions"("space_id","commitment_id","version") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_cycles" ADD CONSTRAINT "FK_settlement_cycles_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "FK_obligations_cycle" FOREIGN KEY ("space_id", "cycle_id") REFERENCES "settlement_cycles"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "FK_obligations_creditor" FOREIGN KEY ("space_id", "creditor_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "FK_obligations_debtor" FOREIGN KEY ("space_id", "debtor_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "FK_obligations_origin" FOREIGN KEY ("space_id", "commitment_id", "disbursement_id") REFERENCES "financial_disbursements"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligation_changes" ADD CONSTRAINT "FK_obligation_changes_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligation_changes" ADD CONSTRAINT "FK_obligation_changes_obligation" FOREIGN KEY ("space_id", "obligation_id") REFERENCES "inter_member_obligations"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_expense_command_receipts" ADD CONSTRAINT "FK_expense_receipts_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_expense_command_receipts" ADD CONSTRAINT "FK_expense_receipts_commitment" FOREIGN KEY ("commitment_id") REFERENCES "financial_commitments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "financial_expense_command_receipts" DROP CONSTRAINT "FK_expense_receipts_commitment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_expense_command_receipts" DROP CONSTRAINT "FK_expense_receipts_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligation_changes" DROP CONSTRAINT "FK_obligation_changes_obligation"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligation_changes" DROP CONSTRAINT "FK_obligation_changes_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "FK_obligations_origin"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "FK_obligations_debtor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "FK_obligations_creditor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "FK_obligations_cycle"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_cycles" DROP CONSTRAINT "FK_settlement_cycles_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" DROP CONSTRAINT "FK_financial_disbursements_version"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" DROP CONSTRAINT "FK_financial_disbursements_payer"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_shares" DROP CONSTRAINT "FK_financial_shares_version"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_shares" DROP CONSTRAINT "FK_financial_shares_member"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" DROP CONSTRAINT "FK_financial_versions_commitment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" DROP CONSTRAINT "FK_financial_versions_expected_payer"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" DROP CONSTRAINT "FK_financial_commitments_author"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" DROP CONSTRAINT "FK_financial_commitments_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_members" DROP CONSTRAINT "UQ_space_members_space_id"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_expense_command_receipts"`,
        );
        await queryRunner.query(`DROP TABLE "inter_member_obligation_changes"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_obligations_space_origin"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_obligations_space_cycle"`,
        );
        await queryRunner.query(`DROP TABLE "inter_member_obligations"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_settlement_cycles_open"`,
        );
        await queryRunner.query(`DROP TABLE "settlement_cycles"`);
        await queryRunner.query(`DROP TABLE "financial_disbursements"`);
        await queryRunner.query(`DROP TABLE "financial_commitment_shares"`);
        await queryRunner.query(`DROP TABLE "financial_commitment_versions"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_financial_commitments_space_registered"`,
        );
        await queryRunner.query(`DROP TABLE "financial_commitments"`);
    }
}
