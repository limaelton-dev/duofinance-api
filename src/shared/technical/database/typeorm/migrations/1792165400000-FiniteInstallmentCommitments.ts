import type { MigrationInterface, QueryRunner } from 'typeorm';

export class FiniteInstallmentCommitments1792165400000 implements MigrationInterface {
    name = 'FiniteInstallmentCommitments1792165400000';

    public async up(q: QueryRunner): Promise<void> {
        await q.query(
            `ALTER TABLE "financial_commitments" DROP CONSTRAINT "CHK_financial_commitments_scope", ADD CONSTRAINT "CHK_financial_commitments_scope" CHECK (kind IN ('EXPENSE','INCOME') AND modality IN ('ONE_TIME','RECURRING','INSTALLMENT') AND version > 0 AND length(description) BETWEEN 1 AND 160 AND description = btrim(description) AND (personal_owner_person_id IS NULL OR personal_owner_person_id = created_by))`,
        );
        await q.query(`CREATE TABLE "financial_installment_plans" (
            "id" uuid NOT NULL,"space_id" uuid NOT NULL,"commitment_id" uuid NOT NULL,
            "installment_count" integer NOT NULL,"total_amount_in_cents" bigint NOT NULL,
            "cadence" varchar(8) NOT NULL,"planned_payment_method" varchar(8),
            "split_input" jsonb,"expected_member_id" uuid,"rule_snapshot" jsonb,
            "rule_source_version" integer NOT NULL,"registered_at" timestamptz NOT NULL,
            CONSTRAINT "PK_installment_plans" PRIMARY KEY ("id"),
            CONSTRAINT "UQ_installment_plans_origin" UNIQUE ("space_id","commitment_id","id"),
            CONSTRAINT "UQ_installment_plans_commitment" UNIQUE ("space_id","commitment_id"),
            CONSTRAINT "CHK_installment_plans_values" CHECK (installment_count > 0 AND total_amount_in_cents BETWEEN 1 AND 9007199254740991 AND cadence IN ('MONTHLY','ANNUAL','EXPLICIT') AND (planned_payment_method IS NULL OR planned_payment_method IN ('CARD','PIX','DEBIT','CASH')) AND rule_source_version >= 0 AND (rule_snapshot IS NULL)=(rule_source_version=0) AND ((split_input IS NULL AND expected_member_id IS NULL) OR split_input IS NOT NULL)),
            CONSTRAINT "FK_installment_plans_commitment" FOREIGN KEY ("space_id","commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT,
            CONSTRAINT "FK_installment_plans_expected_member" FOREIGN KEY ("space_id","expected_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT
        )`);
        await q.query(`CREATE TABLE "financial_installments" (
            "id" uuid NOT NULL,"space_id" uuid NOT NULL,"commitment_id" uuid NOT NULL,
            "plan_id" uuid NOT NULL,"position" integer NOT NULL,"due_date" date NOT NULL,
            "amount_in_cents" bigint NOT NULL,
            CONSTRAINT "PK_financial_installments" PRIMARY KEY ("id"),
            CONSTRAINT "UQ_installments_origin" UNIQUE ("space_id","commitment_id","id"),
            CONSTRAINT "UQ_installments_position" UNIQUE ("plan_id","position"),
            CONSTRAINT "UQ_installments_due_date" UNIQUE ("plan_id","due_date"),
            CONSTRAINT "CHK_installments_values" CHECK (position > 0 AND amount_in_cents BETWEEN 1 AND 9007199254740991),
            CONSTRAINT "FK_installments_plan" FOREIGN KEY ("space_id","commitment_id","plan_id") REFERENCES "financial_installment_plans"("space_id","commitment_id","id") ON DELETE RESTRICT
        )`);
        await q.query(
            `CREATE INDEX "IDX_installments_space_due" ON "financial_installments" ("space_id","due_date","id")`,
        );
        await q.query(`CREATE TABLE "financial_installment_shares" (
            "installment_id" uuid NOT NULL,"member_id" uuid NOT NULL,"space_id" uuid NOT NULL,
            "commitment_id" uuid NOT NULL,"amount_in_cents" bigint NOT NULL,
            CONSTRAINT "PK_installment_shares" PRIMARY KEY ("installment_id","member_id"),
            CONSTRAINT "CHK_installment_shares_values" CHECK (amount_in_cents BETWEEN 0 AND 9007199254740991),
            CONSTRAINT "FK_installment_shares_installment" FOREIGN KEY ("space_id","commitment_id","installment_id") REFERENCES "financial_installments"("space_id","commitment_id","id") ON DELETE RESTRICT,
            CONSTRAINT "FK_installment_shares_member" FOREIGN KEY ("space_id","member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT
        )`);
        await q.query(
            `ALTER TABLE "financial_occurrences" ALTER COLUMN "economic_version" DROP NOT NULL, ADD "installment_id" uuid`,
        );
        await q.query(
            `ALTER TABLE "financial_occurrences" DROP CONSTRAINT "CHK_financial_occurrences_state", ADD CONSTRAINT "CHK_financial_occurrences_state" CHECK (((economic_version IS NOT NULL AND economic_version > 0 AND installment_id IS NULL) OR (economic_version IS NULL AND installment_id IS NOT NULL AND amount_in_cents IS NOT NULL)) AND state_version > 0 AND (amount_in_cents IS NULL OR amount_in_cents BETWEEN 1 AND 9007199254740991) AND (amount_in_cents IS NOT NULL OR status IN ('PENDING','CANCELLED')) AND status IN ('PENDING','PARTIALLY_FULFILLED','FULFILLED','CANCELLED'))`,
        );
        await q.query(
            `ALTER TABLE "financial_occurrences" ADD CONSTRAINT "UQ_financial_occurrences_installment" UNIQUE ("installment_id"), ADD CONSTRAINT "FK_financial_occurrences_installment" FOREIGN KEY ("space_id","commitment_id","installment_id") REFERENCES "financial_installments"("space_id","commitment_id","id") ON DELETE RESTRICT`,
        );
        await q.query(`CREATE TABLE "financial_installment_command_receipts" (
            "actor_id" uuid NOT NULL,"operation" varchar(48) NOT NULL,"idempotency_key" uuid NOT NULL,
            "request_hash" bytea NOT NULL,"status" varchar(16) NOT NULL,"space_id" uuid NOT NULL,
            "commitment_id" uuid NOT NULL,"installment_id" uuid,"result" jsonb NOT NULL,"created_at" timestamptz NOT NULL,
            CONSTRAINT "PK_installment_receipts" PRIMARY KEY ("actor_id","operation","idempotency_key"),
            CONSTRAINT "CHK_installment_command_receipts" CHECK (status='COMPLETED' AND octet_length(request_hash)=32 AND operation IN ('CREATE_INSTALLMENT_COMMITMENT','RECORD_INSTALLMENT_DISBURSEMENT','RECORD_INSTALLMENT_EXTERNAL_LIABILITY','SETTLE_INSTALLMENT_EXTERNAL_LIABILITY')),
            CONSTRAINT "FK_installment_receipts_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT,
            CONSTRAINT "FK_installment_receipts_commitment" FOREIGN KEY ("space_id","commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT,
            CONSTRAINT "FK_installment_receipts_installment" FOREIGN KEY ("space_id","commitment_id","installment_id") REFERENCES "financial_installments"("space_id","commitment_id","id") ON DELETE RESTRICT
        )`);
    }

