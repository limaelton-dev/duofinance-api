import { MigrationInterface, QueryRunner } from 'typeorm';

export class ClosureFinancialResolution1792411805913 implements MigrationInterface {
    name = 'ClosureFinancialResolution1792411805913';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DROP INDEX "UQ_obligations_closure_agreement"`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_obligations_closure_agreement" ON inter_member_obligations(closure_agreement_id) WHERE remaining_amount_in_cents>0`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const rows: { present: boolean }[] = await queryRunner.query(
            `SELECT EXISTS(SELECT closure_agreement_id FROM inter_member_obligations WHERE closure_agreement_id IS NOT NULL GROUP BY closure_agreement_id HAVING COUNT(*)>1) AS present`,
        );
        if (rows[0]?.present)
            throw new Error(
                'Cannot revert closure agreement index with recorded corrections',
            );
        await queryRunner.query(
            `DROP INDEX "UQ_obligations_closure_agreement"`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_obligations_closure_agreement" ON inter_member_obligations(closure_agreement_id)`,
        );
    }
}
