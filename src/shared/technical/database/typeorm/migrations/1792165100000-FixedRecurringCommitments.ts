import type { MigrationInterface, QueryRunner } from 'typeorm';

export class FixedRecurringCommitments1792165100000 implements MigrationInterface {
    name = 'FixedRecurringCommitments1792165100000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" DROP CONSTRAINT "CHK_financial_commitments_scope", ADD CONSTRAINT "CHK_financial_commitments_scope" CHECK (kind IN ('EXPENSE','INCOME') AND modality IN ('ONE_TIME','RECURRING') AND version > 0 AND length(description) BETWEEN 1 AND 160 AND description = btrim(description) AND (personal_owner_person_id IS NULL OR personal_owner_person_id = created_by))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_recurrence_versions" (
                "commitment_id" uuid NOT NULL,"version" integer NOT NULL,"space_id" uuid NOT NULL,
                "amount_in_cents" bigint NOT NULL,"frequency" varchar(8) NOT NULL,"day_of_month" integer NOT NULL,
                "month_of_year" integer,"starts_on" date NOT NULL,"ends_on" date,"owner_person_id" uuid,
                "split_input" jsonb,"expected_member_id" uuid,"rule_snapshot" jsonb,
                "rule_source_version" integer NOT NULL,"registered_at" timestamptz NOT NULL,
                CONSTRAINT "PK_financial_recurrence_versions" PRIMARY KEY ("commitment_id","version"),
                CONSTRAINT "UQ_recurrence_versions_space" UNIQUE ("space_id","commitment_id","version"),
                CONSTRAINT "CHK_recurrence_versions_values" CHECK (version > 0 AND amount_in_cents BETWEEN 1 AND 9007199254740991 AND frequency IN ('MONTHLY','ANNUAL') AND day_of_month BETWEEN 1 AND 31 AND ((frequency='MONTHLY' AND month_of_year IS NULL) OR (frequency='ANNUAL' AND month_of_year BETWEEN 1 AND 12)) AND (ends_on IS NULL OR ends_on >= starts_on) AND ((owner_person_id IS NOT NULL AND split_input IS NULL AND expected_member_id IS NULL AND rule_snapshot IS NULL AND rule_source_version=0) OR (owner_person_id IS NULL AND split_input IS NOT NULL AND rule_source_version >= 0 AND (rule_snapshot IS NULL)=(rule_source_version=0))))
            )`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_versions" ADD CONSTRAINT "FK_recurrence_versions_commitment" FOREIGN KEY ("space_id","commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_versions" ADD CONSTRAINT "FK_recurrence_versions_owner" FOREIGN KEY ("owner_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_versions" ADD CONSTRAINT "FK_recurrence_versions_expected_member" FOREIGN KEY ("space_id","expected_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_recurrence_shares" (
                "commitment_id" uuid NOT NULL,"version" integer NOT NULL,"member_id" uuid NOT NULL,
                "space_id" uuid NOT NULL,"amount_in_cents" bigint NOT NULL,
                CONSTRAINT "PK_financial_recurrence_shares" PRIMARY KEY ("commitment_id","version","member_id"),
                CONSTRAINT "CHK_recurrence_shares_values" CHECK (amount_in_cents BETWEEN 0 AND 9007199254740991)
            )`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_shares" ADD CONSTRAINT "FK_recurrence_shares_version" FOREIGN KEY ("space_id","commitment_id","version") REFERENCES "financial_recurrence_versions"("space_id","commitment_id","version") ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_shares" ADD CONSTRAINT "FK_recurrence_shares_member" FOREIGN KEY ("space_id","member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_occurrences" (
                "id" uuid NOT NULL,"space_id" uuid NOT NULL,"commitment_id" uuid NOT NULL,
                "reference_date" date NOT NULL,"economic_version" integer NOT NULL,"state_version" integer NOT NULL,
                "amount_in_cents" bigint NOT NULL,"status" varchar(24) NOT NULL,"materialized_at" timestamptz NOT NULL,
                CONSTRAINT "PK_financial_occurrences" PRIMARY KEY ("id"),
                CONSTRAINT "UQ_financial_occurrences_date" UNIQUE ("space_id","commitment_id","reference_date"),
                CONSTRAINT "UQ_financial_occurrences_origin" UNIQUE ("space_id","commitment_id","id"),
                CONSTRAINT "CHK_financial_occurrences_state" CHECK (economic_version > 0 AND state_version > 0 AND amount_in_cents BETWEEN 1 AND 9007199254740991 AND status IN ('PENDING','PARTIALLY_FULFILLED','FULFILLED','CANCELLED'))
            )`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_financial_occurrences_space_date" ON "financial_occurrences" ("space_id","reference_date","id")`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_occurrences" ADD CONSTRAINT "FK_financial_occurrences_version" FOREIGN KEY ("space_id","commitment_id","economic_version") REFERENCES "financial_recurrence_versions"("space_id","commitment_id","version") ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_recurrence_command_receipts" (
                "actor_id" uuid NOT NULL,"operation" varchar(40) NOT NULL,"idempotency_key" uuid NOT NULL,
                "request_hash" bytea NOT NULL,"status" varchar(16) NOT NULL,"space_id" uuid NOT NULL,
                "commitment_id" uuid NOT NULL,"occurrence_id" uuid,"result" jsonb NOT NULL,"created_at" timestamptz NOT NULL,
                CONSTRAINT "PK_financial_recurrence_command_receipts" PRIMARY KEY ("actor_id","operation","idempotency_key"),
                CONSTRAINT "CHK_recurrence_command_receipts" CHECK (status='COMPLETED' AND octet_length(request_hash)=32 AND operation IN ('CREATE_FIXED_RECURRING_COMMITMENT','RECORD_RECURRING_DISBURSEMENT','RECORD_RECURRING_RECEIPT','RECORD_RECURRING_EXTERNAL_LIABILITY','SETTLE_RECURRING_EXTERNAL_LIABILITY'))
            )`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_command_receipts" ADD CONSTRAINT "FK_recurrence_receipts_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_command_receipts" ADD CONSTRAINT "FK_recurrence_receipts_commitment" FOREIGN KEY ("space_id","commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_command_receipts" ADD CONSTRAINT "FK_recurrence_receipts_occurrence" FOREIGN KEY ("space_id","commitment_id","occurrence_id") REFERENCES "financial_occurrences"("space_id","commitment_id","id") ON DELETE RESTRICT`,
        );
        for (const [table, oldConstraint, newConstraint] of [
            [
                'financial_disbursements',
                'FK_financial_disbursements_version',
                'FK_financial_disbursements_commitment',
            ],
            [
                'financial_external_liabilities',
                'FK_external_liabilities_version',
                'FK_external_liabilities_commitment',
            ],
            [
                'financial_receipts',
                'FK_financial_receipts_income',
                'FK_financial_receipts_commitment',
            ],
        ]) {
            await queryRunner.query(
                `ALTER TABLE "${table}" ADD "occurrence_id" uuid`,
            );
            await queryRunner.query(
                `ALTER TABLE "${table}" DROP CONSTRAINT "${oldConstraint}"`,
            );
            await queryRunner.query(
                `ALTER TABLE "${table}" ADD CONSTRAINT "${newConstraint}" FOREIGN KEY ("space_id","commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT`,
            );
            await queryRunner.query(
                `ALTER TABLE "${table}" ADD CONSTRAINT "FK_${table}_occurrence" FOREIGN KEY ("space_id","commitment_id","occurrence_id") REFERENCES "financial_occurrences"("space_id","commitment_id","id") ON DELETE RESTRICT`,
            );
            await queryRunner.query(
                `CREATE INDEX "IDX_${table}_occurrence" ON "${table}" ("space_id","occurrence_id") WHERE occurrence_id IS NOT NULL`,
            );
        }
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD "occurrence_id" uuid`,
        );
        await queryRunner.query(`DROP INDEX "UQ_obligations_open_origin"`);
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_obligations_open_one_time" ON "inter_member_obligations" ("space_id","commitment_id") WHERE remaining_amount_in_cents > 0 AND occurrence_id IS NULL`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_obligations_open_occurrence" ON "inter_member_obligations" ("space_id","occurrence_id") WHERE remaining_amount_in_cents > 0 AND occurrence_id IS NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "FK_obligations_occurrence" FOREIGN KEY ("space_id","commitment_id","occurrence_id") REFERENCES "financial_occurrences"("space_id","commitment_id","id") ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liability_settlements" ALTER COLUMN "receipt_operation" DROP NOT NULL, ALTER COLUMN "idempotency_key" DROP NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liability_settlements" DROP CONSTRAINT "CHK_external_settlement_values", ADD CONSTRAINT "CHK_external_settlement_values" CHECK (amount_in_cents BETWEEN 1 AND 9007199254740991 AND sequence > 1 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND num_nonnulls(holder_member_id,holder_person_id)=1 AND ((receipt_operation='SETTLE_EXTERNAL_LIABILITY' AND idempotency_key IS NOT NULL) OR (receipt_operation IS NULL AND idempotency_key IS NULL)))`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [row]: { present: boolean }[] = await queryRunner.query(
            `SELECT EXISTS(SELECT 1 FROM financial_commitments WHERE modality='RECURRING') AS present`,
        );
        if (row.present)
            throw new Error('Recurring commitments prevent schema rollback');
        await queryRunner.query(
            `ALTER TABLE "financial_external_liability_settlements" DROP CONSTRAINT "CHK_external_settlement_values", ADD CONSTRAINT "CHK_external_settlement_values" CHECK (amount_in_cents BETWEEN 1 AND 9007199254740991 AND sequence > 1 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND num_nonnulls(holder_member_id,holder_person_id)=1 AND receipt_operation='SETTLE_EXTERNAL_LIABILITY')`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liability_settlements" ALTER COLUMN "receipt_operation" SET NOT NULL, ALTER COLUMN "idempotency_key" SET NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "FK_obligations_occurrence"`,
        );
        await queryRunner.query(`DROP INDEX "UQ_obligations_open_occurrence"`);
        await queryRunner.query(`DROP INDEX "UQ_obligations_open_one_time"`);
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_obligations_open_origin" ON "inter_member_obligations" ("space_id","commitment_id") WHERE remaining_amount_in_cents > 0`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP COLUMN "occurrence_id"`,
        );
        for (const [table, oldConstraint, newConstraint] of [
            [
                'financial_disbursements',
                'FK_financial_disbursements_version',
                'FK_financial_disbursements_commitment',
            ],
            [
                'financial_external_liabilities',
                'FK_external_liabilities_version',
                'FK_external_liabilities_commitment',
            ],
            [
                'financial_receipts',
                'FK_financial_receipts_income',
                'FK_financial_receipts_commitment',
            ],
        ]) {
            await queryRunner.query(`DROP INDEX "IDX_${table}_occurrence"`);
            await queryRunner.query(
                `ALTER TABLE "${table}" DROP CONSTRAINT "FK_${table}_occurrence"`,
            );
            await queryRunner.query(
                `ALTER TABLE "${table}" DROP CONSTRAINT "${newConstraint}"`,
            );
            await queryRunner.query(
                `ALTER TABLE "${table}" DROP COLUMN "occurrence_id"`,
            );
            const target =
                table === 'financial_receipts'
                    ? 'financial_income_versions'
                    : 'financial_commitment_versions';
            const columns =
                table === 'financial_receipts'
                    ? '"space_id","commitment_id"'
                    : '"space_id","commitment_id","version"';
            await queryRunner.query(
                `ALTER TABLE "${table}" ADD CONSTRAINT "${oldConstraint}" FOREIGN KEY (${columns}) REFERENCES "${target}"(${columns}) ON DELETE RESTRICT`,
            );
        }
        await queryRunner.query(
            `ALTER TABLE "financial_occurrences" DROP CONSTRAINT "FK_financial_occurrences_version"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_recurrence_command_receipts"`,
        );
        await queryRunner.query(`DROP TABLE "financial_occurrences"`);
        await queryRunner.query(`DROP TABLE "financial_recurrence_shares"`);
        await queryRunner.query(`DROP TABLE "financial_recurrence_versions"`);
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" DROP CONSTRAINT "CHK_financial_commitments_scope", ADD CONSTRAINT "CHK_financial_commitments_scope" CHECK (kind IN ('EXPENSE','INCOME') AND modality = 'ONE_TIME' AND version > 0 AND length(description) BETWEEN 1 AND 160 AND description = btrim(description) AND (personal_owner_person_id IS NULL OR personal_owner_person_id = created_by))`,
        );
    }
}
