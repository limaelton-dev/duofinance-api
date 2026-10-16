import type { MigrationInterface, QueryRunner } from 'typeorm';

export class VariableRecurringOccurrences1792165200000 implements MigrationInterface {
    name = 'VariableRecurringOccurrences1792165200000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_versions" ADD "value_mode" varchar(8) NOT NULL DEFAULT 'FIXED'`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_versions" ALTER COLUMN "amount_in_cents" DROP NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_versions" DROP CONSTRAINT "CHK_recurrence_versions_values", ADD CONSTRAINT "CHK_recurrence_versions_values" CHECK (version > 0 AND (amount_in_cents IS NULL OR amount_in_cents BETWEEN 1 AND 9007199254740991) AND value_mode IN ('FIXED','VARIABLE') AND (value_mode='VARIABLE' OR amount_in_cents IS NOT NULL) AND frequency IN ('MONTHLY','ANNUAL') AND day_of_month BETWEEN 1 AND 31 AND ((frequency='MONTHLY' AND month_of_year IS NULL) OR (frequency='ANNUAL' AND month_of_year BETWEEN 1 AND 12)) AND (ends_on IS NULL OR ends_on >= starts_on) AND ((owner_person_id IS NOT NULL AND split_input IS NULL AND expected_member_id IS NULL AND rule_snapshot IS NULL AND rule_source_version=0) OR (owner_person_id IS NULL AND split_input IS NOT NULL AND rule_source_version >= 0 AND (rule_snapshot IS NULL)=(rule_source_version=0) AND (value_mode='FIXED' OR split_input->>'mode'='PERCENTAGES'))))`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_occurrences" ALTER COLUMN "amount_in_cents" DROP NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_occurrences" DROP CONSTRAINT "CHK_financial_occurrences_state", ADD CONSTRAINT "CHK_financial_occurrences_state" CHECK (economic_version > 0 AND state_version > 0 AND (amount_in_cents IS NULL OR amount_in_cents BETWEEN 1 AND 9007199254740991) AND (amount_in_cents IS NOT NULL OR status IN ('PENDING','CANCELLED')) AND status IN ('PENDING','PARTIALLY_FULFILLED','FULFILLED','CANCELLED'))`,
        );
        await queryRunner.query(`CREATE TABLE "financial_occurrence_value_changes" (
            "occurrence_id" uuid NOT NULL,"version" integer NOT NULL,"space_id" uuid NOT NULL,"commitment_id" uuid NOT NULL,
            "previous_amount_in_cents" bigint,"amount_in_cents" bigint NOT NULL,"shares" jsonb,
            "actor_id" uuid NOT NULL,"registered_at" timestamptz NOT NULL,
            CONSTRAINT "PK_occurrence_value_changes" PRIMARY KEY ("occurrence_id","version"),
            CONSTRAINT "CHK_occurrence_value_changes" CHECK (version > 1 AND (previous_amount_in_cents IS NULL OR previous_amount_in_cents BETWEEN 1 AND 9007199254740991) AND amount_in_cents BETWEEN 1 AND 9007199254740991)
        )`);
        await queryRunner.query(
            `ALTER TABLE "financial_occurrence_value_changes" ADD CONSTRAINT "FK_occurrence_value_changes_occurrence" FOREIGN KEY ("space_id","commitment_id","occurrence_id") REFERENCES "financial_occurrences"("space_id","commitment_id","id") ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_occurrence_value_changes" ADD CONSTRAINT "FK_occurrence_value_changes_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT`,
        );
        await queryRunner.query(`CREATE TABLE "financial_occurrence_shares" (
            "occurrence_id" uuid NOT NULL,"member_id" uuid NOT NULL,"space_id" uuid NOT NULL,"commitment_id" uuid NOT NULL,
            "amount_in_cents" bigint NOT NULL,
            CONSTRAINT "PK_financial_occurrence_shares" PRIMARY KEY ("occurrence_id","member_id"),
            CONSTRAINT "CHK_financial_occurrence_shares" CHECK (amount_in_cents BETWEEN 0 AND 9007199254740991)
        )`);
        await queryRunner.query(
            `ALTER TABLE "financial_occurrence_shares" ADD CONSTRAINT "FK_occurrence_shares_occurrence" FOREIGN KEY ("space_id","commitment_id","occurrence_id") REFERENCES "financial_occurrences"("space_id","commitment_id","id") ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_occurrence_shares" ADD CONSTRAINT "FK_occurrence_shares_member" FOREIGN KEY ("space_id","member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_command_receipts" DROP CONSTRAINT "CHK_recurrence_command_receipts", ADD CONSTRAINT "CHK_recurrence_command_receipts" CHECK (status='COMPLETED' AND octet_length(request_hash)=32 AND operation IN ('CREATE_FIXED_RECURRING_COMMITMENT','CREATE_RECURRING_COMMITMENT','SET_RECURRING_OCCURRENCE_VALUE','RECORD_RECURRING_DISBURSEMENT','RECORD_RECURRING_RECEIPT','RECORD_RECURRING_EXTERNAL_LIABILITY','SETTLE_RECURRING_EXTERNAL_LIABILITY'))`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [row]: { present: boolean }[] = await queryRunner.query(
            `SELECT EXISTS(SELECT 1 FROM financial_recurrence_versions WHERE value_mode='VARIABLE') AS present`,
        );
        if (row.present)
            throw new Error('Variable commitments prevent schema rollback');
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_command_receipts" DROP CONSTRAINT "CHK_recurrence_command_receipts", ADD CONSTRAINT "CHK_recurrence_command_receipts" CHECK (status='COMPLETED' AND octet_length(request_hash)=32 AND operation IN ('CREATE_FIXED_RECURRING_COMMITMENT','CREATE_RECURRING_COMMITMENT','RECORD_RECURRING_DISBURSEMENT','RECORD_RECURRING_RECEIPT','RECORD_RECURRING_EXTERNAL_LIABILITY','SETTLE_RECURRING_EXTERNAL_LIABILITY'))`,
        );
        await queryRunner.query(`DROP TABLE "financial_occurrence_shares"`);
        await queryRunner.query(
            `DROP TABLE "financial_occurrence_value_changes"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_occurrences" DROP CONSTRAINT "CHK_financial_occurrences_state", ADD CONSTRAINT "CHK_financial_occurrences_state" CHECK (economic_version > 0 AND state_version > 0 AND amount_in_cents BETWEEN 1 AND 9007199254740991 AND status IN ('PENDING','PARTIALLY_FULFILLED','FULFILLED','CANCELLED'))`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_occurrences" ALTER COLUMN "amount_in_cents" SET NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_versions" DROP CONSTRAINT "CHK_recurrence_versions_values", ADD CONSTRAINT "CHK_recurrence_versions_values" CHECK (version > 0 AND amount_in_cents BETWEEN 1 AND 9007199254740991 AND frequency IN ('MONTHLY','ANNUAL') AND day_of_month BETWEEN 1 AND 31 AND ((frequency='MONTHLY' AND month_of_year IS NULL) OR (frequency='ANNUAL' AND month_of_year BETWEEN 1 AND 12)) AND (ends_on IS NULL OR ends_on >= starts_on) AND ((owner_person_id IS NOT NULL AND split_input IS NULL AND expected_member_id IS NULL AND rule_snapshot IS NULL AND rule_source_version=0) OR (owner_person_id IS NULL AND split_input IS NOT NULL AND rule_source_version >= 0 AND (rule_snapshot IS NULL)=(rule_source_version=0))))`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_versions" ALTER COLUMN "amount_in_cents" SET NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_versions" DROP COLUMN "value_mode"`,
        );
    }
}
