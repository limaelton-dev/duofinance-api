import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InstallmentAnticipations1792165500000 implements MigrationInterface {
    name = 'InstallmentAnticipations1792165500000';

    public async up(q: QueryRunner): Promise<void> {
        await q.query(`CREATE TABLE "financial_installment_anticipations" (
            "id" uuid NOT NULL,"space_id" uuid NOT NULL,"commitment_id" uuid NOT NULL,
            "installment_id" uuid NOT NULL,"fact_id" uuid NOT NULL,"due_date" date NOT NULL,
            "expected_remaining_amount_in_cents" bigint NOT NULL,"paid_amount_in_cents" bigint NOT NULL,
            "effective_amount_in_cents" bigint NOT NULL,"adjustment_in_cents" bigint NOT NULL,
            "economic_shares" jsonb,"fact_date" date NOT NULL,"registered_at" timestamptz NOT NULL,"actor_id" uuid NOT NULL,
            CONSTRAINT "PK_installment_anticipations" PRIMARY KEY ("id"),
            CONSTRAINT "UQ_installment_anticipation_origin" UNIQUE ("space_id","commitment_id","installment_id"),
            CONSTRAINT "UQ_installment_anticipation_fact" UNIQUE ("fact_id"),
            CONSTRAINT "CHK_installment_anticipation_values" CHECK (expected_remaining_amount_in_cents BETWEEN 1 AND 9007199254740991 AND paid_amount_in_cents BETWEEN 1 AND 9007199254740991 AND effective_amount_in_cents BETWEEN 1 AND 9007199254740991 AND adjustment_in_cents=paid_amount_in_cents-expected_remaining_amount_in_cents AND fact_date<due_date),
            CONSTRAINT "FK_installment_anticipation_installment" FOREIGN KEY ("space_id","commitment_id","installment_id") REFERENCES "financial_installments"("space_id","commitment_id","id") ON DELETE RESTRICT,
            CONSTRAINT "FK_installment_anticipation_fact" FOREIGN KEY ("space_id","commitment_id","fact_id") REFERENCES "financial_disbursements"("space_id","commitment_id","id") ON DELETE RESTRICT,
            CONSTRAINT "FK_installment_anticipation_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT
        )`);
        await q.query(
            `ALTER TABLE "financial_installment_command_receipts" DROP CONSTRAINT "CHK_installment_command_receipts", ADD CONSTRAINT "CHK_installment_command_receipts" CHECK (status='COMPLETED' AND octet_length(request_hash)=32 AND operation IN ('CREATE_INSTALLMENT_COMMITMENT','RECORD_INSTALLMENT_DISBURSEMENT','RECORD_INSTALLMENT_EXTERNAL_LIABILITY','SETTLE_INSTALLMENT_EXTERNAL_LIABILITY','ANTICIPATE_INSTALLMENTS'))`,
        );
    }

    public async down(q: QueryRunner): Promise<void> {
        const [row]: { present: boolean }[] = await q.query(
            `SELECT EXISTS(SELECT 1 FROM financial_installment_anticipations) OR EXISTS(SELECT 1 FROM financial_installment_command_receipts WHERE operation='ANTICIPATE_INSTALLMENTS') AS present`,
        );
        if (row.present)
            throw new Error(
                'Cannot revert installment anticipations while anticipated installments exist',
            );
        await q.query(
            `ALTER TABLE "financial_installment_command_receipts" DROP CONSTRAINT "CHK_installment_command_receipts", ADD CONSTRAINT "CHK_installment_command_receipts" CHECK (status='COMPLETED' AND octet_length(request_hash)=32 AND operation IN ('CREATE_INSTALLMENT_COMMITMENT','RECORD_INSTALLMENT_DISBURSEMENT','RECORD_INSTALLMENT_EXTERNAL_LIABILITY','SETTLE_INSTALLMENT_EXTERNAL_LIABILITY'))`,
        );
        await q.query(`DROP TABLE "financial_installment_anticipations"`);
    }
}
