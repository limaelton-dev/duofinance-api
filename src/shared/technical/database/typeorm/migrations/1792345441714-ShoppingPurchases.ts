import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShoppingPurchases1792345441714 implements MigrationInterface {
    name = 'ShoppingPurchases1792345441714';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE "shopping_purchase_records" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "list_id" uuid NOT NULL, "item_id" uuid NOT NULL, "quantity" numeric(15,3) NOT NULL, "unit" character varying(30), "registered_by_person_id" uuid NOT NULL, "registered_by_member_id" uuid, "registered_by_display_name" character varying(80) NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_shopping_purchase_context" UNIQUE ("space_id", "list_id", "item_id", "id"), CONSTRAINT "CHK_shopping_purchase_values" CHECK (quantity > 0 AND (unit IS NULL OR (length(unit) BETWEEN 1 AND 30 AND unit=btrim(unit)))), CONSTRAINT "PK_4d2a47400e7af85714759510bfe" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_shopping_purchase_page" ON "shopping_purchase_records"  ("space_id", "list_id", "item_id", "registered_at", "id") `,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_purchase_records" ADD CONSTRAINT "FK_shopping_purchase_member" FOREIGN KEY ("space_id", "registered_by_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_purchase_records" ADD CONSTRAINT "FK_shopping_purchase_author" FOREIGN KEY ("registered_by_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_purchase_records" ADD CONSTRAINT "FK_shopping_purchase_item" FOREIGN KEY ("space_id", "list_id", "item_id") REFERENCES "shopping_items"("space_id","list_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [usage] = await queryRunner.query(
            `SELECT EXISTS(SELECT 1 FROM shopping_purchase_records) AS used`,
        );
        if (usage.used)
            throw new Error(
                'Não é possível remover estruturas com histórico de compras registradas.',
            );
        await queryRunner.query(
            `ALTER TABLE "shopping_purchase_records" DROP CONSTRAINT "FK_shopping_purchase_item"`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_purchase_records" DROP CONSTRAINT "FK_shopping_purchase_author"`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_purchase_records" DROP CONSTRAINT "FK_shopping_purchase_member"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_shopping_purchase_page"`,
        );
        await queryRunner.query(`DROP TABLE "shopping_purchase_records"`);
    }
}
