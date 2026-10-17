import { MigrationInterface, QueryRunner } from 'typeorm';

export class FinancialFulfillmentReversals1792252537110 implements MigrationInterface {
    name = 'FinancialFulfillmentReversals1792252537110';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE financial_installment_payoffs ADD recognized_manual_adjustments jsonb`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_installment_payoffs ADD expected_economic_shares jsonb`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_payoffs" DROP CONSTRAINT "UQ_installment_payoff_commitment"`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_fulfillment_reversals" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "target_id" uuid NOT NULL, "occurrence_id" uuid, "installment_id" uuid, "commitment_version" integer NOT NULL, "original_kind" character varying(24) NOT NULL, "original_id" uuid NOT NULL, "disbursement_id" uuid, "external_liability_id" uuid, "external_settlement_id" uuid, "receipt_id" uuid, "amount_in_cents" bigint NOT NULL, "reason" character varying(500) NOT NULL, "fact_date" date NOT NULL, "actor_id" uuid NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_fulfillment_reversal_version" UNIQUE ("space_id", "commitment_id", "commitment_version"), CONSTRAINT "CHK_fulfillment_reversal_values" CHECK (commitment_version>1 AND amount_in_cents BETWEEN 1 AND 9007199254740991 AND length(reason) BETWEEN 1 AND 500 AND reason=btrim(reason) AND fact_date<=(registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND num_nonnulls(disbursement_id,external_liability_id,external_settlement_id,receipt_id)=1 AND original_id=COALESCE(disbursement_id,external_liability_id,external_settlement_id,receipt_id) AND ((original_kind='DISBURSEMENT' AND disbursement_id IS NOT NULL) OR (original_kind='EXTERNAL_LIABILITY' AND external_liability_id IS NOT NULL) OR (original_kind='EXTERNAL_SETTLEMENT' AND external_settlement_id IS NOT NULL) OR (original_kind='RECEIPT' AND receipt_id IS NOT NULL)) AND ((occurrence_id IS NULL AND installment_id IS NULL AND target_id=commitment_id) OR (occurrence_id IS NOT NULL AND target_id=occurrence_id AND (installment_id IS NULL OR installment_id=occurrence_id)))), CONSTRAINT "PK_9a2655a4559786da93c4730e017" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_fulfillment_reversal_target" ON "financial_fulfillment_reversals"  ("space_id", "commitment_id", "target_id") `,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_fulfillment_reversal_original" ON "financial_fulfillment_reversals"  ("space_id", "commitment_id", "original_id") `,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_payoffs" ADD "compensated" boolean NOT NULL DEFAULT false`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_resolutions" ADD "compensated" boolean NOT NULL DEFAULT false`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_resolutions" DROP CONSTRAINT "UQ_installment_resolution_installment"`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_installment_payoff_active" ON "financial_installment_payoffs"  ("space_id", "commitment_id") WHERE compensated=false`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_installment_resolution_active" ON "financial_installment_resolutions"  ("installment_id") WHERE compensated=false`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liability_settlements" ADD CONSTRAINT "UQ_external_settlement_origin" UNIQUE ("space_id", "commitment_id", "id")`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" ADD CONSTRAINT "FK_fulfillment_reversal_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" ADD CONSTRAINT "FK_fulfillment_reversal_receipt" FOREIGN KEY ("space_id", "commitment_id", "receipt_id") REFERENCES "financial_receipts"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" ADD CONSTRAINT "FK_fulfillment_reversal_external_settlement" FOREIGN KEY ("space_id", "commitment_id", "external_settlement_id") REFERENCES "financial_external_liability_settlements"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" ADD CONSTRAINT "FK_fulfillment_reversal_external" FOREIGN KEY ("space_id", "commitment_id", "external_liability_id") REFERENCES "financial_external_liabilities"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" ADD CONSTRAINT "FK_fulfillment_reversal_disbursement" FOREIGN KEY ("space_id", "commitment_id", "disbursement_id") REFERENCES "financial_disbursements"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" ADD CONSTRAINT "FK_fulfillment_reversal_installment" FOREIGN KEY ("space_id", "commitment_id", "installment_id") REFERENCES "financial_installments"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" ADD CONSTRAINT "FK_fulfillment_reversal_occurrence" FOREIGN KEY ("space_id", "commitment_id", "occurrence_id") REFERENCES "financial_occurrences"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" ADD CONSTRAINT "FK_fulfillment_reversal_root" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [history] = await queryRunner.query(
            `SELECT EXISTS (SELECT 1 FROM financial_fulfillment_reversals UNION ALL SELECT 1 FROM financial_installment_payoffs WHERE compensated UNION ALL SELECT 1 FROM financial_installment_resolutions WHERE compensated UNION ALL SELECT 1 FROM financial_installment_payoffs p WHERE (p.recognized_manual_adjustments->>'amountInCents')::bigint<>0 OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(NULLIF(p.recognized_manual_adjustments->'shareChanges','null'::jsonb),'[]'::jsonb)) share WHERE (share->>'amountInCents')::bigint<>0) UNION ALL SELECT 1 FROM financial_integrity_command_receipts WHERE operation='REVERSE_FINANCIAL_FULFILLMENT') AS present`,
        );
        if (history.present)
            throw new Error(
                'Financial fulfillment reversal history prevents rollback',
            );
        await queryRunner.query(
            `ALTER TABLE financial_installment_payoffs DROP COLUMN expected_economic_shares`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_installment_payoffs DROP COLUMN recognized_manual_adjustments`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" DROP CONSTRAINT "FK_fulfillment_reversal_root"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" DROP CONSTRAINT "FK_fulfillment_reversal_occurrence"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" DROP CONSTRAINT "FK_fulfillment_reversal_installment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" DROP CONSTRAINT "FK_fulfillment_reversal_disbursement"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" DROP CONSTRAINT "FK_fulfillment_reversal_external"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" DROP CONSTRAINT "FK_fulfillment_reversal_external_settlement"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" DROP CONSTRAINT "FK_fulfillment_reversal_receipt"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" DROP CONSTRAINT "FK_fulfillment_reversal_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liability_settlements" DROP CONSTRAINT "UQ_external_settlement_origin"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."UQ_installment_resolution_active"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."UQ_installment_payoff_active"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_resolutions" ADD CONSTRAINT "UQ_installment_resolution_installment" UNIQUE ("installment_id")`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_resolutions" DROP COLUMN "compensated"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_payoffs" DROP COLUMN "compensated"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_fulfillment_reversal_original"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_fulfillment_reversal_target"`,
        );
        await queryRunner.query(`DROP TABLE "financial_fulfillment_reversals"`);
        await queryRunner.query(
            `ALTER TABLE "financial_installment_payoffs" ADD CONSTRAINT "UQ_installment_payoff_commitment" UNIQUE ("space_id", "commitment_id")`,
        );
    }
}
