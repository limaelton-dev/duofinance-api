import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShoppingPurchaseCorrections1792345722826 implements MigrationInterface {
    name = 'ShoppingPurchaseCorrections1792345722826';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE "shopping_purchase_corrections" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "list_id" uuid NOT NULL, "item_id" uuid NOT NULL, "purchase_id" uuid NOT NULL, "previous_quantity" numeric(15,3) NOT NULL, "quantity" numeric(15,3) NOT NULL, "unit" character varying(30), "sequence" integer NOT NULL, "corrected_by_person_id" uuid NOT NULL, "corrected_by_member_id" uuid, "corrected_by_display_name" character varying(80) NOT NULL, "corrected_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_shopping_correction_version" UNIQUE ("list_id", "sequence"), CONSTRAINT "CHK_shopping_correction_values" CHECK (quantity >= 0 AND previous_quantity >= 0 AND sequence > 0 AND (unit IS NULL OR (length(unit) BETWEEN 1 AND 30 AND unit=btrim(unit)))), CONSTRAINT "PK_c71c7f2613656fea34fa2b19d19" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_shopping_correction_page" ON "shopping_purchase_corrections"  ("space_id", "list_id", "item_id", "purchase_id", "sequence") `,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_purchase_corrections" ADD CONSTRAINT "FK_shopping_correction_member" FOREIGN KEY ("space_id", "corrected_by_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_purchase_corrections" ADD CONSTRAINT "FK_shopping_correction_author" FOREIGN KEY ("corrected_by_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_purchase_corrections" ADD CONSTRAINT "FK_shopping_correction_purchase" FOREIGN KEY ("space_id", "list_id", "item_id", "purchase_id") REFERENCES "shopping_purchase_records"("space_id","list_id","item_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [usage] = await queryRunner.query(
            `SELECT EXISTS(SELECT 1 FROM shopping_purchase_corrections) AS used`,
        );
        if (usage.used)
            throw new Error(
                'Não é possível remover estruturas com histórico de correções de Compras.',
            );
        await queryRunner.query(
            `ALTER TABLE "shopping_purchase_corrections" DROP CONSTRAINT "FK_shopping_correction_purchase"`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_purchase_corrections" DROP CONSTRAINT "FK_shopping_correction_author"`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_purchase_corrections" DROP CONSTRAINT "FK_shopping_correction_member"`,
        );
        await queryRunner.query(`DROP TABLE "shopping_purchase_corrections"`);
    }
}
