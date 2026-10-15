import type { MigrationInterface, QueryRunner } from 'typeorm';
const oldOperations =
    "'RECORD_SHARED_CASH_EXPENSE','RECORD_PERSONAL_EXPENSE','RECORD_EXPENSE_DISBURSEMENT','RECORD_CREDIT_CARD_PURCHASE','RECORD_EXTERNAL_LIABILITY'";
const liabilityCheck =
    "amount_in_cents BETWEEN 1 AND 9007199254740991 AND sequence > 0 AND version=1 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND num_nonnulls(holder_member_id,holder_person_id)=1";
export class ExternalLiabilitySettlements1792110000000 implements MigrationInterface {
    name = 'ExternalLiabilitySettlements1792110000000';
    async up(q: QueryRunner): Promise<void> {
        await q.query(
            `ALTER TABLE financial_external_liabilities DROP CONSTRAINT "CHK_external_liabilities_values"`,
        );
        await q.query(
            `ALTER TABLE financial_external_liabilities ADD CONSTRAINT "CHK_external_liabilities_values" CHECK (${liabilityCheck} AND remaining_amount_in_cents BETWEEN 0 AND amount_in_cents)`,
        );
        await q.query(
            `ALTER TABLE financial_expense_command_receipts DROP CONSTRAINT "CHK_expense_receipt"`,
        );
        await q.query(
            `ALTER TABLE financial_expense_command_receipts ADD CONSTRAINT "CHK_expense_receipt" CHECK (operation IN (${oldOperations},'SETTLE_EXTERNAL_LIABILITY') AND status='COMPLETED' AND octet_length(request_hash)=32)`,
        );
        await q.query(`CREATE TABLE financial_external_liability_settlements (
            id uuid PRIMARY KEY, space_id uuid NOT NULL, commitment_id uuid NOT NULL, external_liability_id uuid NOT NULL,
            sequence integer NOT NULL,holder_member_id uuid,holder_person_id uuid,recorded_by_person_id uuid NOT NULL,
            receipt_operation varchar(40) NOT NULL,idempotency_key uuid NOT NULL,amount_in_cents bigint NOT NULL,
            fact_date date NOT NULL,registered_at timestamptz NOT NULL,
            CONSTRAINT "UQ_external_settlement_sequence" UNIQUE(commitment_id,sequence),
            CONSTRAINT "CHK_external_settlement_values" CHECK(amount_in_cents BETWEEN 1 AND 9007199254740991 AND sequence>1 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND num_nonnulls(holder_member_id,holder_person_id)=1 AND receipt_operation='SETTLE_EXTERNAL_LIABILITY'),
            CONSTRAINT "FK_external_settlement_origin" FOREIGN KEY(space_id,commitment_id,external_liability_id) REFERENCES financial_external_liabilities(space_id,commitment_id,id) ON DELETE RESTRICT,
            CONSTRAINT "FK_external_settlement_holder" FOREIGN KEY(space_id,holder_member_id) REFERENCES space_members(space_id,id) ON DELETE RESTRICT,
            CONSTRAINT "FK_external_settlement_person" FOREIGN KEY(holder_person_id) REFERENCES persons(id) ON DELETE RESTRICT,
            CONSTRAINT "FK_external_settlement_receipt" FOREIGN KEY(recorded_by_person_id,receipt_operation,idempotency_key) REFERENCES financial_expense_command_receipts(actor_id,operation,idempotency_key) DEFERRABLE INITIALLY DEFERRED
        )`);
        await q.query(
            `CREATE INDEX "IDX_external_liabilities_open_holder" ON financial_external_liabilities(space_id,holder_member_id,holder_person_id,fact_date DESC,id DESC) WHERE remaining_amount_in_cents>0`,
        );
    }
    async down(q: QueryRunner): Promise<void> {
        await q.query(
            `DO $$ BEGIN IF EXISTS(SELECT 1 FROM financial_external_liability_settlements) OR EXISTS(SELECT 1 FROM financial_expense_command_receipts WHERE operation='SETTLE_EXTERNAL_LIABILITY') THEN RAISE EXCEPTION 'Cannot revert external settlements while facts or receipts exist'; END IF; END $$`,
        );
        await q.query(`DROP TABLE financial_external_liability_settlements`);
        await q.query(`DROP INDEX "IDX_external_liabilities_open_holder"`);
        await q.query(
            `ALTER TABLE financial_external_liabilities DROP CONSTRAINT "CHK_external_liabilities_values"`,
        );
        await q.query(
            `ALTER TABLE financial_external_liabilities ADD CONSTRAINT "CHK_external_liabilities_values" CHECK (${liabilityCheck} AND remaining_amount_in_cents=amount_in_cents)`,
        );
        await q.query(
            `ALTER TABLE financial_expense_command_receipts DROP CONSTRAINT "CHK_expense_receipt"`,
        );
        await q.query(
            `ALTER TABLE financial_expense_command_receipts ADD CONSTRAINT "CHK_expense_receipt" CHECK (operation IN (${oldOperations}) AND status='COMPLETED' AND octet_length(request_hash)=32)`,
        );
    }
}
