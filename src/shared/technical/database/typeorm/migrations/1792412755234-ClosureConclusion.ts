import { MigrationInterface, QueryRunner } from 'typeorm';

export class ClosureConclusion1792412755234 implements MigrationInterface {
    name = 'ClosureConclusion1792412755234';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" ADD "cancellation_consents" jsonb NOT NULL DEFAULT '[]'::jsonb`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" ADD CONSTRAINT "CHK_space_closure_processes_cancellation_consents" CHECK (jsonb_typeof("cancellation_consents") = 'array' AND jsonb_array_length("cancellation_consents") <= 2)`,
        );
        await queryRunner.query(
            `ALTER TABLE financial_commitments DROP CONSTRAINT "CHK_financial_commitments_scope", ADD CONSTRAINT "CHK_financial_commitments_scope" CHECK (kind IN ('EXPENSE','INCOME') AND modality IN ('ONE_TIME','RECURRING','INSTALLMENT') AND version > 0 AND length(description) BETWEEN 1 AND 160 AND description = btrim(description) AND (personal_owner_person_id IS NULL OR modality <> 'ONE_TIME' OR personal_owner_person_id=created_by))`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const rows: { present: boolean }[] = await queryRunner.query(
            `SELECT EXISTS(SELECT 1 FROM space_closure_processes WHERE jsonb_array_length(cancellation_consents)>0 UNION ALL SELECT 1 FROM space_closure_history WHERE action IN ('CONFIRM_SPACE_CLOSURE','CANCEL_SPACE_CLOSURE')) AS present`,
        );
        if (rows[0]?.present)
            throw new Error(
                'Cannot revert closure conclusion with recorded confirmations or cancellations',
            );
        await queryRunner.query(
            `ALTER TABLE financial_commitments DROP CONSTRAINT "CHK_financial_commitments_scope", ADD CONSTRAINT "CHK_financial_commitments_scope" CHECK (kind IN ('EXPENSE','INCOME') AND modality IN ('ONE_TIME','RECURRING','INSTALLMENT') AND version > 0 AND length(description) BETWEEN 1 AND 160 AND description = btrim(description))`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" DROP CONSTRAINT "CHK_space_closure_processes_cancellation_consents"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" DROP COLUMN "cancellation_consents"`,
        );
    }
}
