import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShoppingLists1792344857988 implements MigrationInterface {
    name = 'ShoppingLists1792344857988';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE "shopping_lists" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "name" character varying(120), "status" character varying(8) NOT NULL, "version" integer NOT NULL, "creator_person_id" uuid NOT NULL, "creator_member_id" uuid, "creator_display_name" character varying(80) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "archived_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_shopping_list_space" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_shopping_list_values" CHECK (version > 0 AND (name IS NULL OR (length(name) BETWEEN 1 AND 120 AND name=btrim(name))) AND status IN ('ACTIVE','ARCHIVED') AND ((status='ARCHIVED')=(archived_at IS NOT NULL))), CONSTRAINT "PK_9289ace7dd5e768d65290f3f9de" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_shopping_list_page" ON "shopping_lists"  ("space_id", "status", "created_at", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "shopping_history" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "aggregate_id" uuid NOT NULL, "sequence" integer NOT NULL, "type" character varying(40) NOT NULL, "actor_id" uuid NOT NULL, "actor_member_id" uuid, "actor_display_name" character varying(80) NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "data" jsonb NOT NULL, CONSTRAINT "UQ_shopping_history_version" UNIQUE ("aggregate_id", "sequence"), CONSTRAINT "CHK_shopping_history_sequence" CHECK (sequence > 0), CONSTRAINT "PK_18bdb85f7ddfd4e5b89ccff18e9" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_shopping_history_page" ON "shopping_history"  ("space_id", "aggregate_id", "sequence") `,
        );
        await queryRunner.query(
            `CREATE TABLE "shopping_command_receipts" ("actor_id" uuid NOT NULL, "operation" character varying(60) NOT NULL, "key" uuid NOT NULL, "digest" character varying(64) NOT NULL, "result" jsonb NOT NULL, CONSTRAINT "PK_a3bbca01e5e5f22836c66d054df" PRIMARY KEY ("actor_id", "operation", "key"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "shopping_command_audit" ("id" uuid NOT NULL, "actor_id" uuid NOT NULL, "space_id" uuid NOT NULL, "aggregate_id" uuid NOT NULL, "action" character varying(60) NOT NULL, "key" uuid NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_0f4e734573a585eb3dd6f3175d2" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_shopping_audit_space" ON "shopping_command_audit"  ("space_id", "registered_at") `,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_lists" ADD CONSTRAINT "FK_shopping_list_creator_member" FOREIGN KEY ("space_id", "creator_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_lists" ADD CONSTRAINT "FK_shopping_list_creator" FOREIGN KEY ("creator_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_lists" ADD CONSTRAINT "FK_shopping_list_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_history" ADD CONSTRAINT "FK_shopping_history_member" FOREIGN KEY ("space_id", "actor_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_history" ADD CONSTRAINT "FK_shopping_history_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_history" ADD CONSTRAINT "FK_shopping_history_list" FOREIGN KEY ("space_id", "aggregate_id") REFERENCES "shopping_lists"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_command_receipts" ADD CONSTRAINT "FK_shopping_receipt_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_command_audit" ADD CONSTRAINT "FK_shopping_audit_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_command_audit" ADD CONSTRAINT "FK_shopping_audit_list" FOREIGN KEY ("space_id", "aggregate_id") REFERENCES "shopping_lists"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const [usage] = await queryRunner.query(
            `SELECT EXISTS(SELECT 1 FROM shopping_lists) OR EXISTS(SELECT 1 FROM shopping_history) OR EXISTS(SELECT 1 FROM shopping_command_receipts) OR EXISTS(SELECT 1 FROM shopping_command_audit) AS used`,
        );
        if (usage.used)
            throw new Error(
                'Não é possível remover estruturas com histórico de Compras.',
            );
        await queryRunner.query(
            `ALTER TABLE "shopping_command_audit" DROP CONSTRAINT "FK_shopping_audit_list"`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_command_audit" DROP CONSTRAINT "FK_shopping_audit_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_command_receipts" DROP CONSTRAINT "FK_shopping_receipt_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_history" DROP CONSTRAINT "FK_shopping_history_list"`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_history" DROP CONSTRAINT "FK_shopping_history_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_history" DROP CONSTRAINT "FK_shopping_history_member"`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_lists" DROP CONSTRAINT "FK_shopping_list_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_lists" DROP CONSTRAINT "FK_shopping_list_creator"`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_lists" DROP CONSTRAINT "FK_shopping_list_creator_member"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_shopping_audit_space"`,
        );
        await queryRunner.query(`DROP TABLE "shopping_command_audit"`);
        await queryRunner.query(`DROP TABLE "shopping_command_receipts"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_shopping_history_page"`,
        );
        await queryRunner.query(`DROP TABLE "shopping_history"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_shopping_list_page"`);
        await queryRunner.query(`DROP TABLE "shopping_lists"`);
    }
}
