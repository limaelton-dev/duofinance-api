import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShoppingItemRemoval1792346026336 implements MigrationInterface {
    name = 'ShoppingItemRemoval1792346026336';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "shopping_items" ADD "removed_at" TIMESTAMP WITH TIME ZONE`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [usage] = await queryRunner.query(
            `SELECT EXISTS(SELECT 1 FROM shopping_items WHERE removed_at IS NOT NULL) OR EXISTS(SELECT 1 FROM shopping_history WHERE type='ITEM_REMOVED') AS used`,
        );
        if (usage.used)
            throw new Error(
                'Não é possível remover a marcação com histórico de itens removidos.',
            );
        await queryRunner.query(
            `ALTER TABLE "shopping_items" DROP COLUMN "removed_at"`,
        );
    }
}
