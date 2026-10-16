import { MigrationInterface, QueryRunner } from 'typeorm';

export class CustomSettlementAssignment1792160969556 implements MigrationInterface {
    name = 'CustomSettlementAssignment1792160969556';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE inter_member_obligation_changes DROP CONSTRAINT "CHK_obligation_changes_type"`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligation_changes ADD CONSTRAINT "CHK_obligation_changes_type" CHECK ((version = 1 AND type = 'CREATED' AND allocation_id IS NULL) OR (version > 1 AND type = 'SETTLEMENT_APPLIED' AND allocation_id IS NOT NULL) OR (version > 1 AND type IN ('RECONCILED','ASSIGNMENT_CHANGED') AND allocation_id IS NULL))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_commitment_settlement_rules" ("commitment_id" uuid NOT NULL, "space_id" uuid NOT NULL, "version" integer NOT NULL, "rule" jsonb NOT NULL, CONSTRAINT "UQ_commitment_settlement_rule_space" UNIQUE ("space_id", "commitment_id"), CONSTRAINT "CHK_commitment_settlement_rule_version" CHECK (version > 0 AND COALESCE(jsonb_typeof(rule) = 'object' AND rule->>'kind' = 'MONTHLY_DAY' AND jsonb_typeof(rule->'dayOfMonth') = 'number' AND (rule->>'dayOfMonth')::numeric BETWEEN 1 AND 31 AND (rule->>'dayOfMonth')::numeric = trunc((rule->>'dayOfMonth')::numeric),false)), CONSTRAINT "PK_b25d698b102b51b8132821cd42b" PRIMARY KEY ("commitment_id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_commitment_settlement_rule_changes" ("commitment_id" uuid NOT NULL, "version" integer NOT NULL, "space_id" uuid NOT NULL, "commitment_version" integer NOT NULL, "actor_id" uuid NOT NULL, "previous_rule" jsonb, "rule" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_commitment_rule_change_version" CHECK (version > 0 AND commitment_version > 1), CONSTRAINT "PK_97bd24fac23ff3925f82752c4cc" PRIMARY KEY ("commitment_id", "version"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_settlement_adjustment_receipts" ("actor_id" uuid NOT NULL, "operation" character varying(48) NOT NULL, "idempotency_key" uuid NOT NULL, "space_id" uuid NOT NULL, "request_hash" bytea NOT NULL, "result" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_settlement_adjustment_receipt" CHECK (operation IN ('CONFIGURE_COMMITMENT_SETTLEMENT_RULE','MOVE_OBLIGATION') AND octet_length(request_hash) = 32), CONSTRAINT "PK_fd94d916b1af77766fc079b2cd5" PRIMARY KEY ("actor_id", "operation", "idempotency_key"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_settlement_adjustment_audit" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "actor_id" uuid NOT NULL, "idempotency_key" uuid NOT NULL, "action" character varying(48) NOT NULL, "target_id" uuid NOT NULL, "payload" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_settlement_adjustment_audit_command" UNIQUE ("actor_id", "action", "idempotency_key"), CONSTRAINT "PK_d28ff4a752fd586ddbdea36a7cc" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_settlement_rules" ADD CONSTRAINT "FK_commitment_settlement_rule_origin" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_settlement_rule_changes" ADD CONSTRAINT "FK_commitment_rule_change_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_settlement_rule_changes" ADD CONSTRAINT "FK_commitment_rule_change_rule" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitment_settlement_rules"("space_id","commitment_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_adjustment_receipts" ADD CONSTRAINT "FK_settlement_adjustment_receipt_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_adjustment_receipts" ADD CONSTRAINT "FK_settlement_adjustment_receipt_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_adjustment_audit" ADD CONSTRAINT "FK_settlement_adjustment_audit_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_adjustment_audit" ADD CONSTRAINT "FK_settlement_adjustment_audit_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DO $$ BEGIN IF EXISTS (SELECT 1 FROM financial_commitment_settlement_rule_changes) OR EXISTS (SELECT 1 FROM financial_settlement_adjustment_receipts) OR EXISTS (SELECT 1 FROM financial_settlement_adjustment_audit) OR EXISTS (SELECT 1 FROM inter_member_obligation_changes WHERE type='ASSIGNMENT_CHANGED') THEN RAISE EXCEPTION 'Cannot remove settlement customization history'; END IF; END $$`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligation_changes DROP CONSTRAINT "CHK_obligation_changes_type"`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligation_changes ADD CONSTRAINT "CHK_obligation_changes_type" CHECK ((version = 1 AND type = 'CREATED' AND allocation_id IS NULL) OR (version > 1 AND type = 'SETTLEMENT_APPLIED' AND allocation_id IS NOT NULL) OR (version > 1 AND type = 'RECONCILED' AND allocation_id IS NULL))`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_adjustment_audit" DROP CONSTRAINT "FK_settlement_adjustment_audit_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_adjustment_audit" DROP CONSTRAINT "FK_settlement_adjustment_audit_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_adjustment_receipts" DROP CONSTRAINT "FK_settlement_adjustment_receipt_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_adjustment_receipts" DROP CONSTRAINT "FK_settlement_adjustment_receipt_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_settlement_rule_changes" DROP CONSTRAINT "FK_commitment_rule_change_rule"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_settlement_rule_changes" DROP CONSTRAINT "FK_commitment_rule_change_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_settlement_rules" DROP CONSTRAINT "FK_commitment_settlement_rule_origin"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_settlement_adjustment_audit"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_settlement_adjustment_receipts"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_commitment_settlement_rule_changes"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_commitment_settlement_rules"`,
        );
    }
}
