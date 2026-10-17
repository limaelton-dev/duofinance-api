import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InstallmentResolutions1792165600000 implements MigrationInterface {
    name = 'InstallmentResolutions1792165600000';

    public async up(q: QueryRunner): Promise<void> {
        await q.query(`CREATE TABLE "financial_installment_payoffs" (
            "id" uuid NOT NULL,"space_id" uuid NOT NULL,"commitment_id" uuid NOT NULL,"fact_id" uuid NOT NULL,
            "expected_remaining_amount_in_cents" bigint NOT NULL,"paid_amount_in_cents" bigint NOT NULL,
            "adjustment_in_cents" bigint NOT NULL,"economic_shares" jsonb,"recognized_remaining_shares" jsonb,
            "fact_date" date NOT NULL,"actor_id" uuid NOT NULL,"registered_at" timestamptz NOT NULL,
            CONSTRAINT "PK_installment_payoffs" PRIMARY KEY ("id"),
            CONSTRAINT "UQ_installment_payoff_commitment" UNIQUE ("space_id","commitment_id"),
            CONSTRAINT "UQ_installment_payoff_scope" UNIQUE ("space_id","commitment_id","id"),
            CONSTRAINT "UQ_installment_payoff_fact" UNIQUE ("fact_id"),
            CONSTRAINT "CHK_installment_payoff_values" CHECK (expected_remaining_amount_in_cents BETWEEN 1 AND 9007199254740991 AND paid_amount_in_cents BETWEEN 1 AND 9007199254740991 AND adjustment_in_cents=paid_amount_in_cents-expected_remaining_amount_in_cents),
            CONSTRAINT "FK_installment_payoff_commitment" FOREIGN KEY ("space_id","commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT,
            CONSTRAINT "FK_installment_payoff_fact" FOREIGN KEY ("space_id","commitment_id","fact_id") REFERENCES "financial_disbursements"("space_id","commitment_id","id") ON DELETE RESTRICT,
            CONSTRAINT "FK_installment_payoff_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT
        )`);
        await q.query(`CREATE TABLE "financial_installment_resolutions" (
            "id" uuid NOT NULL,"space_id" uuid NOT NULL,"commitment_id" uuid NOT NULL,"installment_id" uuid NOT NULL,
            "type" varchar(16) NOT NULL,"payoff_id" uuid,"expected_remaining_amount_in_cents" bigint NOT NULL,
            "fact_date" date NOT NULL,"actor_id" uuid NOT NULL,"registered_at" timestamptz NOT NULL,
            "reason" varchar(500),"economic_shares" jsonb,
            CONSTRAINT "PK_installment_resolutions" PRIMARY KEY ("id"),
            CONSTRAINT "UQ_installment_resolution_installment" UNIQUE ("installment_id"),
            CONSTRAINT "CHK_installment_resolution_values" CHECK (expected_remaining_amount_in_cents BETWEEN 1 AND 9007199254740991 AND ((type='PAYOFF' AND payoff_id IS NOT NULL AND reason IS NULL) OR (type='CANCELLED' AND payoff_id IS NULL AND length(trim(reason)) BETWEEN 1 AND 500))),
            CONSTRAINT "FK_installment_resolution_installment" FOREIGN KEY ("space_id","commitment_id","installment_id") REFERENCES "financial_installments"("space_id","commitment_id","id") ON DELETE RESTRICT,
            CONSTRAINT "FK_installment_resolution_payoff" FOREIGN KEY ("space_id","commitment_id","payoff_id") REFERENCES "financial_installment_payoffs"("space_id","commitment_id","id") ON DELETE RESTRICT,
            CONSTRAINT "FK_installment_resolution_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT
        )`);
        await q.query(
            `ALTER TABLE "financial_installment_command_receipts" DROP CONSTRAINT "CHK_installment_command_receipts", ADD CONSTRAINT "CHK_installment_command_receipts" CHECK (status='COMPLETED' AND octet_length(request_hash)=32 AND operation IN ('CREATE_INSTALLMENT_COMMITMENT','RECORD_INSTALLMENT_DISBURSEMENT','RECORD_INSTALLMENT_EXTERNAL_LIABILITY','SETTLE_INSTALLMENT_EXTERNAL_LIABILITY','ANTICIPATE_INSTALLMENTS','PAYOFF_INSTALLMENTS','CANCEL_FUTURE_INSTALLMENTS'))`,
        );
    }

    public async down(q: QueryRunner): Promise<void> {
        const [row]: { present: boolean }[] = await q.query(
            `SELECT EXISTS(SELECT 1 FROM financial_installment_payoffs) OR EXISTS(SELECT 1 FROM financial_installment_resolutions) OR EXISTS(SELECT 1 FROM financial_installment_command_receipts WHERE operation IN ('PAYOFF_INSTALLMENTS','CANCEL_FUTURE_INSTALLMENTS')) AS present`,
        );
        if (row.present)
            throw new Error(
                'Cannot revert installment resolutions while payoff or cancellation facts exist',
            );
        await q.query(
            `ALTER TABLE "financial_installment_command_receipts" DROP CONSTRAINT "CHK_installment_command_receipts", ADD CONSTRAINT "CHK_installment_command_receipts" CHECK (status='COMPLETED' AND octet_length(request_hash)=32 AND operation IN ('CREATE_INSTALLMENT_COMMITMENT','RECORD_INSTALLMENT_DISBURSEMENT','RECORD_INSTALLMENT_EXTERNAL_LIABILITY','SETTLE_INSTALLMENT_EXTERNAL_LIABILITY','ANTICIPATE_INSTALLMENTS'))`,
        );
        await q.query(`DROP TABLE "financial_installment_resolutions"`);
        await q.query(`DROP TABLE "financial_installment_payoffs"`);
    }
}
