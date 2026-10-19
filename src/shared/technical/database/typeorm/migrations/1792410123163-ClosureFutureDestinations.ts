import { MigrationInterface, QueryRunner } from 'typeorm';

export class ClosureFutureDestinations1792410123163 implements MigrationInterface {
    name = 'ClosureFutureDestinations1792410123163';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE "financial_closure_effects" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "origin_id" uuid NOT NULL, "process_id" uuid NOT NULL, "plan_revision" integer NOT NULL, "actor_id" uuid NOT NULL, "cutoff_date" date NOT NULL, "snapshot" jsonb NOT NULL, "successor_commitment_id" uuid, "result" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_financial_closure_effect_scope" UNIQUE ("space_id", "origin_id", "id"), CONSTRAINT "UQ_financial_closure_effect_origin" UNIQUE ("space_id", "origin_id"), CONSTRAINT "CHK_financial_closure_effect_revision" CHECK (plan_revision>0), CONSTRAINT "PK_7092ee54835387f39338f883e9a" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD "closure_agreement_id" uuid`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" ADD "future_destinations" jsonb NOT NULL DEFAULT '[]'::jsonb`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_commitments DROP CONSTRAINT "CHK_financial_commitments_scope", ADD CONSTRAINT "CHK_financial_commitments_scope" CHECK (kind IN ('EXPENSE','INCOME') AND modality IN ('ONE_TIME','RECURRING','INSTALLMENT') AND version > 0 AND length(description) BETWEEN 1 AND 160 AND description = btrim(description))`,
        );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligations DROP CONSTRAINT "CHK_obligations_origin_xor", ADD CONSTRAINT "CHK_obligations_origin_xor" CHECK (num_nonnulls(disbursement_id,receipt_id,external_liability_id,closure_agreement_id)=1)`,
        );
        await queryRunner.query(`DROP INDEX "UQ_obligations_open_one_time"`);
        await queryRunner.query(`DROP INDEX "UQ_obligations_open_occurrence"`);
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_obligations_open_one_time" ON inter_member_obligations(space_id,commitment_id) WHERE remaining_amount_in_cents>0 AND occurrence_id IS NULL AND closure_agreement_id IS NULL`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_obligations_open_occurrence" ON inter_member_obligations(space_id,occurrence_id) WHERE remaining_amount_in_cents>0 AND occurrence_id IS NOT NULL AND closure_agreement_id IS NULL`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_obligations_closure_agreement" ON "inter_member_obligations"  ("closure_agreement_id") `,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" ADD CONSTRAINT "CHK_space_closure_processes_destinations" CHECK (jsonb_typeof("future_destinations") = 'array')`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "FK_obligations_closure_agreement" FOREIGN KEY ("space_id", "commitment_id", "closure_agreement_id") REFERENCES "financial_closure_effects"("space_id","origin_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_closure_effects" ADD CONSTRAINT "FK_financial_closure_effect_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_closure_effects" ADD CONSTRAINT "FK_financial_closure_effect_successor" FOREIGN KEY ("successor_commitment_id") REFERENCES "financial_commitments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_closure_effects" ADD CONSTRAINT "FK_financial_closure_effect_origin" FOREIGN KEY ("space_id", "origin_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const rows: { present: boolean }[] = await queryRunner.query(
            `SELECT EXISTS(SELECT 1 FROM financial_closure_effects UNION ALL SELECT 1 FROM space_closure_history WHERE jsonb_array_length(COALESCE(snapshot->'futureDestinations','[]'::jsonb))>0) AS present`,
        );
        if (rows[0]?.present)
            throw new Error(
                'Cannot revert closure future destinations with recorded history',
            );
        await queryRunner.query(
            `ALTER TABLE inter_member_obligations DROP CONSTRAINT "CHK_obligations_origin_xor", ADD CONSTRAINT "CHK_obligations_origin_xor" CHECK (num_nonnulls(disbursement_id,receipt_id,external_liability_id)=1)`,
        );
        await queryRunner.query(`DROP INDEX "UQ_obligations_open_one_time"`);
        await queryRunner.query(`DROP INDEX "UQ_obligations_open_occurrence"`);
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_obligations_open_one_time" ON inter_member_obligations(space_id,commitment_id) WHERE remaining_amount_in_cents>0 AND occurrence_id IS NULL`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_obligations_open_occurrence" ON inter_member_obligations(space_id,occurrence_id) WHERE remaining_amount_in_cents>0 AND occurrence_id IS NOT NULL`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_commitments DROP CONSTRAINT "CHK_financial_commitments_scope", ADD CONSTRAINT "CHK_financial_commitments_scope" CHECK (kind IN ('EXPENSE','INCOME') AND modality IN ('ONE_TIME','RECURRING','INSTALLMENT') AND version > 0 AND length(description) BETWEEN 1 AND 160 AND description = btrim(description) AND (personal_owner_person_id IS NULL OR personal_owner_person_id=created_by))`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_closure_effects" DROP CONSTRAINT "FK_financial_closure_effect_origin"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_closure_effects" DROP CONSTRAINT "FK_financial_closure_effect_successor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_closure_effects" DROP CONSTRAINT "FK_financial_closure_effect_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "FK_obligations_closure_agreement"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" DROP CONSTRAINT "CHK_space_closure_processes_destinations"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."UQ_obligations_closure_agreement"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" DROP COLUMN "future_destinations"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP COLUMN "closure_agreement_id"`,
        );
        await queryRunner.query(`DROP TABLE "financial_closure_effects"`);
    }
}
