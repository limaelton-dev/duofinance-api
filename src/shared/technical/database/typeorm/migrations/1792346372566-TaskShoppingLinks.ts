import { MigrationInterface, QueryRunner } from 'typeorm';

export class TaskShoppingLinks1792346372566 implements MigrationInterface {
    name = 'TaskShoppingLinks1792346372566';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" ADD "shopping_list_id" uuid`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_routine_task_shopping_list" ON "routine_tasks"  ("space_id", "shopping_list_id", "created_at", "id") `,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" ADD CONSTRAINT "FK_routine_task_shopping_list" FOREIGN KEY ("space_id", "shopping_list_id") REFERENCES "shopping_lists"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [usage] = await queryRunner.query(
            `SELECT EXISTS(SELECT 1 FROM routine_tasks WHERE shopping_list_id IS NOT NULL) OR EXISTS(SELECT 1 FROM routine_history WHERE type='SHOPPING_LIST_CHANGED') AS used`,
        );
        if (usage.used)
            throw new Error(
                'Não é possível remover estruturas com histórico de vínculos de tarefas e listas.',
            );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" DROP CONSTRAINT "FK_routine_task_shopping_list"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_routine_task_shopping_list"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" DROP COLUMN "shopping_list_id"`,
        );
    }
}
