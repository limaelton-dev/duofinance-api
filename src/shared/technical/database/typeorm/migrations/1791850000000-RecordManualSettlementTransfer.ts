import { MigrationInterface, QueryRunner } from 'typeorm';

export class RecordManualSettlementTransfer1791850000000 implements MigrationInterface {
    name = 'RecordManualSettlementTransfer1791850000000';
    public async up(q: QueryRunner): Promise<void> {
        await q.query(
            `DO $$ BEGIN IF EXISTS (SELECT 1 FROM inter_member_obligations o LEFT JOIN inter_member_obligation_changes c ON c.space_id=o.space_id AND c.obligation_id=o.id AND c.version=1 WHERE o.version<>1 OR c.obligation_id IS NULL OR c.type<>'CREATED') THEN RAISE EXCEPTION 'Unexplained obligation history before settlement migration'; END IF; END $$`,
        );
        await q.query(
            `ALTER TABLE inter_member_obligations DROP CONSTRAINT "CHK_obligations_initial_state"`,
        );
        await q.query(
            `ALTER TABLE inter_member_obligations ALTER COLUMN status TYPE varchar(24)`,
        );
        await q.query(
            `UPDATE inter_member_obligations SET status = CASE WHEN remaining_amount_in_cents = 0 THEN 'SETTLED' WHEN remaining_amount_in_cents < original_amount_in_cents THEN 'PARTIALLY_SETTLED' ELSE 'OPEN' END WHERE status = 'OPEN'`,
        );
        await q.query(
            `ALTER TABLE inter_member_obligations ADD CONSTRAINT "CHK_obligations_state" CHECK (original_amount_in_cents BETWEEN 1 AND 9007199254740991 AND remaining_amount_in_cents BETWEEN 0 AND original_amount_in_cents AND debtor_member_id <> creditor_member_id AND version > 0 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((status = 'OPEN' AND remaining_amount_in_cents = original_amount_in_cents) OR (status = 'PARTIALLY_SETTLED' AND remaining_amount_in_cents > 0 AND remaining_amount_in_cents < original_amount_in_cents) OR (status = 'SETTLED' AND remaining_amount_in_cents = 0)))`,
        );
        await q.query(
            `ALTER TABLE inter_member_obligation_changes DROP CONSTRAINT "CHK_obligation_changes_initial"`,
        );
        await q.query(
            `ALTER TABLE inter_member_obligation_changes ALTER COLUMN type TYPE varchar(24)`,
        );
        await q.query(
            `ALTER TABLE inter_member_obligation_changes ADD COLUMN allocation_id uuid`,
        );
        await q.query(
            `ALTER TABLE inter_member_obligation_changes ADD CONSTRAINT "CHK_obligation_changes_type" CHECK ((version = 1 AND type = 'CREATED' AND allocation_id IS NULL) OR (version > 1 AND type = 'SETTLEMENT_APPLIED' AND allocation_id IS NOT NULL))`,
        );
        await q.query(
            `CREATE TABLE settlement_transfers (id uuid PRIMARY KEY, space_id uuid NOT NULL, payer_member_id uuid NOT NULL, recipient_member_id uuid NOT NULL, amount_in_cents bigint NOT NULL, fact_date date NOT NULL, registered_at timestamptz NOT NULL, created_by uuid NOT NULL, mode varchar(16) NOT NULL, CONSTRAINT "UQ_settlement_transfers_space_id" UNIQUE (space_id,id), CONSTRAINT "CHK_settlement_transfers_values" CHECK (payer_member_id <> recipient_member_id AND amount_in_cents BETWEEN 1 AND 9007199254740991 AND mode = 'MANUAL' AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date), CONSTRAINT "FK_settlement_transfers_space" FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE RESTRICT, CONSTRAINT "FK_settlement_transfers_payer" FOREIGN KEY (space_id,payer_member_id) REFERENCES space_members(space_id,id) ON DELETE RESTRICT, CONSTRAINT "FK_settlement_transfers_recipient" FOREIGN KEY (space_id,recipient_member_id) REFERENCES space_members(space_id,id) ON DELETE RESTRICT, CONSTRAINT "FK_settlement_transfers_author" FOREIGN KEY (created_by) REFERENCES persons(id) ON DELETE RESTRICT)`,
        );
        await q.query(
            `CREATE INDEX "IDX_settlement_transfers_space_registered" ON settlement_transfers(space_id,registered_at DESC,id DESC)`,
        );
        await q.query(
            `CREATE TABLE settlement_allocations (id uuid PRIMARY KEY, space_id uuid NOT NULL, transfer_id uuid NOT NULL, obligation_id uuid NOT NULL, cycle_id uuid, amount_in_cents bigint NOT NULL, CONSTRAINT "UQ_settlement_allocations_transfer_obligation" UNIQUE (transfer_id,obligation_id), CONSTRAINT "UQ_settlement_allocations_space_id" UNIQUE (space_id,id), CONSTRAINT "CHK_settlement_allocations_amount" CHECK (amount_in_cents BETWEEN 1 AND 9007199254740991), CONSTRAINT "FK_settlement_allocations_transfer" FOREIGN KEY (space_id,transfer_id) REFERENCES settlement_transfers(space_id,id) ON DELETE RESTRICT, CONSTRAINT "FK_settlement_allocations_obligation" FOREIGN KEY (space_id,obligation_id) REFERENCES inter_member_obligations(space_id,id) ON DELETE RESTRICT, CONSTRAINT "FK_settlement_allocations_cycle" FOREIGN KEY (space_id,cycle_id) REFERENCES settlement_cycles(space_id,id) ON DELETE RESTRICT)`,
        );
        await q.query(
            `CREATE INDEX "IDX_settlement_allocations_obligation" ON settlement_allocations(space_id,obligation_id)`,
        );
        await q.query(
            `CREATE INDEX "IDX_settlement_allocations_cycle" ON settlement_allocations(space_id,cycle_id,transfer_id)`,
        );
        await q.query(
            `ALTER TABLE inter_member_obligation_changes ADD CONSTRAINT "UQ_obligation_changes_allocation" UNIQUE (allocation_id)`,
        );
        await q.query(
            `ALTER TABLE inter_member_obligation_changes ADD CONSTRAINT "FK_obligation_changes_allocation" FOREIGN KEY (space_id,allocation_id) REFERENCES settlement_allocations(space_id,id) ON DELETE RESTRICT`,
        );
        await q.query(
            `CREATE TABLE financial_settlement_command_receipts (actor_id uuid NOT NULL, operation varchar(48) NOT NULL, idempotency_key uuid NOT NULL, request_hash bytea NOT NULL, status varchar(16) NOT NULL, space_id uuid NOT NULL, transfer_id uuid NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL, PRIMARY KEY(actor_id,operation,idempotency_key), CONSTRAINT "CHK_settlement_receipt" CHECK (operation = 'RECORD_MANUAL_SETTLEMENT_TRANSFER' AND status = 'COMPLETED' AND octet_length(request_hash) = 32), CONSTRAINT "FK_settlement_receipt_actor" FOREIGN KEY(actor_id) REFERENCES persons(id) ON DELETE RESTRICT, CONSTRAINT "FK_settlement_receipt_transfer" FOREIGN KEY(space_id,transfer_id) REFERENCES settlement_transfers(space_id,id) ON DELETE RESTRICT)`,
        );
        await q.query(
            `CREATE TABLE financial_settlement_audit (id uuid PRIMARY KEY, space_id uuid NOT NULL, transfer_id uuid NOT NULL, actor_id uuid NOT NULL, action varchar(48) NOT NULL, payload jsonb NOT NULL, registered_at timestamptz NOT NULL, CONSTRAINT "UQ_settlement_audit_transfer" UNIQUE (transfer_id), CONSTRAINT "CHK_settlement_audit_action" CHECK (action = 'RECORD_MANUAL_SETTLEMENT_TRANSFER'), CONSTRAINT "FK_settlement_audit_transfer" FOREIGN KEY(space_id,transfer_id) REFERENCES settlement_transfers(space_id,id) ON DELETE RESTRICT, CONSTRAINT "FK_settlement_audit_actor" FOREIGN KEY(actor_id) REFERENCES persons(id) ON DELETE RESTRICT)`,
        );
    }
    public async down(q: QueryRunner): Promise<void> {
        const rows: { count: string }[] = await q.query(
            `SELECT COUNT(*)::text AS count FROM settlement_transfers`,
        );
        if (BigInt(rows[0].count) > 0n)
            throw new Error(
                'Cannot downgrade settlement transfers with recorded facts',
            );
        await q.query(`DROP TABLE financial_settlement_audit`);
        await q.query(`DROP TABLE financial_settlement_command_receipts`);
        await q.query(
            `ALTER TABLE inter_member_obligation_changes DROP CONSTRAINT "FK_obligation_changes_allocation"`,
        );
        await q.query(
            `ALTER TABLE inter_member_obligation_changes DROP CONSTRAINT "UQ_obligation_changes_allocation"`,
        );
        await q.query(`DROP TABLE settlement_allocations`);
        await q.query(`DROP TABLE settlement_transfers`);
        await q.query(
            `ALTER TABLE inter_member_obligation_changes DROP CONSTRAINT "CHK_obligation_changes_type"`,
        );
        await q.query(
            `ALTER TABLE inter_member_obligation_changes DROP COLUMN allocation_id`,
        );
        await q.query(
            `ALTER TABLE inter_member_obligation_changes ADD CONSTRAINT "CHK_obligation_changes_initial" CHECK (version = 1 AND type = 'CREATED')`,
        );
        await q.query(
            `ALTER TABLE inter_member_obligation_changes ALTER COLUMN type TYPE varchar(16)`,
        );
        await q.query(
            `ALTER TABLE inter_member_obligations DROP CONSTRAINT "CHK_obligations_state"`,
        );
        await q.query(
            `UPDATE inter_member_obligations SET status = 'OPEN' WHERE status <> 'OPEN'`,
        );
        await q.query(
            `ALTER TABLE inter_member_obligations ALTER COLUMN status TYPE varchar(16)`,
        );
        await q.query(
            `ALTER TABLE inter_member_obligations ADD CONSTRAINT "CHK_obligations_initial_state" CHECK (original_amount_in_cents BETWEEN 1 AND 9007199254740991 AND remaining_amount_in_cents BETWEEN 0 AND original_amount_in_cents AND debtor_member_id <> creditor_member_id AND status = 'OPEN' AND version > 0 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date)`,
        );
    }
}
