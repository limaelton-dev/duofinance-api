import { MigrationInterface, QueryRunner } from 'typeorm';

export class ClosurePlanConsensus1792410948212 implements MigrationInterface {
    name = 'ClosurePlanConsensus1792410948212';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" ADD "proposal_snapshot" jsonb`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" ADD "has_bilateral_approval" boolean NOT NULL DEFAULT false`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" ADD CONSTRAINT "CHK_space_closure_processes_proposal_snapshot" CHECK ("proposal_snapshot" IS NULL OR jsonb_typeof("proposal_snapshot") = 'object')`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const rows: { present: boolean }[] = await queryRunner.query(
            `SELECT EXISTS(SELECT 1 FROM space_closure_processes WHERE proposal_snapshot IS NOT NULL OR has_bilateral_approval UNION ALL SELECT 1 FROM space_closure_history WHERE action IN ('PROPOSE_CLOSURE_PLAN','APPROVE_CLOSURE_PLAN','REJECT_CLOSURE_PLAN')) AS present`,
        );
        if (rows[0]?.present)
            throw new Error(
                'Cannot revert closure plan consensus with recorded history',
            );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" DROP CONSTRAINT "CHK_space_closure_processes_proposal_snapshot"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" DROP COLUMN "has_bilateral_approval"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" DROP COLUMN "proposal_snapshot"`,
        );
    }
}