    public async down(q: QueryRunner): Promise<void> {
        const [row]: { realized: boolean }[] = await q.query(
            `SELECT EXISTS(
                SELECT 1 FROM financial_commitments c
                WHERE c.modality='INSTALLMENT' AND (
                    EXISTS(SELECT 1 FROM financial_disbursements d WHERE d.commitment_id=c.id) OR
                    EXISTS(SELECT 1 FROM financial_external_liabilities l WHERE l.commitment_id=c.id) OR
                    EXISTS(SELECT 1 FROM inter_member_obligations o WHERE o.commitment_id=c.id)
                )
            ) AS realized`,
        );
        if (row.realized)
            throw new Error(
                'Cannot revert installment commitments while realized installments exist',
            );
        await q.query(`DROP TABLE "financial_installment_command_receipts"`);
        await q.query(
            `DELETE FROM "financial_command_audit" a USING "financial_commitments" c WHERE a.commitment_id=c.id AND c.modality='INSTALLMENT'`,
        );
        await q.query(
            `DELETE FROM "financial_occurrences" o USING "financial_commitments" c WHERE o.commitment_id=c.id AND c.modality='INSTALLMENT'`,
        );
        await q.query(
            `ALTER TABLE "financial_occurrences" DROP CONSTRAINT "FK_financial_occurrences_installment", DROP CONSTRAINT "UQ_financial_occurrences_installment", DROP CONSTRAINT "CHK_financial_occurrences_state", DROP COLUMN "installment_id"`,
        );
        await q.query(
            `ALTER TABLE "financial_occurrences" ALTER COLUMN "economic_version" SET NOT NULL, ADD CONSTRAINT "CHK_financial_occurrences_state" CHECK (economic_version > 0 AND state_version > 0 AND (amount_in_cents IS NULL OR amount_in_cents BETWEEN 1 AND 9007199254740991) AND (amount_in_cents IS NOT NULL OR status IN ('PENDING','CANCELLED')) AND status IN ('PENDING','PARTIALLY_FULFILLED','FULFILLED','CANCELLED'))`,
        );
        await q.query(`DROP TABLE "financial_installment_shares"`);
        await q.query(`DROP INDEX "IDX_installments_space_due"`);
        await q.query(`DROP TABLE "financial_installments"`);
        await q.query(`DROP TABLE "financial_installment_plans"`);
        await q.query(
            `DELETE FROM "financial_commitments" WHERE modality='INSTALLMENT'`,
        );
        await q.query(
            `ALTER TABLE "financial_commitments" DROP CONSTRAINT "CHK_financial_commitments_scope", ADD CONSTRAINT "CHK_financial_commitments_scope" CHECK (kind IN ('EXPENSE','INCOME') AND modality IN ('ONE_TIME','RECURRING') AND version > 0 AND length(description) BETWEEN 1 AND 160 AND description = btrim(description) AND (personal_owner_person_id IS NULL OR personal_owner_person_id = created_by))`,
        );
    }
}
