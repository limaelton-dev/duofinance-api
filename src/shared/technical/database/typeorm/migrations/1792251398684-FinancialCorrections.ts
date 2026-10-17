import { MigrationInterface, QueryRunner } from 'typeorm';

export class FinancialCorrections1792251398684 implements MigrationInterface {
    name = 'FinancialCorrections1792251398684';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE financial_occurrences DROP CONSTRAINT "CHK_financial_occurrences_state"`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_occurrences ADD CONSTRAINT "CHK_financial_occurrences_state" CHECK (((economic_version IS NOT NULL AND economic_version > 0 AND installment_id IS NULL) OR (economic_version IS NULL AND installment_id IS NOT NULL AND amount_in_cents IS NOT NULL)) AND state_version > 0 AND (amount_in_cents IS NULL OR amount_in_cents BETWEEN 0 AND 9007199254740991) AND (amount_in_cents IS NOT NULL OR status IN ('PENDING','CANCELLED')) AND status IN ('PENDING','PARTIALLY_FULFILLED','FULFILLED','CANCELLED'))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_commitment_adjustments" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "target_id" uuid NOT NULL, "occurrence_id" uuid, "installment_id" uuid, "commitment_version" integer NOT NULL, "direction" character varying(8) NOT NULL, "amount_in_cents" bigint NOT NULL, "reason" character varying(500) NOT NULL, "fact_date" date NOT NULL, "actor_id" uuid NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "previous_amount_in_cents" bigint NOT NULL, "resulting_amount_in_cents" bigint NOT NULL, "economic_shares" jsonb, "share_changes" jsonb, "proposal_id" uuid, CONSTRAINT "UQ_commitment_adjustment_version" UNIQUE ("space_id", "commitment_id", "commitment_version"), CONSTRAINT "CHK_commitment_adjustment_values" CHECK (commitment_version>1 AND direction IN ('INCREASE','DECREASE') AND amount_in_cents BETWEEN 1 AND 9007199254740991 AND previous_amount_in_cents BETWEEN 0 AND 9007199254740991 AND resulting_amount_in_cents BETWEEN 0 AND 9007199254740991 AND resulting_amount_in_cents=previous_amount_in_cents+CASE WHEN direction='INCREASE' THEN amount_in_cents ELSE -amount_in_cents END AND length(reason) BETWEEN 1 AND 500 AND reason=btrim(reason) AND fact_date<=(registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((occurrence_id IS NULL AND installment_id IS NULL AND target_id=commitment_id) OR (occurrence_id IS NOT NULL AND target_id=occurrence_id AND (installment_id IS NULL OR installment_id=occurrence_id)))), CONSTRAINT "PK_a2cdbed4a9485bc59b5e8d1c392" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_commitment_adjustment_target" ON "financial_commitment_adjustments"  ("space_id", "commitment_id", "target_id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_commitment_cancellations" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "commitment_version" integer NOT NULL, "reason" character varying(500) NOT NULL, "fact_date" date NOT NULL, "actor_id" uuid NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_commitment_cancellation_root" UNIQUE ("space_id", "commitment_id"), CONSTRAINT "CHK_commitment_cancellation_values" CHECK (commitment_version>1 AND length(reason) BETWEEN 1 AND 500 AND reason=btrim(reason) AND fact_date<=(registered_at AT TIME ZONE 'America/Sao_Paulo')::date), CONSTRAINT "PK_b61dead72706e2232954e2a0668" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" ADD CONSTRAINT "FK_commitment_adjustment_proposal" FOREIGN KEY ("space_id", "commitment_id", "proposal_id") REFERENCES "financial_commitment_change_proposals"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" ADD CONSTRAINT "FK_commitment_adjustment_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" ADD CONSTRAINT "FK_commitment_adjustment_installment" FOREIGN KEY ("space_id", "commitment_id", "installment_id") REFERENCES "financial_installments"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" ADD CONSTRAINT "FK_commitment_adjustment_occurrence" FOREIGN KEY ("space_id", "commitment_id", "occurrence_id") REFERENCES "financial_occurrences"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" ADD CONSTRAINT "FK_commitment_adjustment_root" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_cancellations" ADD CONSTRAINT "FK_commitment_cancellation_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_cancellations" ADD CONSTRAINT "FK_commitment_cancellation_root" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [history] = await queryRunner.query(
            `SELECT EXISTS (SELECT 1 FROM financial_commitment_adjustments UNION ALL SELECT 1 FROM financial_commitment_cancellations UNION ALL SELECT 1 FROM financial_occurrences WHERE amount_in_cents=0 UNION ALL SELECT 1 FROM financial_integrity_command_receipts WHERE operation IN ('RECORD_FINANCIAL_ADJUSTMENT','CANCEL_COMMITMENT') UNION ALL SELECT 1 FROM financial_commitment_change_proposals WHERE configuration->>'changeType'='ADJUSTMENT') AS present`,
        );
        if (history.present)
            throw new Error('Financial corrections history prevents rollback');
        await queryRunner.query(
            `ALTER TABLE financial_occurrences DROP CONSTRAINT "CHK_financial_occurrences_state"`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_occurrences ADD CONSTRAINT "CHK_financial_occurrences_state" CHECK (((economic_version IS NOT NULL AND economic_version > 0 AND installment_id IS NULL) OR (economic_version IS NULL AND installment_id IS NOT NULL AND amount_in_cents IS NOT NULL)) AND state_version > 0 AND (amount_in_cents IS NULL OR amount_in_cents BETWEEN 1 AND 9007199254740991) AND (amount_in_cents IS NOT NULL OR status IN ('PENDING','CANCELLED')) AND status IN ('PENDING','PARTIALLY_FULFILLED','FULFILLED','CANCELLED'))`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_cancellations" DROP CONSTRAINT "FK_commitment_cancellation_root"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_cancellations" DROP CONSTRAINT "FK_commitment_cancellation_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" DROP CONSTRAINT "FK_commitment_adjustment_root"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" DROP CONSTRAINT "FK_commitment_adjustment_occurrence"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" DROP CONSTRAINT "FK_commitment_adjustment_installment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" DROP CONSTRAINT "FK_commitment_adjustment_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" DROP CONSTRAINT "FK_commitment_adjustment_proposal"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_commitment_cancellations"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_commitment_adjustment_target"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_commitment_adjustments"`,
        );
    }
}
