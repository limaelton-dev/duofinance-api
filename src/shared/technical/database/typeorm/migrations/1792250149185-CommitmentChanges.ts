import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CommitmentChanges1792250149185 implements MigrationInterface {
    name = 'CommitmentChanges1792250149185';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE "financial_commitment_change_proposals" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "version" integer NOT NULL, "base_version" integer NOT NULL, "origin_fingerprint" character varying(32) NOT NULL, "proposed_by_member_id" uuid NOT NULL, "recipient_member_id" uuid NOT NULL, "actor_id" uuid NOT NULL, "effective_from" date NOT NULL, "configuration" jsonb NOT NULL, "impact" jsonb NOT NULL, "status" character varying(16) NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "decided_at" TIMESTAMP WITH TIME ZONE, "decided_by_person_id" uuid, CONSTRAINT "UQ_commitment_change_proposal_origin" UNIQUE ("space_id", "commitment_id", "id"), CONSTRAINT "CHK_commitment_change_proposal_state" CHECK (version > 0 AND base_version > 0 AND proposed_by_member_id <> recipient_member_id AND status IN ('PROPOSED','ACCEPTED','REJECTED','CANCELLED') AND (status='PROPOSED')=(decided_at IS NULL) AND (decided_at IS NULL)=(decided_by_person_id IS NULL)), CONSTRAINT "PK_8782c3d4d1d5875c5bc24eec014" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_commitment_change_proposals_recipient" ON "financial_commitment_change_proposals"  ("space_id", "recipient_member_id", "status", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_integrity_command_receipts" ("actor_id" uuid NOT NULL, "operation" character varying(40) NOT NULL, "idempotency_key" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "request_hash" bytea NOT NULL, "result" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_integrity_command_receipt_hash" CHECK (octet_length(request_hash)=32), CONSTRAINT "PK_a41b56c90d10ea28794ba0aadce" PRIMARY KEY ("actor_id", "operation", "idempotency_key"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_non_recurring_versions" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "target_id" uuid NOT NULL, "installment_id" uuid, "version" integer NOT NULL, "effective_from" date NOT NULL, "description" character varying(160) NOT NULL, "amount_in_cents" bigint NOT NULL, "distribution" jsonb, "economic_shares" jsonb, "expected_member_id" uuid, "actor_id" uuid NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_non_recurring_version_effective" UNIQUE ("space_id", "commitment_id", "target_id", "effective_from"), CONSTRAINT "UQ_non_recurring_version_target" UNIQUE ("space_id", "commitment_id", "version", "target_id"), CONSTRAINT "CHK_non_recurring_version_values" CHECK (version > 1 AND amount_in_cents BETWEEN 1 AND 9007199254740991 AND length(description) BETWEEN 1 AND 160 AND description=btrim(description) AND ((installment_id IS NULL AND target_id=commitment_id) OR (installment_id IS NOT NULL AND installment_id=target_id)) AND ((distribution IS NULL AND economic_shares IS NULL AND expected_member_id IS NULL) OR (distribution IS NOT NULL AND economic_shares IS NOT NULL))), CONSTRAINT "PK_d0bbdcc1a707028b34e4f9bc19e" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_non_recurring_version_selection" ON "financial_non_recurring_versions"  ("space_id", "commitment_id", "target_id", "effective_from") `,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" ADD CONSTRAINT "FK_commitment_change_proposal_decider" FOREIGN KEY ("decided_by_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" ADD CONSTRAINT "FK_commitment_change_proposal_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" ADD CONSTRAINT "FK_commitment_change_proposal_recipient" FOREIGN KEY ("space_id", "recipient_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" ADD CONSTRAINT "FK_commitment_change_proposal_author" FOREIGN KEY ("space_id", "proposed_by_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" ADD CONSTRAINT "FK_commitment_change_proposal_origin" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_integrity_command_receipts" ADD CONSTRAINT "FK_integrity_receipt_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_integrity_command_receipts" ADD CONSTRAINT "FK_integrity_receipt_origin" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_non_recurring_versions" ADD CONSTRAINT "FK_non_recurring_version_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_non_recurring_versions" ADD CONSTRAINT "FK_non_recurring_version_expected_member" FOREIGN KEY ("space_id", "expected_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_non_recurring_versions" ADD CONSTRAINT "FK_non_recurring_version_installment" FOREIGN KEY ("space_id", "commitment_id", "installment_id") REFERENCES "financial_installments"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_non_recurring_versions" ADD CONSTRAINT "FK_non_recurring_version_commitment" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [row]: { present: boolean }[] = await queryRunner.query(
            'SELECT EXISTS(SELECT 1 FROM financial_commitment_change_proposals) OR EXISTS(SELECT 1 FROM financial_integrity_command_receipts) OR EXISTS(SELECT 1 FROM financial_non_recurring_versions) AS present',
        );
        if (row.present)
            throw new Error(
                'Cannot revert commitment changes while economic versions or proposal history exist',
            );
        await queryRunner.query(
            `ALTER TABLE "financial_non_recurring_versions" DROP CONSTRAINT "FK_non_recurring_version_commitment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_non_recurring_versions" DROP CONSTRAINT "FK_non_recurring_version_installment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_non_recurring_versions" DROP CONSTRAINT "FK_non_recurring_version_expected_member"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_non_recurring_versions" DROP CONSTRAINT "FK_non_recurring_version_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_integrity_command_receipts" DROP CONSTRAINT "FK_integrity_receipt_origin"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_integrity_command_receipts" DROP CONSTRAINT "FK_integrity_receipt_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" DROP CONSTRAINT "FK_commitment_change_proposal_origin"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" DROP CONSTRAINT "FK_commitment_change_proposal_author"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" DROP CONSTRAINT "FK_commitment_change_proposal_recipient"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" DROP CONSTRAINT "FK_commitment_change_proposal_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" DROP CONSTRAINT "FK_commitment_change_proposal_decider"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_non_recurring_version_selection"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_non_recurring_versions"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_integrity_command_receipts"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_commitment_change_proposals_recipient"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_commitment_change_proposals"`,
        );
    }
}
