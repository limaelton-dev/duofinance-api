import type { MigrationInterface, QueryRunner } from 'typeorm';

// Generated from the nullable ORM column; unrelated pre-existing CARD-005
// constraint drift was removed during review. The scoped FK stays unchanged.
export class OptionalExpectedPayer1791728636456 implements MigrationInterface {
    name = 'OptionalExpectedPayer1791728636456';
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" ALTER COLUMN "expected_payer_member_id" DROP NOT NULL`,
        );
    }
    async down(queryRunner: QueryRunner): Promise<void> {
        // Reversal must never infer or rewrite a historical planned payer.
        // SET NOT NULL also protects against a concurrent nullable insertion.
        await queryRunner.query(`DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM financial_commitment_versions WHERE expected_payer_member_id IS NULL) THEN
                RAISE EXCEPTION 'Cannot reverse OptionalExpectedPayer: historical expenses without an expected payer exist';
            END IF;
        END $$`);
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" ALTER COLUMN "expected_payer_member_id" SET NOT NULL`,
        );
    }
}
