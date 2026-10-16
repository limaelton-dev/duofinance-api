import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RecurringMaintenance1792165300000 implements MigrationInterface {
    name = 'RecurringMaintenance1792165300000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_versions" ADD "effective_from" date NOT NULL, ADD "description" varchar(160) NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_versions" ADD CONSTRAINT "UQ_recurrence_versions_effective" UNIQUE ("space_id","commitment_id","effective_from")`,
        );
        await queryRunner.query(`CREATE TABLE "financial_recurrence_terminations" (
            "space_id" uuid NOT NULL,"commitment_id" uuid NOT NULL,"ends_on" date NOT NULL,
            "actor_id" uuid NOT NULL,"registered_at" timestamptz NOT NULL,"commitment_version" integer NOT NULL,
            CONSTRAINT "PK_recurrence_terminations" PRIMARY KEY ("commitment_id"),
            CONSTRAINT "FK_recurrence_terminations_commitment" FOREIGN KEY ("space_id","commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT,
            CONSTRAINT "FK_recurrence_terminations_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT
        )`);
        await queryRunner.query(`CREATE TABLE "financial_occurrence_cancellations" (
            "occurrence_id" uuid NOT NULL,"space_id" uuid NOT NULL,"commitment_id" uuid NOT NULL,
            "actor_id" uuid NOT NULL,"registered_at" timestamptz NOT NULL,
            CONSTRAINT "PK_occurrence_cancellations" PRIMARY KEY ("occurrence_id"),
            CONSTRAINT "FK_occurrence_cancellations_occurrence" FOREIGN KEY ("space_id","commitment_id","occurrence_id") REFERENCES "financial_occurrences"("space_id","commitment_id","id") ON DELETE RESTRICT,
            CONSTRAINT "FK_occurrence_cancellations_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT
        )`);
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_command_receipts" DROP CONSTRAINT "CHK_recurrence_command_receipts", ADD CONSTRAINT "CHK_recurrence_command_receipts" CHECK (status='COMPLETED' AND octet_length(request_hash)=32 AND operation IN ('CREATE_FIXED_RECURRING_COMMITMENT','CREATE_RECURRING_COMMITMENT','SET_RECURRING_OCCURRENCE_VALUE','RECORD_RECURRING_DISBURSEMENT','RECORD_RECURRING_RECEIPT','RECORD_RECURRING_EXTERNAL_LIABILITY','SETTLE_RECURRING_EXTERNAL_LIABILITY','CHANGE_RECURRING_COMMITMENT','TERMINATE_RECURRING_COMMITMENT','CANCEL_RECURRING_OCCURRENCE'))`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_command_receipts" DROP CONSTRAINT "CHK_recurrence_command_receipts", ADD CONSTRAINT "CHK_recurrence_command_receipts" CHECK (status='COMPLETED' AND octet_length(request_hash)=32 AND operation IN ('CREATE_FIXED_RECURRING_COMMITMENT','CREATE_RECURRING_COMMITMENT','SET_RECURRING_OCCURRENCE_VALUE','RECORD_RECURRING_DISBURSEMENT','RECORD_RECURRING_RECEIPT','RECORD_RECURRING_EXTERNAL_LIABILITY','SETTLE_RECURRING_EXTERNAL_LIABILITY'))`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_occurrence_cancellations"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_recurrence_terminations"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_versions" DROP CONSTRAINT "UQ_recurrence_versions_effective", DROP COLUMN "description", DROP COLUMN "effective_from"`,
        );
    }
}
