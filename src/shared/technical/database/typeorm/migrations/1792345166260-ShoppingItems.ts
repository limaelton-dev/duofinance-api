import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShoppingItems1792345166260 implements MigrationInterface {
    name = 'ShoppingItems1792345166260';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE "shopping_items" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "list_id" uuid NOT NULL, "description" character varying(500) NOT NULL, "desired_quantity" numeric(15,3) NOT NULL, "unit" character varying(30), "creator_person_id" uuid NOT NULL, "creator_member_id" uuid, "creator_display_name" character varying(80) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_shopping_item_context" UNIQUE ("space_id", "list_id", "id"), CONSTRAINT "CHK_shopping_item_values" CHECK (length(description) BETWEEN 1 AND 500 AND description=btrim(description) AND desired_quantity > 0 AND (unit IS NULL OR (length(unit) BETWEEN 1 AND 30 AND unit=btrim(unit)))), CONSTRAINT "PK_36f295ec7314c9001968ca2c6f9" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_shopping_item_page" ON "shopping_items"  ("space_id", "list_id", "created_at", "id") `,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_items" ADD CONSTRAINT "FK_shopping_item_creator_member" FOREIGN KEY ("space_id", "creator_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_items" ADD CONSTRAINT "FK_shopping_item_creator" FOREIGN KEY ("creator_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_items" ADD CONSTRAINT "FK_shopping_item_list" FOREIGN KEY ("space_id", "list_id") REFERENCES "shopping_lists"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [usage] = await queryRunner.query(
            `SELECT EXISTS(SELECT 1 FROM shopping_items) AS used`,
        );
        if (usage.used)
            throw new Error(
                'Não é possível remover estruturas com histórico de itens de Compras.',
            );
        await queryRunner.query(
            `ALTER TABLE "shopping_items" DROP CONSTRAINT "FK_shopping_item_list"`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_items" DROP CONSTRAINT "FK_shopping_item_creator"`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_items" DROP CONSTRAINT "FK_shopping_item_creator_member"`,
        );
        await queryRunner.query(`DROP INDEX "public"."IDX_shopping_item_page"`);
        await queryRunner.query(`DROP TABLE "shopping_items"`);
    }
}
