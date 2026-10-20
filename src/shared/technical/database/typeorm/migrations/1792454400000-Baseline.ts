import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Baseline1792454400000 implements MigrationInterface {
    name = 'Baseline1792454400000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE "routine_tasks" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "description" character varying(500) NOT NULL, "creator_person_id" uuid NOT NULL, "creator_member_id" uuid, "assignee_person_id" uuid, "assignee_member_id" uuid, "deadline_date" date, "deadline_time" character varying(5), "urgency" character varying(10) NOT NULL, "status" character varying(12) NOT NULL, "version" integer NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "completion" jsonb, "shopping_list_id" uuid, CONSTRAINT "UQ_routine_task_space" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_routine_task_values" CHECK (version > 0 AND length(description) BETWEEN 1 AND 500 AND description=btrim(description) AND urgency IN ('LOW','NORMAL','HIGH','URGENT') AND status IN ('PENDING','COMPLETED','CANCELLED') AND (deadline_time IS NULL OR (deadline_date IS NOT NULL AND deadline_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')) AND ((status='COMPLETED')=(completion IS NOT NULL)) AND (assignee_member_id IS NULL OR assignee_person_id IS NOT NULL)), CONSTRAINT "PK_6474faef320dbde49988984c9e3" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_routine_task_shopping_list" ON "routine_tasks"  ("space_id", "shopping_list_id", "created_at", "id") `,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_routine_task_assignee" ON "routine_tasks"  ("space_id", "assignee_person_id", "status") `,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_routine_task_list" ON "routine_tasks"  ("space_id", "status", "urgency", "deadline_date", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "routine_history" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "aggregate_id" uuid NOT NULL, "sequence" integer NOT NULL, "type" character varying(40) NOT NULL, "actor_id" uuid NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "data" jsonb NOT NULL, CONSTRAINT "UQ_routine_history_version" UNIQUE ("aggregate_id", "sequence"), CONSTRAINT "PK_c106e063288c9686f7bd2363ccd" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_routine_history_page" ON "routine_history"  ("space_id", "aggregate_id", "sequence") `,
        );
        await queryRunner.query(
            `CREATE TABLE "routine_command_receipts" ("actor_id" uuid NOT NULL, "operation" character varying(60) NOT NULL, "key" uuid NOT NULL, "digest" character varying(64) NOT NULL, "result" jsonb NOT NULL, CONSTRAINT "PK_659ab1e28b31ce47f8147a8a5f0" PRIMARY KEY ("actor_id", "operation", "key"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "routine_command_audit" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "actor_id" uuid NOT NULL, "action" character varying(60) NOT NULL, "aggregate_id" uuid NOT NULL, "key" uuid NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_aa3fc2df3a4b43eb9eb455c5613" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_routine_audit_space" ON "routine_command_audit"  ("space_id", "registered_at") `,
        );
        await queryRunner.query(
            `CREATE TABLE "shopping_lists" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "name" character varying(120), "status" character varying(8) NOT NULL, "version" integer NOT NULL, "creator_person_id" uuid NOT NULL, "creator_member_id" uuid, "creator_display_name" character varying(80) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "archived_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_shopping_list_space" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_shopping_list_values" CHECK (version > 0 AND (name IS NULL OR (length(name) BETWEEN 1 AND 120 AND name=btrim(name))) AND status IN ('ACTIVE','ARCHIVED') AND ((status='ARCHIVED')=(archived_at IS NOT NULL))), CONSTRAINT "PK_9289ace7dd5e768d65290f3f9de" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_shopping_list_page" ON "shopping_lists"  ("space_id", "status", "created_at", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "shopping_items" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "list_id" uuid NOT NULL, "description" character varying(500) NOT NULL, "desired_quantity" numeric(15,3) NOT NULL, "unit" character varying(30), "creator_person_id" uuid NOT NULL, "creator_member_id" uuid, "creator_display_name" character varying(80) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "removed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_shopping_item_context" UNIQUE ("space_id", "list_id", "id"), CONSTRAINT "CHK_shopping_item_values" CHECK (length(description) BETWEEN 1 AND 500 AND description=btrim(description) AND desired_quantity > 0 AND (unit IS NULL OR (length(unit) BETWEEN 1 AND 30 AND unit=btrim(unit)))), CONSTRAINT "PK_36f295ec7314c9001968ca2c6f9" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_shopping_item_page" ON "shopping_items"  ("space_id", "list_id", "created_at", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "shopping_purchase_records" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "list_id" uuid NOT NULL, "item_id" uuid NOT NULL, "quantity" numeric(15,3) NOT NULL, "unit" character varying(30), "registered_by_person_id" uuid NOT NULL, "registered_by_member_id" uuid, "registered_by_display_name" character varying(80) NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_shopping_purchase_context" UNIQUE ("space_id", "list_id", "item_id", "id"), CONSTRAINT "CHK_shopping_purchase_values" CHECK (quantity > 0 AND (unit IS NULL OR (length(unit) BETWEEN 1 AND 30 AND unit=btrim(unit)))), CONSTRAINT "PK_4d2a47400e7af85714759510bfe" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_shopping_purchase_page" ON "shopping_purchase_records"  ("space_id", "list_id", "item_id", "registered_at", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "shopping_purchase_corrections" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "list_id" uuid NOT NULL, "item_id" uuid NOT NULL, "purchase_id" uuid NOT NULL, "previous_quantity" numeric(15,3) NOT NULL, "quantity" numeric(15,3) NOT NULL, "unit" character varying(30), "sequence" integer NOT NULL, "corrected_by_person_id" uuid NOT NULL, "corrected_by_member_id" uuid, "corrected_by_display_name" character varying(80) NOT NULL, "corrected_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_shopping_correction_version" UNIQUE ("list_id", "sequence"), CONSTRAINT "CHK_shopping_correction_values" CHECK (quantity >= 0 AND previous_quantity >= 0 AND sequence > 0 AND (unit IS NULL OR (length(unit) BETWEEN 1 AND 30 AND unit=btrim(unit)))), CONSTRAINT "PK_c71c7f2613656fea34fa2b19d19" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_shopping_correction_page" ON "shopping_purchase_corrections"  ("space_id", "list_id", "item_id", "purchase_id", "sequence") `,
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
            `CREATE TABLE "routine_task_recurrences" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "creator_person_id" uuid NOT NULL, "starts_on" date NOT NULL, "ends_on" date, "cancelled_on" date, "status" character varying(12) NOT NULL, "version" integer NOT NULL, "snapshot" jsonb NOT NULL, CONSTRAINT "UQ_routine_recurrence_space" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_routine_recurrence_values" CHECK (version>0 AND (ends_on IS NULL OR ends_on>=starts_on) AND status IN ('ACTIVE','CANCELLED') AND ((status='CANCELLED')=(cancelled_on IS NOT NULL))), CONSTRAINT "PK_a083cc441d271a29fd0187d7ad4" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_routine_recurrence_space" ON "routine_task_recurrences"  ("space_id", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "routine_task_occurrences" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "recurrence_id" uuid NOT NULL, "scheduled_date" date NOT NULL, "status" character varying(12) NOT NULL, "version" integer NOT NULL, "snapshot" jsonb NOT NULL, CONSTRAINT "UQ_routine_occurrence_date" UNIQUE ("recurrence_id", "scheduled_date"), CONSTRAINT "CHK_routine_occurrence_values" CHECK (version>0 AND status IN ('PENDING','COMPLETED','SKIPPED','CANCELLED')), CONSTRAINT "PK_ea5add7b8c4baf236ae8ed87e86" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_routine_occurrence_list" ON "routine_task_occurrences"  ("space_id", "status", "scheduled_date", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "default_settlement_rules" ("space_id" uuid NOT NULL, "kind" character varying NOT NULL, "day_of_month" smallint NOT NULL, "version" integer NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "default_settlement_rules_version_check" CHECK (version > 0), CONSTRAINT "default_settlement_rules_day_of_month_check" CHECK (day_of_month BETWEEN 1 AND 31), CONSTRAINT "default_settlement_rules_kind_check" CHECK (kind = 'MONTHLY_DAY'), CONSTRAINT "PK_default_settlement_rules" PRIMARY KEY ("space_id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "default_settlement_rule_changes" ("space_id" uuid NOT NULL, "version" integer NOT NULL, "actor_person_id" uuid NOT NULL, "previous_kind" character varying, "previous_day_of_month" smallint, "kind" character varying NOT NULL, "day_of_month" smallint NOT NULL, "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "default_settlement_rule_changes_check1" CHECK ((version = 1 AND previous_kind IS NULL) OR (version > 1 AND previous_kind IS NOT NULL)), CONSTRAINT "default_settlement_rule_changes_check" CHECK ((previous_kind IS NULL AND previous_day_of_month IS NULL) OR (previous_kind IS NOT NULL AND previous_day_of_month IS NOT NULL AND previous_kind = 'MONTHLY_DAY' AND previous_day_of_month BETWEEN 1 AND 31)), CONSTRAINT "default_settlement_rule_changes_day_of_month_check" CHECK (day_of_month BETWEEN 1 AND 31), CONSTRAINT "default_settlement_rule_changes_kind_check" CHECK (kind = 'MONTHLY_DAY'), CONSTRAINT "default_settlement_rule_changes_version_check" CHECK (version > 0), CONSTRAINT "PK_default_settlement_rule_changes" PRIMARY KEY ("space_id", "version"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_commitments" ("id" uuid NOT NULL, "personal_owner_person_id" uuid, "space_id" uuid NOT NULL, "kind" character varying(16) NOT NULL, "modality" character varying(16) NOT NULL, "description" character varying(160) NOT NULL, "created_by" uuid NOT NULL, "version" integer NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_financial_commitments_space_id" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_financial_commitments_scope" CHECK (kind IN ('EXPENSE','INCOME') AND modality IN ('ONE_TIME','RECURRING','INSTALLMENT') AND version > 0 AND length(description) BETWEEN 1 AND 160 AND description = btrim(description) AND (personal_owner_person_id IS NULL OR modality <> 'ONE_TIME' OR personal_owner_person_id=created_by)), CONSTRAINT "PK_ec16b836a513083006ee92bb919" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_financial_commitments_space_registered" ON "financial_commitments"  ("space_id", "registered_at", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_commitment_versions" ("commitment_id" uuid NOT NULL, "version" integer NOT NULL, "space_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, "expected_payer_member_id" uuid, "fact_date" date, "expected_payment_date" date, "split_mode" character varying(16), "split_input" jsonb, "rule_snapshot" jsonb, "rule_source_version" integer NOT NULL, "suggested_target_date" date, CONSTRAINT "UQ_financial_versions_space" UNIQUE ("space_id", "commitment_id", "version"), CONSTRAINT "CHK_financial_versions_values" CHECK ("amount_in_cents" >= 1 AND "amount_in_cents" <= 9007199254740991 AND version = 1 AND (fact_date IS NOT NULL OR expected_payment_date IS NOT NULL) AND ((split_mode IS NOT NULL AND split_mode IN ('AMOUNTS','PERCENTAGES') AND split_input IS NOT NULL) OR (split_mode IS NULL AND split_input IS NULL AND expected_payer_member_id IS NULL AND rule_snapshot IS NULL AND rule_source_version = 0 AND suggested_target_date IS NULL)) AND rule_source_version >= 0 AND (rule_snapshot IS NULL) = (rule_source_version = 0) AND (suggested_target_date IS NULL OR rule_snapshot IS NOT NULL)), CONSTRAINT "PK_84c12685a2edbc990c30df40422" PRIMARY KEY ("commitment_id", "version"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_commitment_shares" ("commitment_id" uuid NOT NULL, "version" integer NOT NULL, "member_id" uuid NOT NULL, "space_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, "split_mode" character varying(16) NOT NULL, "original_amount_in_cents" bigint, "basis_points" integer, CONSTRAINT "CHK_financial_shares_values" CHECK ("amount_in_cents" >= 0 AND "amount_in_cents" <= 9007199254740991 AND ((split_mode = 'AMOUNTS' AND original_amount_in_cents IS NOT NULL AND original_amount_in_cents = amount_in_cents AND basis_points IS NULL) OR (split_mode = 'PERCENTAGES' AND original_amount_in_cents IS NULL AND basis_points IS NOT NULL AND basis_points BETWEEN 0 AND 10000))), CONSTRAINT "PK_fe330172ddbfc1beb57fb732487" PRIMARY KEY ("commitment_id", "version", "member_id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_disbursements" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "occurrence_id" uuid, "sequence" integer NOT NULL, "recorded_by_person_id" uuid NOT NULL, "version" integer NOT NULL, "payer_member_id" uuid, "payer_person_id" uuid, "amount_in_cents" bigint NOT NULL, "method" character varying(8) NOT NULL, "fact_date" date NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_financial_disbursements_origin" UNIQUE ("space_id", "commitment_id", "id"), CONSTRAINT "UQ_disbursement_sequence" UNIQUE ("commitment_id", "sequence"), CONSTRAINT "CHK_financial_disbursements_values" CHECK ("amount_in_cents" >= 1 AND "amount_in_cents" <= 9007199254740991 AND method IN ('PIX','DEBIT','CASH') AND version = 1 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((payer_member_id IS NOT NULL AND payer_person_id IS NULL) OR (payer_member_id IS NULL AND payer_person_id IS NOT NULL))), CONSTRAINT "CHK_disbursement_sequence" CHECK (sequence > 0), CONSTRAINT "PK_7c6e756a33ad009770ab3ba506b" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_financial_disbursements_occurrence" ON "financial_disbursements"  ("space_id", "occurrence_id") WHERE occurrence_id IS NOT NULL`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_external_liabilities" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "occurrence_id" uuid, "sequence" integer NOT NULL, "version" integer NOT NULL, "holder_member_id" uuid, "holder_person_id" uuid, "recorded_by_person_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, "remaining_amount_in_cents" bigint NOT NULL, "fact_date" date NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_external_liabilities_sequence" UNIQUE ("commitment_id", "sequence"), CONSTRAINT "UQ_external_liabilities_origin" UNIQUE ("space_id", "commitment_id", "id"), CONSTRAINT "CHK_external_liabilities_values" CHECK ("amount_in_cents" >= 1 AND "amount_in_cents" <= 9007199254740991 AND sequence > 0 AND version = 1 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND num_nonnulls(holder_member_id, holder_person_id) = 1 AND remaining_amount_in_cents >= 0 AND remaining_amount_in_cents <= amount_in_cents), CONSTRAINT "PK_014e3500882bb1118066260fa79" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_financial_external_liabilities_occurrence" ON "financial_external_liabilities"  ("space_id", "occurrence_id") WHERE occurrence_id IS NOT NULL`,
        );
        await queryRunner.query(
            `CREATE TABLE "settlement_cycles" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "target_date" date NOT NULL, "status" character varying(16) NOT NULL, "version" integer NOT NULL, "finalized_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_settlement_cycles_space_id" UNIQUE ("space_id", "id"), CONSTRAINT "UQ_settlement_cycles_space_date" UNIQUE ("space_id", "target_date"), CONSTRAINT "CHK_settlement_cycles_state" CHECK (version > 0 AND ((status = 'OPEN' AND finalized_at IS NULL) OR (status = 'FINALIZED' AND finalized_at IS NOT NULL))), CONSTRAINT "PK_7e0d542d0bd8221433e210b92b1" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_settlement_cycles_open" ON "settlement_cycles"  ("space_id", "status", "target_date", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "inter_member_obligations" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "occurrence_id" uuid, "closure_agreement_id" uuid, "disbursement_id" uuid, "receipt_id" uuid, "external_liability_id" uuid, "debtor_member_id" uuid NOT NULL, "creditor_member_id" uuid NOT NULL, "original_amount_in_cents" bigint NOT NULL, "recognized_amount_in_cents" bigint NOT NULL, "remaining_amount_in_cents" bigint NOT NULL, "status" character varying(24) NOT NULL, "cycle_id" uuid, "version" integer NOT NULL, "fact_date" date NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_obligations_space_id" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_obligations_origin_xor" CHECK (num_nonnulls(disbursement_id, receipt_id, external_liability_id, closure_agreement_id) = 1), CONSTRAINT "CHK_obligations_state" CHECK ("original_amount_in_cents" >= 1 AND "original_amount_in_cents" <= 9007199254740991 AND "recognized_amount_in_cents" >= 0 AND "recognized_amount_in_cents" <= 9007199254740991 AND "remaining_amount_in_cents" >= 0 AND "remaining_amount_in_cents" <= 9007199254740991 AND remaining_amount_in_cents <= recognized_amount_in_cents AND debtor_member_id <> creditor_member_id AND version > 0 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((status = 'OPEN' AND remaining_amount_in_cents > 0 AND remaining_amount_in_cents = recognized_amount_in_cents) OR (status = 'PARTIALLY_SETTLED' AND remaining_amount_in_cents > 0 AND remaining_amount_in_cents < recognized_amount_in_cents) OR (status IN ('SETTLED','RECONCILED','WAIVED') AND remaining_amount_in_cents = 0))), CONSTRAINT "PK_a3f35f0eacff91c7440c49527ec" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_obligations_space_cycle" ON "inter_member_obligations"  ("space_id", "cycle_id") `,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_obligations_closure_agreement" ON "inter_member_obligations"  ("closure_agreement_id") WHERE remaining_amount_in_cents > 0`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_obligations_space_origin" ON "inter_member_obligations"  ("space_id", "commitment_id") `,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_obligations_open_occurrence" ON "inter_member_obligations"  ("space_id", "occurrence_id") WHERE remaining_amount_in_cents > 0 AND occurrence_id IS NOT NULL AND closure_agreement_id IS NULL`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_obligations_open_one_time" ON "inter_member_obligations"  ("space_id", "commitment_id") WHERE remaining_amount_in_cents > 0 AND occurrence_id IS NULL AND closure_agreement_id IS NULL`,
        );
        await queryRunner.query(
            `CREATE TABLE "inter_member_obligation_changes" ("obligation_id" uuid NOT NULL, "version" integer NOT NULL, "space_id" uuid NOT NULL, "actor_id" uuid NOT NULL, "type" character varying(24) NOT NULL, "allocation_id" uuid, "snapshot" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_obligation_changes_allocation" UNIQUE ("allocation_id"), CONSTRAINT "CHK_obligation_changes_type" CHECK ((version = 1 AND type = 'CREATED' AND allocation_id IS NULL) OR (version > 1 AND type = 'SETTLEMENT_APPLIED' AND allocation_id IS NOT NULL) OR (version > 1 AND type IN ('RECONCILED','ASSIGNMENT_CHANGED','OFFSET_APPLIED','WAIVED','REVERSED') AND allocation_id IS NULL)), CONSTRAINT "PK_626e767d3e35ca7b2d290ec7e02" PRIMARY KEY ("obligation_id", "version"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_expense_command_receipts" ("actor_id" uuid NOT NULL, "operation" character varying(40) NOT NULL, "idempotency_key" uuid NOT NULL, "request_hash" bytea NOT NULL, "status" character varying(16) NOT NULL, "commitment_id" uuid NOT NULL, "result" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_expense_receipt" CHECK (operation IN ('RECORD_SHARED_CASH_EXPENSE','RECORD_PERSONAL_EXPENSE','RECORD_EXPENSE_DISBURSEMENT','RECORD_CREDIT_CARD_PURCHASE','RECORD_EXTERNAL_LIABILITY','SETTLE_EXTERNAL_LIABILITY','CREATE_PLANNED_EXPENSE') AND status = 'COMPLETED' AND octet_length(request_hash) = 32), CONSTRAINT "PK_12cb2fc5905ff45de68ddff62a5" PRIMARY KEY ("actor_id", "operation", "idempotency_key"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_external_liability_settlements" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "external_liability_id" uuid NOT NULL, "sequence" integer NOT NULL, "holder_member_id" uuid, "holder_person_id" uuid, "recorded_by_person_id" uuid NOT NULL, "receipt_operation" character varying(40), "idempotency_key" uuid, "amount_in_cents" bigint NOT NULL, "fact_date" date NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_external_settlement_origin" UNIQUE ("space_id", "commitment_id", "id"), CONSTRAINT "UQ_external_settlement_sequence" UNIQUE ("commitment_id", "sequence"), CONSTRAINT "CHK_external_settlement_values" CHECK (amount_in_cents BETWEEN 1 AND 9007199254740991 AND sequence > 1 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND num_nonnulls(holder_member_id,holder_person_id)=1 AND ((receipt_operation='SETTLE_EXTERNAL_LIABILITY' AND idempotency_key IS NOT NULL) OR (receipt_operation IS NULL AND idempotency_key IS NULL))), CONSTRAINT "financial_external_liability_settlements_pkey" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "finances_command_receipts" ("actor_id" uuid NOT NULL, "operation" character varying NOT NULL, "key" uuid NOT NULL, "request_hash" bytea NOT NULL, "status" character varying NOT NULL, "result_space_id" uuid NOT NULL, "result_version" integer NOT NULL, "changed" boolean NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "finances_command_receipts_result_version_check" CHECK (result_version > 0), CONSTRAINT "finances_command_receipts_status_check" CHECK (status = 'COMPLETED'), CONSTRAINT "finances_command_receipts_request_hash_check" CHECK (octet_length(request_hash) = 32), CONSTRAINT "finances_command_receipts_operation_check" CHECK (operation = 'CONFIGURE_DEFAULT_SETTLEMENT_RULE'), CONSTRAINT "PK_finances_command_receipts" PRIMARY KEY ("actor_id", "operation", "key"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_commitment_change_proposals" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "version" integer NOT NULL, "base_version" integer NOT NULL, "origin_fingerprint" character varying(32) NOT NULL, "proposed_by_member_id" uuid NOT NULL, "recipient_member_id" uuid NOT NULL, "actor_id" uuid NOT NULL, "effective_from" date NOT NULL, "configuration" jsonb NOT NULL, "impact" jsonb NOT NULL, "status" character varying(16) NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "decided_at" TIMESTAMP WITH TIME ZONE, "decided_by_person_id" uuid, CONSTRAINT "UQ_commitment_change_proposal_origin" UNIQUE ("space_id", "commitment_id", "id"), CONSTRAINT "CHK_commitment_change_proposal_state" CHECK (version > 0 AND base_version > 0 AND proposed_by_member_id <> recipient_member_id AND status IN ('PROPOSED','ACCEPTED','REJECTED','CANCELLED') AND (status='PROPOSED')=(decided_at IS NULL) AND (decided_at IS NULL)=(decided_by_person_id IS NULL)), CONSTRAINT "PK_8782c3d4d1d5875c5bc24eec014" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_commitment_change_proposals_recipient" ON "financial_commitment_change_proposals"  ("space_id", "recipient_member_id", "status", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_integrity_command_receipts" ("actor_id" uuid NOT NULL, "operation" character varying(40) NOT NULL, "idempotency_key" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "request_hash" bytea NOT NULL, "result" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_integrity_command_receipt_hash" CHECK (octet_length(request_hash)=32), CONSTRAINT "PK_a41b56c90d10ea28794ba0aadce" PRIMARY KEY ("actor_id", "operation", "idempotency_key"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_closure_effects" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "origin_id" uuid NOT NULL, "process_id" uuid NOT NULL, "plan_revision" integer NOT NULL, "actor_id" uuid NOT NULL, "cutoff_date" date NOT NULL, "snapshot" jsonb NOT NULL, "successor_commitment_id" uuid, "result" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_financial_closure_effect_scope" UNIQUE ("space_id", "origin_id", "id"), CONSTRAINT "UQ_financial_closure_effect_origin" UNIQUE ("space_id", "origin_id"), CONSTRAINT "CHK_financial_closure_effect_revision" CHECK (plan_revision>0), CONSTRAINT "PK_7092ee54835387f39338f883e9a" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_command_audit" ("actor_id" uuid NOT NULL, "action" character varying(40) NOT NULL, "idempotency_key" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_46d635f611e473e2324edaf54a2" PRIMARY KEY ("actor_id", "action", "idempotency_key"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_financial_command_audit_origin" ON "financial_command_audit"  ("space_id", "commitment_id", "registered_at") `,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_fulfillment_reversals" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "target_id" uuid NOT NULL, "occurrence_id" uuid, "installment_id" uuid, "commitment_version" integer NOT NULL, "original_kind" character varying(24) NOT NULL, "original_id" uuid NOT NULL, "disbursement_id" uuid, "external_liability_id" uuid, "external_settlement_id" uuid, "receipt_id" uuid, "amount_in_cents" bigint NOT NULL, "reason" character varying(500) NOT NULL, "fact_date" date NOT NULL, "actor_id" uuid NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_fulfillment_reversal_version" UNIQUE ("space_id", "commitment_id", "commitment_version"), CONSTRAINT "CHK_fulfillment_reversal_values" CHECK (commitment_version>1 AND amount_in_cents BETWEEN 1 AND 9007199254740991 AND length(reason) BETWEEN 1 AND 500 AND reason=btrim(reason) AND fact_date<=(registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND num_nonnulls(disbursement_id,external_liability_id,external_settlement_id,receipt_id)=1 AND original_id=COALESCE(disbursement_id,external_liability_id,external_settlement_id,receipt_id) AND ((original_kind='DISBURSEMENT' AND disbursement_id IS NOT NULL) OR (original_kind='EXTERNAL_LIABILITY' AND external_liability_id IS NOT NULL) OR (original_kind='EXTERNAL_SETTLEMENT' AND external_settlement_id IS NOT NULL) OR (original_kind='RECEIPT' AND receipt_id IS NOT NULL)) AND ((occurrence_id IS NULL AND installment_id IS NULL AND target_id=commitment_id) OR (occurrence_id IS NOT NULL AND target_id=occurrence_id AND (installment_id IS NULL OR installment_id=occurrence_id)))), CONSTRAINT "PK_9a2655a4559786da93c4730e017" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_fulfillment_reversal_target" ON "financial_fulfillment_reversals"  ("space_id", "commitment_id", "target_id") `,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_fulfillment_reversal_original" ON "financial_fulfillment_reversals"  ("space_id", "commitment_id", "original_id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_commitment_adjustments" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "target_id" uuid NOT NULL, "occurrence_id" uuid, "installment_id" uuid, "commitment_version" integer NOT NULL, "direction" character varying(8) NOT NULL, "amount_in_cents" bigint NOT NULL, "reason" character varying(500) NOT NULL, "fact_date" date NOT NULL, "actor_id" uuid NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "previous_amount_in_cents" bigint NOT NULL, "resulting_amount_in_cents" bigint NOT NULL, "economic_shares" jsonb, "share_changes" jsonb, "proposal_id" uuid, CONSTRAINT "UQ_commitment_adjustment_version" UNIQUE ("space_id", "commitment_id", "commitment_version"), CONSTRAINT "CHK_commitment_adjustment_values" CHECK (commitment_version>1 AND direction IN ('INCREASE','DECREASE') AND amount_in_cents BETWEEN 1 AND 9007199254740991 AND previous_amount_in_cents BETWEEN 0 AND 9007199254740991 AND resulting_amount_in_cents BETWEEN 0 AND 9007199254740991 AND resulting_amount_in_cents=previous_amount_in_cents+CASE WHEN direction='INCREASE' THEN amount_in_cents ELSE -amount_in_cents END AND length(reason) BETWEEN 1 AND 500 AND reason=btrim(reason) AND fact_date<=(registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((occurrence_id IS NULL AND installment_id IS NULL AND target_id=commitment_id) OR (occurrence_id IS NOT NULL AND target_id=occurrence_id AND (installment_id IS NULL OR installment_id=occurrence_id)))), CONSTRAINT "PK_a2cdbed4a9485bc59b5e8d1c392" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_commitment_adjustment_target" ON "financial_commitment_adjustments"  ("space_id", "commitment_id", "target_id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_commitment_cancellations" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "commitment_version" integer NOT NULL, "reason" character varying(500) NOT NULL, "fact_date" date NOT NULL, "actor_id" uuid NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_commitment_cancellation_root" UNIQUE ("space_id", "commitment_id"), CONSTRAINT "CHK_commitment_cancellation_values" CHECK (commitment_version>1 AND length(reason) BETWEEN 1 AND 500 AND reason=btrim(reason) AND fact_date<=(registered_at AT TIME ZONE 'America/Sao_Paulo')::date), CONSTRAINT "PK_b61dead72706e2232954e2a0668" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_non_recurring_versions" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "target_id" uuid NOT NULL, "installment_id" uuid, "version" integer NOT NULL, "effective_from" date NOT NULL, "description" character varying(160) NOT NULL, "amount_in_cents" bigint NOT NULL, "distribution" jsonb, "economic_shares" jsonb, "expected_member_id" uuid, "actor_id" uuid NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_non_recurring_version_effective" UNIQUE ("space_id", "commitment_id", "target_id", "effective_from"), CONSTRAINT "UQ_non_recurring_version_target" UNIQUE ("space_id", "commitment_id", "version", "target_id"), CONSTRAINT "CHK_non_recurring_version_values" CHECK (version > 1 AND amount_in_cents BETWEEN 1 AND 9007199254740991 AND length(description) BETWEEN 1 AND 160 AND description=btrim(description) AND ((installment_id IS NULL AND target_id=commitment_id) OR (installment_id IS NOT NULL AND installment_id=target_id)) AND ((distribution IS NULL AND economic_shares IS NULL AND expected_member_id IS NULL) OR (distribution IS NOT NULL AND economic_shares IS NOT NULL))), CONSTRAINT "PK_d0bbdcc1a707028b34e4f9bc19e" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_non_recurring_version_selection" ON "financial_non_recurring_versions"  ("space_id", "commitment_id", "target_id", "effective_from") `,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_income_versions" ("commitment_id" uuid NOT NULL, "space_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, "expected_receipt_date" date NOT NULL, "owner_person_id" uuid, "split_input" jsonb, "expected_recipient_member_id" uuid, "rule_snapshot" jsonb, "rule_source_version" integer NOT NULL, CONSTRAINT "UQ_income_versions_space" UNIQUE ("space_id", "commitment_id"), CONSTRAINT "CHK_income_versions_values" CHECK (amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND ((owner_person_id IS NOT NULL AND split_input IS NULL AND expected_recipient_member_id IS NULL AND rule_snapshot IS NULL AND rule_source_version = 0) OR (owner_person_id IS NULL AND split_input IS NOT NULL AND (rule_snapshot IS NULL) = (rule_source_version = 0)))), CONSTRAINT "PK_62b2fe3e149abebbca4e1c226cc" PRIMARY KEY ("commitment_id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_income_shares" ("commitment_id" uuid NOT NULL, "member_id" uuid NOT NULL, "space_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, CONSTRAINT "CHK_income_shares_values" CHECK (amount_in_cents >= 0 AND amount_in_cents <= 9007199254740991), CONSTRAINT "PK_e28c00d398bca722360a44265e8" PRIMARY KEY ("commitment_id", "member_id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_receipts" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "occurrence_id" uuid, "sequence" integer NOT NULL, "amount_in_cents" bigint NOT NULL, "fact_date" date NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "recorded_by_person_id" uuid NOT NULL, "recipient_person_id" uuid, "recipient_member_id" uuid, CONSTRAINT "UQ_financial_receipts_origin" UNIQUE ("space_id", "commitment_id", "id"), CONSTRAINT "UQ_receipt_sequence" UNIQUE ("commitment_id", "sequence"), CONSTRAINT "CHK_financial_receipts_values" CHECK (amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((recipient_person_id IS NOT NULL AND recipient_member_id IS NULL) OR (recipient_person_id IS NULL AND recipient_member_id IS NOT NULL))), CONSTRAINT "CHK_receipt_sequence" CHECK (sequence > 0), CONSTRAINT "PK_346bc406f82e17f3eb446ba0d94" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_financial_receipts_occurrence" ON "financial_receipts"  ("space_id", "occurrence_id") WHERE occurrence_id IS NOT NULL`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_income_command_receipts" ("actor_id" uuid NOT NULL, "operation" character varying(32) NOT NULL, "idempotency_key" uuid NOT NULL, "request_hash" bytea NOT NULL, "status" character varying(16) NOT NULL, "commitment_id" uuid NOT NULL, "result" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_income_command_receipts" CHECK (operation IN ('RECORD_INCOME','RECORD_INCOME_RECEIPT') AND status = 'COMPLETED' AND octet_length(request_hash) = 32), CONSTRAINT "PK_68b291af2dc53155163870cfd7b" PRIMARY KEY ("actor_id", "operation", "idempotency_key"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "obligation_waivers" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "obligation_id" uuid NOT NULL, "creditor_member_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, "fact_date" date NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_by" uuid NOT NULL, "reason" character varying(500), CONSTRAINT "UQ_obligation_waiver_space_id" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_obligation_waiver_values" CHECK (amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND (reason IS NULL OR (length(reason) BETWEEN 1 AND 500 AND reason = btrim(reason)))), CONSTRAINT "PK_00bbf487ff78d0a5a780160ce1d" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_obligation_waiver_origin" ON "obligation_waivers"  ("space_id", "obligation_id", "registered_at", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_installment_plans" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "installment_count" integer NOT NULL, "total_amount_in_cents" bigint NOT NULL, "cadence" character varying(8) NOT NULL, "planned_payment_method" character varying(8), "split_input" jsonb, "expected_member_id" uuid, "rule_snapshot" jsonb, "rule_source_version" integer NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_installment_plans_commitment" UNIQUE ("space_id", "commitment_id"), CONSTRAINT "UQ_installment_plans_origin" UNIQUE ("space_id", "commitment_id", "id"), CONSTRAINT "CHK_installment_plans_values" CHECK (installment_count > 0 AND total_amount_in_cents BETWEEN 1 AND 9007199254740991 AND cadence IN ('MONTHLY','ANNUAL','EXPLICIT') AND (planned_payment_method IS NULL OR planned_payment_method IN ('CARD','PIX','DEBIT','CASH')) AND rule_source_version >= 0 AND (rule_snapshot IS NULL)=(rule_source_version=0) AND ((split_input IS NULL AND expected_member_id IS NULL) OR split_input IS NOT NULL)), CONSTRAINT "PK_installment_plans" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_installments" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "plan_id" uuid NOT NULL, "position" integer NOT NULL, "due_date" date NOT NULL, "amount_in_cents" bigint NOT NULL, CONSTRAINT "UQ_installments_due_date" UNIQUE ("plan_id", "due_date"), CONSTRAINT "UQ_installments_position" UNIQUE ("plan_id", "position"), CONSTRAINT "UQ_installments_origin" UNIQUE ("space_id", "commitment_id", "id"), CONSTRAINT "CHK_installments_values" CHECK (position > 0 AND amount_in_cents BETWEEN 1 AND 9007199254740991), CONSTRAINT "PK_financial_installments" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_installments_space_due" ON "financial_installments"  ("space_id", "due_date", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_installment_shares" ("installment_id" uuid NOT NULL, "member_id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, CONSTRAINT "CHK_installment_shares_values" CHECK (amount_in_cents BETWEEN 0 AND 9007199254740991), CONSTRAINT "PK_installment_shares" PRIMARY KEY ("installment_id", "member_id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_installment_anticipations" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "installment_id" uuid NOT NULL, "fact_id" uuid NOT NULL, "due_date" date NOT NULL, "expected_remaining_amount_in_cents" bigint NOT NULL, "paid_amount_in_cents" bigint NOT NULL, "effective_amount_in_cents" bigint NOT NULL, "adjustment_in_cents" bigint NOT NULL, "economic_shares" jsonb, "fact_date" date NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "actor_id" uuid NOT NULL, CONSTRAINT "UQ_installment_anticipation_fact" UNIQUE ("fact_id"), CONSTRAINT "UQ_installment_anticipation_origin" UNIQUE ("space_id", "commitment_id", "installment_id"), CONSTRAINT "CHK_installment_anticipation_values" CHECK (expected_remaining_amount_in_cents BETWEEN 1 AND 9007199254740991 AND paid_amount_in_cents BETWEEN 1 AND 9007199254740991 AND effective_amount_in_cents BETWEEN 1 AND 9007199254740991 AND adjustment_in_cents=paid_amount_in_cents-expected_remaining_amount_in_cents AND fact_date<due_date), CONSTRAINT "PK_installment_anticipations" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_installment_payoffs" ("id" uuid NOT NULL, "compensated" boolean NOT NULL DEFAULT false, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "fact_id" uuid NOT NULL, "expected_remaining_amount_in_cents" bigint NOT NULL, "paid_amount_in_cents" bigint NOT NULL, "adjustment_in_cents" bigint NOT NULL, "economic_shares" jsonb, "expected_economic_shares" jsonb, "recognized_manual_adjustments" jsonb, "recognized_remaining_shares" jsonb, "fact_date" date NOT NULL, "actor_id" uuid NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_installment_payoff_fact" UNIQUE ("fact_id"), CONSTRAINT "UQ_installment_payoff_scope" UNIQUE ("space_id", "commitment_id", "id"), CONSTRAINT "CHK_installment_payoff_values" CHECK (expected_remaining_amount_in_cents BETWEEN 1 AND 9007199254740991 AND paid_amount_in_cents BETWEEN 1 AND 9007199254740991 AND adjustment_in_cents=paid_amount_in_cents-expected_remaining_amount_in_cents), CONSTRAINT "PK_installment_payoffs" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_installment_payoff_active" ON "financial_installment_payoffs"  ("space_id", "commitment_id") WHERE compensated=false`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_installment_resolutions" ("id" uuid NOT NULL, "compensated" boolean NOT NULL DEFAULT false, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "installment_id" uuid NOT NULL, "type" character varying(16) NOT NULL, "payoff_id" uuid, "expected_remaining_amount_in_cents" bigint NOT NULL, "fact_date" date NOT NULL, "actor_id" uuid NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "reason" character varying(500), "economic_shares" jsonb, CONSTRAINT "CHK_installment_resolution_values" CHECK (expected_remaining_amount_in_cents BETWEEN 1 AND 9007199254740991 AND ((type='PAYOFF' AND payoff_id IS NOT NULL AND reason IS NULL) OR (type='CANCELLED' AND payoff_id IS NULL AND length(trim(reason)) BETWEEN 1 AND 500))), CONSTRAINT "PK_installment_resolutions" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_installment_resolution_active" ON "financial_installment_resolutions"  ("installment_id") WHERE compensated=false`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_installment_command_receipts" ("actor_id" uuid NOT NULL, "operation" character varying(48) NOT NULL, "idempotency_key" uuid NOT NULL, "request_hash" bytea NOT NULL, "status" character varying(16) NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "installment_id" uuid, "result" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_installment_command_receipts" CHECK (status='COMPLETED' AND octet_length(request_hash)=32 AND operation IN ('CREATE_INSTALLMENT_COMMITMENT','RECORD_INSTALLMENT_DISBURSEMENT','RECORD_INSTALLMENT_EXTERNAL_LIABILITY','SETTLE_INSTALLMENT_EXTERNAL_LIABILITY','ANTICIPATE_INSTALLMENTS','PAYOFF_INSTALLMENTS','CANCEL_FUTURE_INSTALLMENTS')), CONSTRAINT "PK_installment_receipts" PRIMARY KEY ("actor_id", "operation", "idempotency_key"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_recurrence_versions" ("commitment_id" uuid NOT NULL, "version" integer NOT NULL, "space_id" uuid NOT NULL, "effective_from" date NOT NULL, "description" character varying(160) NOT NULL, "amount_in_cents" bigint, "value_mode" character varying(8) NOT NULL DEFAULT 'FIXED', "frequency" character varying(8) NOT NULL, "day_of_month" integer NOT NULL, "month_of_year" integer, "starts_on" date NOT NULL, "ends_on" date, "owner_person_id" uuid, "split_input" jsonb, "expected_member_id" uuid, "rule_snapshot" jsonb, "rule_source_version" integer NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_recurrence_versions_effective" UNIQUE ("space_id", "commitment_id", "effective_from"), CONSTRAINT "UQ_recurrence_versions_space" UNIQUE ("space_id", "commitment_id", "version"), CONSTRAINT "CHK_recurrence_versions_values" CHECK (version > 0 AND (amount_in_cents IS NULL OR amount_in_cents BETWEEN 1 AND 9007199254740991) AND value_mode IN ('FIXED','VARIABLE') AND (value_mode='VARIABLE' OR amount_in_cents IS NOT NULL) AND frequency IN ('MONTHLY','ANNUAL') AND day_of_month BETWEEN 1 AND 31 AND ((frequency='MONTHLY' AND month_of_year IS NULL) OR (frequency='ANNUAL' AND month_of_year BETWEEN 1 AND 12)) AND (ends_on IS NULL OR ends_on >= starts_on) AND ((owner_person_id IS NOT NULL AND split_input IS NULL AND expected_member_id IS NULL AND rule_snapshot IS NULL AND rule_source_version=0) OR (owner_person_id IS NULL AND split_input IS NOT NULL AND rule_source_version >= 0 AND (rule_snapshot IS NULL)=(rule_source_version=0) AND (value_mode='FIXED' OR split_input->>'mode'='PERCENTAGES')))), CONSTRAINT "PK_financial_recurrence_versions" PRIMARY KEY ("commitment_id", "version"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_recurrence_shares" ("commitment_id" uuid NOT NULL, "version" integer NOT NULL, "member_id" uuid NOT NULL, "space_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, CONSTRAINT "CHK_recurrence_shares_values" CHECK (amount_in_cents BETWEEN 0 AND 9007199254740991), CONSTRAINT "PK_financial_recurrence_shares" PRIMARY KEY ("commitment_id", "version", "member_id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_occurrences" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "reference_date" date NOT NULL, "economic_version" integer, "installment_id" uuid, "state_version" integer NOT NULL, "amount_in_cents" bigint, "status" character varying(24) NOT NULL, "materialized_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_financial_occurrences_installment" UNIQUE ("installment_id"), CONSTRAINT "UQ_financial_occurrences_origin" UNIQUE ("space_id", "commitment_id", "id"), CONSTRAINT "UQ_financial_occurrences_date" UNIQUE ("space_id", "commitment_id", "reference_date"), CONSTRAINT "CHK_financial_occurrences_state" CHECK (((economic_version IS NOT NULL AND economic_version > 0 AND installment_id IS NULL) OR (economic_version IS NULL AND installment_id IS NOT NULL AND amount_in_cents IS NOT NULL)) AND state_version > 0 AND (amount_in_cents IS NULL OR amount_in_cents BETWEEN 0 AND 9007199254740991) AND (amount_in_cents IS NOT NULL OR status IN ('PENDING','CANCELLED')) AND status IN ('PENDING','PARTIALLY_FULFILLED','FULFILLED','CANCELLED')), CONSTRAINT "PK_financial_occurrences" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_financial_occurrences_space_date" ON "financial_occurrences"  ("space_id", "reference_date", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_recurrence_command_receipts" ("actor_id" uuid NOT NULL, "operation" character varying(40) NOT NULL, "idempotency_key" uuid NOT NULL, "request_hash" bytea NOT NULL, "status" character varying(16) NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "occurrence_id" uuid, "result" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_recurrence_command_receipts" CHECK (status='COMPLETED' AND octet_length(request_hash)=32 AND operation IN ('CREATE_FIXED_RECURRING_COMMITMENT','CREATE_RECURRING_COMMITMENT','SET_RECURRING_OCCURRENCE_VALUE','RECORD_RECURRING_DISBURSEMENT','RECORD_RECURRING_RECEIPT','RECORD_RECURRING_EXTERNAL_LIABILITY','SETTLE_RECURRING_EXTERNAL_LIABILITY','CHANGE_RECURRING_COMMITMENT','TERMINATE_RECURRING_COMMITMENT','CANCEL_RECURRING_OCCURRENCE')), CONSTRAINT "PK_financial_recurrence_command_receipts" PRIMARY KEY ("actor_id", "operation", "idempotency_key"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_commitment_settlement_rules" ("commitment_id" uuid NOT NULL, "space_id" uuid NOT NULL, "version" integer NOT NULL, "rule" jsonb NOT NULL, CONSTRAINT "UQ_commitment_settlement_rule_space" UNIQUE ("space_id", "commitment_id"), CONSTRAINT "CHK_commitment_settlement_rule_version" CHECK (version > 0 AND COALESCE(jsonb_typeof(rule) = 'object' AND rule->>'kind' = 'MONTHLY_DAY' AND jsonb_typeof(rule->'dayOfMonth') = 'number' AND (rule->>'dayOfMonth')::numeric BETWEEN 1 AND 31 AND (rule->>'dayOfMonth')::numeric = trunc((rule->>'dayOfMonth')::numeric),false)), CONSTRAINT "PK_b25d698b102b51b8132821cd42b" PRIMARY KEY ("commitment_id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_commitment_settlement_rule_changes" ("commitment_id" uuid NOT NULL, "version" integer NOT NULL, "space_id" uuid NOT NULL, "commitment_version" integer NOT NULL, "actor_id" uuid NOT NULL, "previous_rule" jsonb, "rule" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_commitment_rule_change_version" CHECK (version > 0 AND commitment_version > 1), CONSTRAINT "PK_97bd24fac23ff3925f82752c4cc" PRIMARY KEY ("commitment_id", "version"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_settlement_adjustment_receipts" ("actor_id" uuid NOT NULL, "operation" character varying(48) NOT NULL, "idempotency_key" uuid NOT NULL, "space_id" uuid NOT NULL, "request_hash" bytea NOT NULL, "result" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_settlement_adjustment_receipt" CHECK (operation IN ('CONFIGURE_COMMITMENT_SETTLEMENT_RULE','MOVE_OBLIGATION','FINALIZE_SETTLEMENT_CYCLE','WAIVE_INTER_MEMBER_OBLIGATION','REVERSE_SETTLEMENT_TRANSFER','REVERSE_SETTLEMENT_OFFSET') AND octet_length(request_hash) = 32), CONSTRAINT "PK_fd94d916b1af77766fc079b2cd5" PRIMARY KEY ("actor_id", "operation", "idempotency_key"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_settlement_adjustment_audit" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "actor_id" uuid NOT NULL, "idempotency_key" uuid NOT NULL, "action" character varying(48) NOT NULL, "target_id" uuid NOT NULL, "payload" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_settlement_adjustment_audit_command" UNIQUE ("actor_id", "action", "idempotency_key"), CONSTRAINT "PK_d28ff4a752fd586ddbdea36a7cc" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "settlement_cycle_changes" ("cycle_id" uuid NOT NULL, "version" integer NOT NULL, "space_id" uuid NOT NULL, "actor_id" uuid NOT NULL, "type" character varying(24) NOT NULL, "snapshot" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_cycle_change_finalization" CHECK (version > 1 AND type = 'FINALIZED'), CONSTRAINT "PK_37edf60fe2ac9fae5daa1d72cf7" PRIMARY KEY ("cycle_id", "version"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "settlement_offsets" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, "fact_date" date NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_by" uuid NOT NULL, CONSTRAINT "UQ_settlement_offsets_space_id" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_settlement_offset_values" CHECK (amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date), CONSTRAINT "PK_2a109c11b075c09f888e2257b26" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "settlement_offset_allocations" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "offset_id" uuid NOT NULL, "obligation_id" uuid NOT NULL, "cycle_id" uuid, "debtor_member_id" uuid NOT NULL, "creditor_member_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, CONSTRAINT "UQ_offset_allocation_obligation" UNIQUE ("offset_id", "obligation_id"), CONSTRAINT "UQ_offset_allocation_space_id" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_offset_allocation_values" CHECK (amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND debtor_member_id <> creditor_member_id), CONSTRAINT "PK_360361a4577c1b315ae596f99b9" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_offset_allocation_obligation" ON "settlement_offset_allocations"  ("space_id", "obligation_id") `,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_offset_allocation_cycle" ON "settlement_offset_allocations"  ("space_id", "cycle_id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "settlement_offset_command_receipts" ("actor_id" uuid NOT NULL, "idempotency_key" uuid NOT NULL, "space_id" uuid NOT NULL, "offset_id" uuid NOT NULL, "request_hash" bytea NOT NULL, "result" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_offset_receipt_hash" CHECK (octet_length(request_hash) = 32), CONSTRAINT "PK_b18030c8444a3e283df8974996c" PRIMARY KEY ("actor_id", "idempotency_key"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "settlement_offset_audit" ("id" uuid NOT NULL, "actor_id" uuid NOT NULL, "idempotency_key" uuid NOT NULL, "space_id" uuid NOT NULL, "offset_id" uuid NOT NULL, "action" character varying(40) NOT NULL, "payload" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_offset_audit_command" UNIQUE ("actor_id", "idempotency_key"), CONSTRAINT "PK_e8e2dc565631f1f1215233f46e7" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "settlement_transfers" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "payer_member_id" uuid NOT NULL, "recipient_member_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, "fact_date" date NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_by" uuid NOT NULL, "mode" character varying(16) NOT NULL, CONSTRAINT "UQ_settlement_transfers_space_id" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_settlement_transfers_values" CHECK (payer_member_id <> recipient_member_id AND amount_in_cents BETWEEN 1 AND 9007199254740991 AND mode = 'MANUAL' AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date), CONSTRAINT "settlement_transfers_pkey" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "settlement_allocations" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "transfer_id" uuid NOT NULL, "obligation_id" uuid NOT NULL, "cycle_id" uuid, "amount_in_cents" bigint NOT NULL, CONSTRAINT "UQ_settlement_allocations_space_id" UNIQUE ("space_id", "id"), CONSTRAINT "UQ_settlement_allocations_transfer_obligation" UNIQUE ("transfer_id", "obligation_id"), CONSTRAINT "CHK_settlement_allocations_amount" CHECK (amount_in_cents BETWEEN 1 AND 9007199254740991), CONSTRAINT "settlement_allocations_pkey" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_settlement_allocations_cycle" ON "settlement_allocations"  ("space_id", "cycle_id", "transfer_id") `,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_settlement_allocations_obligation" ON "settlement_allocations"  ("space_id", "obligation_id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_settlement_command_receipts" ("actor_id" uuid NOT NULL, "operation" character varying(48) NOT NULL, "idempotency_key" uuid NOT NULL, "request_hash" bytea NOT NULL, "status" character varying(16) NOT NULL, "space_id" uuid NOT NULL, "transfer_id" uuid NOT NULL, "result" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_settlement_receipt" CHECK (operation = 'RECORD_MANUAL_SETTLEMENT_TRANSFER' AND status = 'COMPLETED' AND octet_length(request_hash) = 32), CONSTRAINT "financial_settlement_command_receipts_pkey" PRIMARY KEY ("actor_id", "operation", "idempotency_key"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_settlement_audit" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "transfer_id" uuid NOT NULL, "actor_id" uuid NOT NULL, "action" character varying(48) NOT NULL, "payload" jsonb NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_settlement_audit_transfer" UNIQUE ("transfer_id"), CONSTRAINT "CHK_settlement_audit_action" CHECK (action = 'RECORD_MANUAL_SETTLEMENT_TRANSFER'), CONSTRAINT "financial_settlement_audit_pkey" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "settlement_reversals" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "original_kind" character varying(8) NOT NULL, "original_transfer_id" uuid, "original_offset_id" uuid, "amount_in_cents" bigint NOT NULL, "fact_date" date NOT NULL, "registered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_by" uuid NOT NULL, CONSTRAINT "UQ_settlement_reversal_offset" UNIQUE ("original_offset_id"), CONSTRAINT "UQ_settlement_reversal_transfer" UNIQUE ("original_transfer_id"), CONSTRAINT "UQ_settlement_reversal_space_id" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_settlement_reversal_values" CHECK (amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((original_kind = 'TRANSFER' AND original_transfer_id IS NOT NULL AND original_offset_id IS NULL) OR (original_kind = 'OFFSET' AND original_offset_id IS NOT NULL AND original_transfer_id IS NULL))), CONSTRAINT "PK_52c4e655c30b7d9f8c91bbdfd38" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "settlement_reversal_applications" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "reversal_id" uuid NOT NULL, "original_transfer_allocation_id" uuid, "original_offset_allocation_id" uuid, "original_obligation_id" uuid NOT NULL, "effect_obligation_id" uuid, "source_cycle_id" uuid, "correction_cycle_id" uuid, "debtor_member_id" uuid NOT NULL, "creditor_member_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, CONSTRAINT "UQ_reversal_application_offset" UNIQUE ("original_offset_allocation_id"), CONSTRAINT "UQ_reversal_application_transfer" UNIQUE ("original_transfer_allocation_id"), CONSTRAINT "CHK_reversal_application_values" CHECK (amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND debtor_member_id <> creditor_member_id AND num_nonnulls(original_transfer_allocation_id,original_offset_allocation_id) = 1), CONSTRAINT "PK_ce544cb48d4184eb2df34be127a" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_reversal_application_source_cycle" ON "settlement_reversal_applications"  ("space_id", "source_cycle_id") `,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_reversal_application_origin" ON "settlement_reversal_applications"  ("space_id", "original_obligation_id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "auth_credentials" ("person_id" uuid NOT NULL, "email" character varying(254) NOT NULL, "password_hash" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_080a7e7a671571ddd8cfc0c3622" PRIMARY KEY ("person_id"))`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_auth_credentials_email" ON "auth_credentials"  ("email") `,
        );
        await queryRunner.query(
            `CREATE TABLE "auth_sessions" ("id" uuid NOT NULL, "person_id" uuid NOT NULL, "token_hash" bytea NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_641507381f32580e8479efc36cd" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_auth_sessions_expires_at" ON "auth_sessions"  ("expires_at") `,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_auth_sessions_person_id" ON "auth_sessions"  ("person_id") `,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_auth_sessions_token_hash" ON "auth_sessions"  ("token_hash") `,
        );
        await queryRunner.query(
            `CREATE TABLE "space_closure_command_receipts" ("actor_id" uuid NOT NULL, "operation" character varying(48) NOT NULL, "key" uuid NOT NULL, "space_id" uuid NOT NULL, "process_id" uuid NOT NULL, "request_hash" bytea NOT NULL, "http_status" integer NOT NULL, "result" jsonb NOT NULL, "recorded_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_space_closure_receipts_result" CHECK (jsonb_typeof("result") = 'object'), CONSTRAINT "CHK_space_closure_receipts_http_status" CHECK ("http_status" IN (200, 201)), CONSTRAINT "CHK_space_closure_receipts_hash" CHECK (octet_length("request_hash") = 32), CONSTRAINT "PK_space_closure_command_receipts" PRIMARY KEY ("actor_id", "operation", "key"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "persons" ("id" uuid NOT NULL, "display_name" character varying(80) NOT NULL, "version" integer NOT NULL DEFAULT '1', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_74278d8812a049233ce41440ac7" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "space_closure_audit" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "process_id" uuid NOT NULL, "actor_id" uuid NOT NULL, "action" character varying(48) NOT NULL, "idempotency_key" uuid NOT NULL, "plan_revision" integer NOT NULL, "recorded_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_space_closure_audit_revision" CHECK ("plan_revision" >= 1), CONSTRAINT "PK_3fd4098cac3b8cc30206b305b92" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_space_closure_audit_process" ON "space_closure_audit"  ("process_id", "recorded_at", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "space_closure_history" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "process_id" uuid NOT NULL, "action" character varying(48) NOT NULL, "actor_member_id" uuid NOT NULL, "plan_revision" integer NOT NULL, "recorded_at" TIMESTAMP WITH TIME ZONE NOT NULL, "snapshot" jsonb NOT NULL, CONSTRAINT "CHK_space_closure_history_snapshot" CHECK (jsonb_typeof("snapshot") = 'object'), CONSTRAINT "CHK_space_closure_history_revision" CHECK ("plan_revision" >= 1), CONSTRAINT "PK_fea8593a00d8d2c6ac4cf9fab00" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_space_closure_history_page" ON "space_closure_history"  ("space_id", "recorded_at", "id") `,
        );
        await queryRunner.query(
            `CREATE TABLE "space_closure_processes" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "status" character varying(16) NOT NULL, "requested_by_member_id" uuid NOT NULL, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL, "completed_at" TIMESTAMP WITH TIME ZONE, "cancelled_at" TIMESTAMP WITH TIME ZONE, "cutoff_date" date NOT NULL, "proposed_cutoff_date" date, "plan_revision" integer NOT NULL, "plan_status" character varying(16) NOT NULL, "participants" jsonb NOT NULL, "approvals" jsonb NOT NULL, "confirmations" jsonb NOT NULL, "future_destinations" jsonb NOT NULL DEFAULT '[]', "proposal_snapshot" jsonb, "has_bilateral_approval" boolean NOT NULL DEFAULT false, "cancellation_consents" jsonb NOT NULL DEFAULT '[]', CONSTRAINT "UQ_space_closure_processes_id_space" UNIQUE ("id", "space_id"), CONSTRAINT "CHK_space_closure_processes_resolution" CHECK (
    ("status" = 'OPEN' AND "completed_at" IS NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'COMPLETED' AND "completed_at" IS NOT NULL AND "completed_at" >= "started_at" AND "cancelled_at" IS NULL)
    OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "cancelled_at" >= "started_at" AND "completed_at" IS NULL)), CONSTRAINT "CHK_space_closure_processes_cancellation_consents" CHECK (jsonb_typeof("cancellation_consents") = 'array' AND jsonb_array_length("cancellation_consents") <= 2), CONSTRAINT "CHK_space_closure_processes_proposal_snapshot" CHECK ("proposal_snapshot" IS NULL OR jsonb_typeof("proposal_snapshot") = 'object'), CONSTRAINT "CHK_space_closure_processes_destinations" CHECK (jsonb_typeof("future_destinations") = 'array'), CONSTRAINT "CHK_space_closure_processes_consents" CHECK (jsonb_typeof("approvals") = 'array' AND jsonb_typeof("confirmations") = 'array'), CONSTRAINT "CHK_space_closure_processes_participants" CHECK (jsonb_typeof("participants") = 'array' AND jsonb_array_length("participants") BETWEEN 1 AND 2), CONSTRAINT "CHK_space_closure_processes_cutoff" CHECK ("proposed_cutoff_date" IS NULL OR "proposed_cutoff_date" >= "cutoff_date"), CONSTRAINT "CHK_space_closure_processes_plan_status" CHECK ("plan_status" IN ('DRAFT', 'PROPOSED', 'APPROVED', 'REJECTED')), CONSTRAINT "CHK_space_closure_processes_revision" CHECK ("plan_revision" >= 1), CONSTRAINT "CHK_space_closure_processes_status" CHECK ("status" IN ('OPEN', 'COMPLETED', 'CANCELLED')), CONSTRAINT "PK_ed948e43856d8db7dbb842261db" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_space_closure_processes_history" ON "space_closure_processes"  ("space_id", "started_at", "id") `,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_space_closure_processes_open" ON "space_closure_processes"  ("space_id") WHERE "status" = 'OPEN'`,
        );
        await queryRunner.query(
            `CREATE TABLE "space_command_receipts" ("actor_id" uuid NOT NULL, "operation" character varying(32) NOT NULL, "key" uuid NOT NULL, "request_hash" bytea NOT NULL, "result_space_id" uuid NOT NULL, "result_invitation_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_space_command_receipts_hash" CHECK (octet_length("request_hash") = 32), CONSTRAINT "CHK_space_command_receipts_operation" CHECK ("operation" IN ('CREATE_SPACE', 'ISSUE_INVITATION', 'REPLACE_INVITATION', 'RESPOND_INVITATION')), CONSTRAINT "PK_space_command_receipts" PRIMARY KEY ("actor_id", "operation", "key"))`,
        );
        await queryRunner.query(
            `CREATE TABLE "space_members" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "person_id" uuid NOT NULL, "status" character varying(16) NOT NULL, "slot" smallint NOT NULL, "joined_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "UQ_space_members_space_id" UNIQUE ("space_id", "id"), CONSTRAINT "CHK_space_members_slot" CHECK ("slot" IN (1, 2)), CONSTRAINT "CHK_space_members_status" CHECK ("status" = 'ACTIVE'), CONSTRAINT "PK_5aaa6440d7f1e8b8c051df43d5e" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_space_members_active_slot" ON "space_members"  ("space_id", "slot") WHERE "status" = 'ACTIVE'`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_space_members_active_person" ON "space_members"  ("space_id", "person_id") WHERE "status" = 'ACTIVE'`,
        );
        await queryRunner.query(
            `CREATE TABLE "spaces" ("id" uuid NOT NULL, "type" character varying(16) NOT NULL, "status" character varying(16) NOT NULL, "personal_owner_person_id" uuid, "name" character varying(80), "created_by_person_id" uuid, "version" integer NOT NULL DEFAULT '1', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_spaces_version" CHECK ("version" >= 1), CONSTRAINT "CHK_spaces_variant" CHECK ((
        "type" = 'PERSONAL'
        AND "personal_owner_person_id" IS NOT NULL
        AND "status" = 'ACTIVE'
        AND "name" IS NULL
        AND "created_by_person_id" IS NULL
    ) OR (
        "type" = 'SHARED'
        AND "personal_owner_person_id" IS NULL
        AND "name" IS NOT NULL
        AND length(btrim("name")) > 0
        AND "created_by_person_id" IS NOT NULL
    )), CONSTRAINT "CHK_spaces_personal_rules" CHECK ("type" <> 'PERSONAL' OR ("personal_owner_person_id" IS NOT NULL AND "status" = 'ACTIVE')), CONSTRAINT "CHK_spaces_status" CHECK ("status" IN ('ACTIVE', 'CLOSING', 'CLOSED')), CONSTRAINT "CHK_spaces_type" CHECK ("type" IN ('PERSONAL', 'SHARED')), CONSTRAINT "PK_dbe542974aca57afcb60709d4c8" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_spaces_personal_owner" ON "spaces"  ("personal_owner_person_id") WHERE "type" = 'PERSONAL'`,
        );
        await queryRunner.query(
            `CREATE TABLE "space_invitations" ("id" uuid NOT NULL, "space_id" uuid NOT NULL, "invited_by_person_id" uuid NOT NULL, "token_hash" bytea NOT NULL, "status" character varying(16) NOT NULL, "issued_at" TIMESTAMP WITH TIME ZONE NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "resolved_at" TIMESTAMP WITH TIME ZONE, "cancellation_reason" character varying(16), "replaced_by_invitation_id" uuid, "closure_process_id" uuid, CONSTRAINT "UQ_space_invitations_id_space" UNIQUE ("id", "space_id"), CONSTRAINT "CHK_space_invitations_replacement" CHECK ((
        "status" = 'CANCELLED'
        AND "cancellation_reason" IS NOT NULL
        AND "cancellation_reason" = 'REPLACED'
        AND "replaced_by_invitation_id" IS NOT NULL
        AND "replaced_by_invitation_id" <> "id"
        AND "closure_process_id" IS NULL
    ) OR (
        "status" = 'CANCELLED'
        AND "cancellation_reason" IS NOT NULL
        AND "cancellation_reason" = 'SPACE_CLOSURE'
        AND "replaced_by_invitation_id" IS NULL
        AND "closure_process_id" IS NOT NULL
    ) OR (
        "status" <> 'CANCELLED'
        AND "cancellation_reason" IS NULL
        AND "replaced_by_invitation_id" IS NULL
        AND "closure_process_id" IS NULL
    )), CONSTRAINT "CHK_space_invitations_resolution" CHECK (("status" = 'PENDING' AND "resolved_at" IS NULL)
    OR ("status" <> 'PENDING' AND "resolved_at" IS NOT NULL)), CONSTRAINT "CHK_space_invitations_dates" CHECK ("expires_at" > "issued_at"
    AND ("resolved_at" IS NULL OR "resolved_at" >= "issued_at")), CONSTRAINT "CHK_space_invitations_hash" CHECK (octet_length("token_hash") = 32), CONSTRAINT "CHK_space_invitations_status" CHECK ("status" IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED')), CONSTRAINT "PK_4be9882bffb82c0ee4486363703" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_space_invitations_history" ON "space_invitations"  ("space_id", "issued_at", "id") `,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_space_invitations_token_hash" ON "space_invitations"  ("token_hash") `,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX "UQ_space_invitations_pending" ON "space_invitations"  ("space_id") WHERE "status" = 'PENDING'`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" ADD CONSTRAINT "FK_routine_task_assignee_member" FOREIGN KEY ("space_id", "assignee_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" ADD CONSTRAINT "FK_routine_task_creator_member" FOREIGN KEY ("space_id", "creator_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" ADD CONSTRAINT "FK_routine_task_assignee" FOREIGN KEY ("assignee_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" ADD CONSTRAINT "FK_routine_task_creator" FOREIGN KEY ("creator_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" ADD CONSTRAINT "FK_routine_task_shopping_list" FOREIGN KEY ("space_id", "shopping_list_id") REFERENCES "shopping_lists"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" ADD CONSTRAINT "FK_routine_task_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_history" ADD CONSTRAINT "FK_routine_history_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_history" ADD CONSTRAINT "FK_routine_history_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_command_receipts" ADD CONSTRAINT "FK_routine_receipt_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_command_audit" ADD CONSTRAINT "FK_routine_audit_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_command_audit" ADD CONSTRAINT "FK_routine_audit_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
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
            `ALTER TABLE "shopping_items" ADD CONSTRAINT "FK_shopping_item_creator_member" FOREIGN KEY ("space_id", "creator_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_items" ADD CONSTRAINT "FK_shopping_item_creator" FOREIGN KEY ("creator_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_items" ADD CONSTRAINT "FK_shopping_item_list" FOREIGN KEY ("space_id", "list_id") REFERENCES "shopping_lists"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
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
        await queryRunner.query(
            `ALTER TABLE "shopping_purchase_corrections" ADD CONSTRAINT "FK_shopping_correction_member" FOREIGN KEY ("space_id", "corrected_by_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_purchase_corrections" ADD CONSTRAINT "FK_shopping_correction_author" FOREIGN KEY ("corrected_by_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_purchase_corrections" ADD CONSTRAINT "FK_shopping_correction_purchase" FOREIGN KEY ("space_id", "list_id", "item_id", "purchase_id") REFERENCES "shopping_purchase_records"("space_id","list_id","item_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
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
        await queryRunner.query(
            `ALTER TABLE "routine_task_recurrences" ADD CONSTRAINT "FK_routine_recurrence_creator" FOREIGN KEY ("creator_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_task_recurrences" ADD CONSTRAINT "FK_routine_recurrence_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_task_occurrences" ADD CONSTRAINT "FK_routine_occurrence_rule" FOREIGN KEY ("space_id", "recurrence_id") REFERENCES "routine_task_recurrences"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "default_settlement_rules" ADD CONSTRAINT "default_settlement_rules_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "default_settlement_rule_changes" ADD CONSTRAINT "default_settlement_rule_changes_actor_person_id_fkey" FOREIGN KEY ("actor_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "default_settlement_rule_changes" ADD CONSTRAINT "default_settlement_rule_changes_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "default_settlement_rules"("space_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" ADD CONSTRAINT "FK_financial_commitments_personal_owner" FOREIGN KEY ("personal_owner_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" ADD CONSTRAINT "FK_financial_commitments_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" ADD CONSTRAINT "FK_financial_commitments_author" FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" ADD CONSTRAINT "FK_financial_versions_expected_payer" FOREIGN KEY ("space_id", "expected_payer_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" ADD CONSTRAINT "FK_financial_versions_commitment" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_shares" ADD CONSTRAINT "FK_financial_shares_member" FOREIGN KEY ("space_id", "member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_shares" ADD CONSTRAINT "FK_financial_shares_version" FOREIGN KEY ("space_id", "commitment_id", "version") REFERENCES "financial_commitment_versions"("space_id","commitment_id","version") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" ADD CONSTRAINT "FK_financial_disbursements_recorder" FOREIGN KEY ("recorded_by_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" ADD CONSTRAINT "FK_financial_disbursements_personal_payer" FOREIGN KEY ("payer_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" ADD CONSTRAINT "FK_financial_disbursements_payer" FOREIGN KEY ("space_id", "payer_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" ADD CONSTRAINT "FK_financial_disbursements_occurrence" FOREIGN KEY ("space_id", "commitment_id", "occurrence_id") REFERENCES "financial_occurrences"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" ADD CONSTRAINT "FK_financial_disbursements_commitment" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liabilities" ADD CONSTRAINT "FK_external_liabilities_personal_holder" FOREIGN KEY ("holder_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liabilities" ADD CONSTRAINT "FK_external_liabilities_recorder" FOREIGN KEY ("recorded_by_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liabilities" ADD CONSTRAINT "FK_external_liabilities_holder" FOREIGN KEY ("space_id", "holder_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liabilities" ADD CONSTRAINT "FK_financial_external_liabilities_occurrence" FOREIGN KEY ("space_id", "commitment_id", "occurrence_id") REFERENCES "financial_occurrences"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liabilities" ADD CONSTRAINT "FK_external_liabilities_commitment" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_cycles" ADD CONSTRAINT "FK_settlement_cycles_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "FK_obligations_closure_agreement" FOREIGN KEY ("space_id", "commitment_id", "closure_agreement_id") REFERENCES "financial_closure_effects"("space_id","origin_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "FK_obligations_cycle" FOREIGN KEY ("space_id", "cycle_id") REFERENCES "settlement_cycles"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "FK_obligations_creditor" FOREIGN KEY ("space_id", "creditor_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "FK_obligations_debtor" FOREIGN KEY ("space_id", "debtor_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "FK_obligations_origin" FOREIGN KEY ("space_id", "commitment_id", "disbursement_id") REFERENCES "financial_disbursements"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "FK_obligations_receipt" FOREIGN KEY ("space_id", "commitment_id", "receipt_id") REFERENCES "financial_receipts"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "FK_obligations_occurrence" FOREIGN KEY ("space_id", "commitment_id", "occurrence_id") REFERENCES "financial_occurrences"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" ADD CONSTRAINT "FK_obligations_external_liability" FOREIGN KEY ("space_id", "commitment_id", "external_liability_id") REFERENCES "financial_external_liabilities"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligation_changes" ADD CONSTRAINT "FK_obligation_changes_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligation_changes" ADD CONSTRAINT "FK_obligation_changes_obligation" FOREIGN KEY ("space_id", "obligation_id") REFERENCES "inter_member_obligations"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligation_changes" ADD CONSTRAINT "FK_obligation_changes_allocation" FOREIGN KEY ("space_id", "allocation_id") REFERENCES "settlement_allocations"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_expense_command_receipts" ADD CONSTRAINT "FK_expense_receipts_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_expense_command_receipts" ADD CONSTRAINT "FK_expense_receipts_commitment" FOREIGN KEY ("commitment_id") REFERENCES "financial_commitments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liability_settlements" ADD CONSTRAINT "FK_external_settlement_person" FOREIGN KEY ("holder_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liability_settlements" ADD CONSTRAINT "FK_external_settlement_holder" FOREIGN KEY ("space_id", "holder_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liability_settlements" ADD CONSTRAINT "FK_external_settlement_receipt" FOREIGN KEY ("recorded_by_person_id", "receipt_operation", "idempotency_key") REFERENCES "financial_expense_command_receipts"("actor_id","operation","idempotency_key") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liability_settlements" ADD CONSTRAINT "FK_external_settlement_origin" FOREIGN KEY ("space_id", "commitment_id", "external_liability_id") REFERENCES "financial_external_liabilities"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "finances_command_receipts" ADD CONSTRAINT "finances_command_receipts_result_space_id_result_version_fkey" FOREIGN KEY ("result_space_id", "result_version") REFERENCES "default_settlement_rule_changes"("space_id","version") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "finances_command_receipts" ADD CONSTRAINT "finances_command_receipts_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" ADD CONSTRAINT "FK_commitment_change_proposal_decider" FOREIGN KEY ("decided_by_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" ADD CONSTRAINT "FK_commitment_change_proposal_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" ADD CONSTRAINT "FK_commitment_change_proposal_recipient" FOREIGN KEY ("space_id", "recipient_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" ADD CONSTRAINT "FK_commitment_change_proposal_author" FOREIGN KEY ("space_id", "proposed_by_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" ADD CONSTRAINT "FK_commitment_change_proposal_origin" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_integrity_command_receipts" ADD CONSTRAINT "FK_integrity_receipt_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_integrity_command_receipts" ADD CONSTRAINT "FK_integrity_receipt_origin" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_closure_effects" ADD CONSTRAINT "FK_financial_closure_effect_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_closure_effects" ADD CONSTRAINT "FK_financial_closure_effect_successor" FOREIGN KEY ("successor_commitment_id") REFERENCES "financial_commitments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_closure_effects" ADD CONSTRAINT "FK_financial_closure_effect_origin" FOREIGN KEY ("space_id", "origin_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" ADD CONSTRAINT "FK_fulfillment_reversal_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" ADD CONSTRAINT "FK_fulfillment_reversal_receipt" FOREIGN KEY ("space_id", "commitment_id", "receipt_id") REFERENCES "financial_receipts"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" ADD CONSTRAINT "FK_fulfillment_reversal_external_settlement" FOREIGN KEY ("space_id", "commitment_id", "external_settlement_id") REFERENCES "financial_external_liability_settlements"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" ADD CONSTRAINT "FK_fulfillment_reversal_external" FOREIGN KEY ("space_id", "commitment_id", "external_liability_id") REFERENCES "financial_external_liabilities"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" ADD CONSTRAINT "FK_fulfillment_reversal_disbursement" FOREIGN KEY ("space_id", "commitment_id", "disbursement_id") REFERENCES "financial_disbursements"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" ADD CONSTRAINT "FK_fulfillment_reversal_installment" FOREIGN KEY ("space_id", "commitment_id", "installment_id") REFERENCES "financial_installments"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" ADD CONSTRAINT "FK_fulfillment_reversal_occurrence" FOREIGN KEY ("space_id", "commitment_id", "occurrence_id") REFERENCES "financial_occurrences"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" ADD CONSTRAINT "FK_fulfillment_reversal_root" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" ADD CONSTRAINT "FK_commitment_adjustment_proposal" FOREIGN KEY ("space_id", "commitment_id", "proposal_id") REFERENCES "financial_commitment_change_proposals"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" ADD CONSTRAINT "FK_commitment_adjustment_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" ADD CONSTRAINT "FK_commitment_adjustment_installment" FOREIGN KEY ("space_id", "commitment_id", "installment_id") REFERENCES "financial_installments"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" ADD CONSTRAINT "FK_commitment_adjustment_occurrence" FOREIGN KEY ("space_id", "commitment_id", "occurrence_id") REFERENCES "financial_occurrences"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" ADD CONSTRAINT "FK_commitment_adjustment_root" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_cancellations" ADD CONSTRAINT "FK_commitment_cancellation_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_cancellations" ADD CONSTRAINT "FK_commitment_cancellation_root" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_non_recurring_versions" ADD CONSTRAINT "FK_non_recurring_version_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_non_recurring_versions" ADD CONSTRAINT "FK_non_recurring_version_expected_member" FOREIGN KEY ("space_id", "expected_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_non_recurring_versions" ADD CONSTRAINT "FK_non_recurring_version_installment" FOREIGN KEY ("space_id", "commitment_id", "installment_id") REFERENCES "financial_installments"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_non_recurring_versions" ADD CONSTRAINT "FK_non_recurring_version_commitment" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_versions" ADD CONSTRAINT "FK_income_versions_expected_recipient" FOREIGN KEY ("space_id", "expected_recipient_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_versions" ADD CONSTRAINT "FK_income_versions_owner" FOREIGN KEY ("owner_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_versions" ADD CONSTRAINT "FK_income_versions_commitment" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_shares" ADD CONSTRAINT "FK_income_shares_member" FOREIGN KEY ("space_id", "member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_shares" ADD CONSTRAINT "FK_income_shares_version" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_income_versions"("space_id","commitment_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_receipts" ADD CONSTRAINT "FK_financial_receipts_person" FOREIGN KEY ("recipient_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_receipts" ADD CONSTRAINT "FK_financial_receipts_recorder" FOREIGN KEY ("recorded_by_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_receipts" ADD CONSTRAINT "FK_financial_receipts_member" FOREIGN KEY ("space_id", "recipient_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_receipts" ADD CONSTRAINT "FK_financial_receipts_occurrence" FOREIGN KEY ("space_id", "commitment_id", "occurrence_id") REFERENCES "financial_occurrences"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_receipts" ADD CONSTRAINT "FK_financial_receipts_commitment" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_command_receipts" ADD CONSTRAINT "FK_income_command_commitment" FOREIGN KEY ("commitment_id") REFERENCES "financial_commitments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_command_receipts" ADD CONSTRAINT "FK_income_command_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "obligation_waivers" ADD CONSTRAINT "FK_obligation_waiver_actor" FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "obligation_waivers" ADD CONSTRAINT "FK_obligation_waiver_creditor" FOREIGN KEY ("space_id", "creditor_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "obligation_waivers" ADD CONSTRAINT "FK_obligation_waiver_origin" FOREIGN KEY ("space_id", "obligation_id") REFERENCES "inter_member_obligations"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_plans" ADD CONSTRAINT "FK_installment_plans_expected_member" FOREIGN KEY ("space_id", "expected_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_plans" ADD CONSTRAINT "FK_installment_plans_commitment" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installments" ADD CONSTRAINT "FK_installments_plan" FOREIGN KEY ("space_id", "commitment_id", "plan_id") REFERENCES "financial_installment_plans"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_shares" ADD CONSTRAINT "FK_installment_shares_member" FOREIGN KEY ("space_id", "member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_shares" ADD CONSTRAINT "FK_installment_shares_installment" FOREIGN KEY ("space_id", "commitment_id", "installment_id") REFERENCES "financial_installments"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_anticipations" ADD CONSTRAINT "FK_installment_anticipation_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_anticipations" ADD CONSTRAINT "FK_installment_anticipation_fact" FOREIGN KEY ("space_id", "commitment_id", "fact_id") REFERENCES "financial_disbursements"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_anticipations" ADD CONSTRAINT "FK_installment_anticipation_installment" FOREIGN KEY ("space_id", "commitment_id", "installment_id") REFERENCES "financial_installments"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_payoffs" ADD CONSTRAINT "FK_installment_payoff_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_payoffs" ADD CONSTRAINT "FK_installment_payoff_fact" FOREIGN KEY ("space_id", "commitment_id", "fact_id") REFERENCES "financial_disbursements"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_payoffs" ADD CONSTRAINT "FK_installment_payoff_commitment" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_resolutions" ADD CONSTRAINT "FK_installment_resolution_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_resolutions" ADD CONSTRAINT "FK_installment_resolution_payoff" FOREIGN KEY ("space_id", "commitment_id", "payoff_id") REFERENCES "financial_installment_payoffs"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_resolutions" ADD CONSTRAINT "FK_installment_resolution_installment" FOREIGN KEY ("space_id", "commitment_id", "installment_id") REFERENCES "financial_installments"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_command_receipts" ADD CONSTRAINT "FK_installment_receipts_installment" FOREIGN KEY ("space_id", "commitment_id", "installment_id") REFERENCES "financial_installments"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_command_receipts" ADD CONSTRAINT "FK_installment_receipts_commitment" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_command_receipts" ADD CONSTRAINT "FK_installment_receipts_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_versions" ADD CONSTRAINT "FK_recurrence_versions_expected_member" FOREIGN KEY ("space_id", "expected_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_versions" ADD CONSTRAINT "FK_recurrence_versions_owner" FOREIGN KEY ("owner_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_versions" ADD CONSTRAINT "FK_recurrence_versions_commitment" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_shares" ADD CONSTRAINT "FK_recurrence_shares_member" FOREIGN KEY ("space_id", "member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_shares" ADD CONSTRAINT "FK_recurrence_shares_version" FOREIGN KEY ("space_id", "commitment_id", "version") REFERENCES "financial_recurrence_versions"("space_id","commitment_id","version") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_occurrences" ADD CONSTRAINT "FK_financial_occurrences_installment" FOREIGN KEY ("space_id", "commitment_id", "installment_id") REFERENCES "financial_installments"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_occurrences" ADD CONSTRAINT "FK_financial_occurrences_version" FOREIGN KEY ("space_id", "commitment_id", "economic_version") REFERENCES "financial_recurrence_versions"("space_id","commitment_id","version") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_command_receipts" ADD CONSTRAINT "FK_recurrence_receipts_occurrence" FOREIGN KEY ("space_id", "commitment_id", "occurrence_id") REFERENCES "financial_occurrences"("space_id","commitment_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_command_receipts" ADD CONSTRAINT "FK_recurrence_receipts_commitment" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_command_receipts" ADD CONSTRAINT "FK_recurrence_receipts_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_settlement_rules" ADD CONSTRAINT "FK_commitment_settlement_rule_origin" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitments"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_settlement_rule_changes" ADD CONSTRAINT "FK_commitment_rule_change_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_settlement_rule_changes" ADD CONSTRAINT "FK_commitment_rule_change_rule" FOREIGN KEY ("space_id", "commitment_id") REFERENCES "financial_commitment_settlement_rules"("space_id","commitment_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_adjustment_receipts" ADD CONSTRAINT "FK_settlement_adjustment_receipt_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_adjustment_receipts" ADD CONSTRAINT "FK_settlement_adjustment_receipt_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_adjustment_audit" ADD CONSTRAINT "FK_settlement_adjustment_audit_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_adjustment_audit" ADD CONSTRAINT "FK_settlement_adjustment_audit_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_cycle_changes" ADD CONSTRAINT "FK_cycle_change_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_cycle_changes" ADD CONSTRAINT "FK_cycle_change_cycle" FOREIGN KEY ("space_id", "cycle_id") REFERENCES "settlement_cycles"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offsets" ADD CONSTRAINT "FK_settlement_offset_actor" FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offsets" ADD CONSTRAINT "FK_settlement_offset_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" ADD CONSTRAINT "FK_offset_allocation_creditor" FOREIGN KEY ("space_id", "creditor_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" ADD CONSTRAINT "FK_offset_allocation_debtor" FOREIGN KEY ("space_id", "debtor_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" ADD CONSTRAINT "FK_offset_allocation_cycle" FOREIGN KEY ("space_id", "cycle_id") REFERENCES "settlement_cycles"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" ADD CONSTRAINT "FK_offset_allocation_obligation" FOREIGN KEY ("space_id", "obligation_id") REFERENCES "inter_member_obligations"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" ADD CONSTRAINT "FK_offset_allocation_offset" FOREIGN KEY ("space_id", "offset_id") REFERENCES "settlement_offsets"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_command_receipts" ADD CONSTRAINT "FK_offset_receipt_offset" FOREIGN KEY ("space_id", "offset_id") REFERENCES "settlement_offsets"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_command_receipts" ADD CONSTRAINT "FK_offset_receipt_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_audit" ADD CONSTRAINT "FK_offset_audit_offset" FOREIGN KEY ("space_id", "offset_id") REFERENCES "settlement_offsets"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_audit" ADD CONSTRAINT "FK_offset_audit_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_transfers" ADD CONSTRAINT "FK_settlement_transfers_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_transfers" ADD CONSTRAINT "FK_settlement_transfers_author" FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_transfers" ADD CONSTRAINT "FK_settlement_transfers_recipient" FOREIGN KEY ("space_id", "recipient_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_transfers" ADD CONSTRAINT "FK_settlement_transfers_payer" FOREIGN KEY ("space_id", "payer_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_allocations" ADD CONSTRAINT "FK_settlement_allocations_cycle" FOREIGN KEY ("space_id", "cycle_id") REFERENCES "settlement_cycles"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_allocations" ADD CONSTRAINT "FK_settlement_allocations_obligation" FOREIGN KEY ("space_id", "obligation_id") REFERENCES "inter_member_obligations"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_allocations" ADD CONSTRAINT "FK_settlement_allocations_transfer" FOREIGN KEY ("space_id", "transfer_id") REFERENCES "settlement_transfers"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_command_receipts" ADD CONSTRAINT "FK_settlement_receipt_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_command_receipts" ADD CONSTRAINT "FK_settlement_receipt_transfer" FOREIGN KEY ("space_id", "transfer_id") REFERENCES "settlement_transfers"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_audit" ADD CONSTRAINT "FK_settlement_audit_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_audit" ADD CONSTRAINT "FK_settlement_audit_transfer" FOREIGN KEY ("space_id", "transfer_id") REFERENCES "settlement_transfers"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversals" ADD CONSTRAINT "FK_reversal_actor" FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversals" ADD CONSTRAINT "FK_reversal_original_offset" FOREIGN KEY ("space_id", "original_offset_id") REFERENCES "settlement_offsets"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversals" ADD CONSTRAINT "FK_reversal_original_transfer" FOREIGN KEY ("space_id", "original_transfer_id") REFERENCES "settlement_transfers"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" ADD CONSTRAINT "FK_reversal_application_creditor" FOREIGN KEY ("space_id", "creditor_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" ADD CONSTRAINT "FK_reversal_application_debtor" FOREIGN KEY ("space_id", "debtor_member_id") REFERENCES "space_members"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" ADD CONSTRAINT "FK_reversal_application_correction_cycle" FOREIGN KEY ("space_id", "correction_cycle_id") REFERENCES "settlement_cycles"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" ADD CONSTRAINT "FK_reversal_application_source_cycle" FOREIGN KEY ("space_id", "source_cycle_id") REFERENCES "settlement_cycles"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" ADD CONSTRAINT "FK_reversal_application_effect_obligation" FOREIGN KEY ("space_id", "effect_obligation_id") REFERENCES "inter_member_obligations"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" ADD CONSTRAINT "FK_reversal_application_original_obligation" FOREIGN KEY ("space_id", "original_obligation_id") REFERENCES "inter_member_obligations"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" ADD CONSTRAINT "FK_reversal_application_offset" FOREIGN KEY ("space_id", "original_offset_allocation_id") REFERENCES "settlement_offset_allocations"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" ADD CONSTRAINT "FK_reversal_application_transfer" FOREIGN KEY ("space_id", "original_transfer_allocation_id") REFERENCES "settlement_allocations"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" ADD CONSTRAINT "FK_reversal_application_reversal" FOREIGN KEY ("space_id", "reversal_id") REFERENCES "settlement_reversals"("space_id","id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "auth_credentials" ADD CONSTRAINT "FK_auth_credentials_person" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "auth_sessions" ADD CONSTRAINT "FK_auth_sessions_person" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_command_receipts" ADD CONSTRAINT "FK_space_closure_receipts_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_command_receipts" ADD CONSTRAINT "FK_space_closure_receipts_process" FOREIGN KEY ("process_id", "space_id") REFERENCES "space_closure_processes"("id","space_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_audit" ADD CONSTRAINT "FK_space_closure_audit_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_audit" ADD CONSTRAINT "FK_space_closure_audit_process" FOREIGN KEY ("process_id", "space_id") REFERENCES "space_closure_processes"("id","space_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_history" ADD CONSTRAINT "FK_space_closure_history_actor" FOREIGN KEY ("actor_member_id", "space_id") REFERENCES "space_members"("id","space_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_history" ADD CONSTRAINT "FK_space_closure_history_process" FOREIGN KEY ("process_id", "space_id") REFERENCES "space_closure_processes"("id","space_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" ADD CONSTRAINT "FK_space_closure_processes_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" ADD CONSTRAINT "FK_space_closure_processes_requester" FOREIGN KEY ("requested_by_member_id", "space_id") REFERENCES "space_members"("id","space_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_command_receipts" ADD CONSTRAINT "FK_space_command_receipts_actor" FOREIGN KEY ("actor_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_command_receipts" ADD CONSTRAINT "FK_space_command_receipts_result" FOREIGN KEY ("result_invitation_id", "result_space_id") REFERENCES "space_invitations"("id","space_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_members" ADD CONSTRAINT "FK_space_members_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_members" ADD CONSTRAINT "FK_space_members_person" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "spaces" ADD CONSTRAINT "FK_spaces_personal_owner" FOREIGN KEY ("personal_owner_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "spaces" ADD CONSTRAINT "FK_spaces_creator" FOREIGN KEY ("created_by_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_invitations" ADD CONSTRAINT "FK_space_invitations_space" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_invitations" ADD CONSTRAINT "FK_space_invitations_issuer" FOREIGN KEY ("invited_by_person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_invitations" ADD CONSTRAINT "FK_space_invitations_replacement" FOREIGN KEY ("replaced_by_invitation_id", "space_id") REFERENCES "space_invitations"("id","space_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_invitations" ADD CONSTRAINT "FK_space_invitations_closure_process" FOREIGN KEY ("closure_process_id", "space_id") REFERENCES "space_closure_processes"("id","space_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );

        // SQL-backed recurrence tables and indexes that TypeORM cannot generate.
        await queryRunner.query(
            `CREATE TABLE "financial_occurrence_cancellations" ("occurrence_id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "actor_id" uuid NOT NULL, "registered_at" timestamp with time zone NOT NULL, CONSTRAINT "PK_occurrence_cancellations" PRIMARY KEY (occurrence_id))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_occurrence_shares" ("occurrence_id" uuid NOT NULL, "member_id" uuid NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "amount_in_cents" bigint NOT NULL, CONSTRAINT "CHK_financial_occurrence_shares" CHECK (amount_in_cents >= 0 AND amount_in_cents <= '9007199254740991'::bigint), CONSTRAINT "PK_financial_occurrence_shares" PRIMARY KEY (occurrence_id, member_id))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_occurrence_value_changes" ("occurrence_id" uuid NOT NULL, "version" integer NOT NULL, "space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "previous_amount_in_cents" bigint, "amount_in_cents" bigint NOT NULL, "shares" jsonb, "actor_id" uuid NOT NULL, "registered_at" timestamp with time zone NOT NULL, CONSTRAINT "CHK_occurrence_value_changes" CHECK (version > 1 AND (previous_amount_in_cents IS NULL OR previous_amount_in_cents >= 1 AND previous_amount_in_cents <= '9007199254740991'::bigint) AND amount_in_cents >= 1 AND amount_in_cents <= '9007199254740991'::bigint), CONSTRAINT "PK_occurrence_value_changes" PRIMARY KEY (occurrence_id, version))`,
        );
        await queryRunner.query(
            `CREATE TABLE "financial_recurrence_terminations" ("space_id" uuid NOT NULL, "commitment_id" uuid NOT NULL, "ends_on" date NOT NULL, "actor_id" uuid NOT NULL, "registered_at" timestamp with time zone NOT NULL, "commitment_version" integer NOT NULL, CONSTRAINT "PK_recurrence_terminations" PRIMARY KEY (commitment_id))`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_occurrence_cancellations" ADD CONSTRAINT "FK_occurrence_cancellations_actor" FOREIGN KEY (actor_id) REFERENCES persons(id) ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_occurrence_cancellations" ADD CONSTRAINT "FK_occurrence_cancellations_occurrence" FOREIGN KEY (space_id, commitment_id, occurrence_id) REFERENCES financial_occurrences(space_id, commitment_id, id) ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_occurrence_shares" ADD CONSTRAINT "FK_occurrence_shares_member" FOREIGN KEY (space_id, member_id) REFERENCES space_members(space_id, id) ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_occurrence_shares" ADD CONSTRAINT "FK_occurrence_shares_occurrence" FOREIGN KEY (space_id, commitment_id, occurrence_id) REFERENCES financial_occurrences(space_id, commitment_id, id) ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_occurrence_value_changes" ADD CONSTRAINT "FK_occurrence_value_changes_actor" FOREIGN KEY (actor_id) REFERENCES persons(id) ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_occurrence_value_changes" ADD CONSTRAINT "FK_occurrence_value_changes_occurrence" FOREIGN KEY (space_id, commitment_id, occurrence_id) REFERENCES financial_occurrences(space_id, commitment_id, id) ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_terminations" ADD CONSTRAINT "FK_recurrence_terminations_actor" FOREIGN KEY (actor_id) REFERENCES persons(id) ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_terminations" ADD CONSTRAINT "FK_recurrence_terminations_commitment" FOREIGN KEY (space_id, commitment_id) REFERENCES financial_commitments(space_id, id) ON DELETE RESTRICT`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_external_liabilities_open_holder" ON public.financial_external_liabilities USING btree (space_id, holder_member_id, holder_person_id, fact_date DESC, id DESC) WHERE (remaining_amount_in_cents > 0)`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_routine_occurrence_assignee" ON public.routine_task_occurrences USING btree (space_id, (((snapshot -> 'assignee'::text) ->> 'personId'::text)), status, scheduled_date)`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_routine_recurrence_assignee" ON public.routine_task_recurrences USING btree (space_id, (((snapshot -> 'assignee'::text) ->> 'personId'::text)))`,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_settlement_transfers_space_registered" ON public.settlement_transfers USING btree (space_id, registered_at DESC, id DESC)`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DROP INDEX "public"."IDX_external_liabilities_open_holder"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_routine_occurrence_assignee"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_routine_recurrence_assignee"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_settlement_transfers_space_registered"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_recurrence_terminations"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_occurrence_value_changes"`,
        );
        await queryRunner.query(`DROP TABLE "financial_occurrence_shares"`);
        await queryRunner.query(
            `DROP TABLE "financial_occurrence_cancellations"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_invitations" DROP CONSTRAINT "FK_space_invitations_closure_process"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_invitations" DROP CONSTRAINT "FK_space_invitations_replacement"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_invitations" DROP CONSTRAINT "FK_space_invitations_issuer"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_invitations" DROP CONSTRAINT "FK_space_invitations_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "spaces" DROP CONSTRAINT "FK_spaces_creator"`,
        );
        await queryRunner.query(
            `ALTER TABLE "spaces" DROP CONSTRAINT "FK_spaces_personal_owner"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_members" DROP CONSTRAINT "FK_space_members_person"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_members" DROP CONSTRAINT "FK_space_members_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_command_receipts" DROP CONSTRAINT "FK_space_command_receipts_result"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_command_receipts" DROP CONSTRAINT "FK_space_command_receipts_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" DROP CONSTRAINT "FK_space_closure_processes_requester"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_processes" DROP CONSTRAINT "FK_space_closure_processes_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_history" DROP CONSTRAINT "FK_space_closure_history_process"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_history" DROP CONSTRAINT "FK_space_closure_history_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_audit" DROP CONSTRAINT "FK_space_closure_audit_process"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_audit" DROP CONSTRAINT "FK_space_closure_audit_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_command_receipts" DROP CONSTRAINT "FK_space_closure_receipts_process"`,
        );
        await queryRunner.query(
            `ALTER TABLE "space_closure_command_receipts" DROP CONSTRAINT "FK_space_closure_receipts_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "auth_sessions" DROP CONSTRAINT "FK_auth_sessions_person"`,
        );
        await queryRunner.query(
            `ALTER TABLE "auth_credentials" DROP CONSTRAINT "FK_auth_credentials_person"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" DROP CONSTRAINT "FK_reversal_application_reversal"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" DROP CONSTRAINT "FK_reversal_application_transfer"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" DROP CONSTRAINT "FK_reversal_application_offset"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" DROP CONSTRAINT "FK_reversal_application_original_obligation"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" DROP CONSTRAINT "FK_reversal_application_effect_obligation"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" DROP CONSTRAINT "FK_reversal_application_source_cycle"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" DROP CONSTRAINT "FK_reversal_application_correction_cycle"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" DROP CONSTRAINT "FK_reversal_application_debtor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversal_applications" DROP CONSTRAINT "FK_reversal_application_creditor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversals" DROP CONSTRAINT "FK_reversal_original_transfer"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversals" DROP CONSTRAINT "FK_reversal_original_offset"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_reversals" DROP CONSTRAINT "FK_reversal_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_audit" DROP CONSTRAINT "FK_settlement_audit_transfer"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_audit" DROP CONSTRAINT "FK_settlement_audit_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_command_receipts" DROP CONSTRAINT "FK_settlement_receipt_transfer"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_command_receipts" DROP CONSTRAINT "FK_settlement_receipt_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_allocations" DROP CONSTRAINT "FK_settlement_allocations_transfer"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_allocations" DROP CONSTRAINT "FK_settlement_allocations_obligation"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_allocations" DROP CONSTRAINT "FK_settlement_allocations_cycle"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_transfers" DROP CONSTRAINT "FK_settlement_transfers_payer"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_transfers" DROP CONSTRAINT "FK_settlement_transfers_recipient"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_transfers" DROP CONSTRAINT "FK_settlement_transfers_author"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_transfers" DROP CONSTRAINT "FK_settlement_transfers_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_audit" DROP CONSTRAINT "FK_offset_audit_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_audit" DROP CONSTRAINT "FK_offset_audit_offset"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_command_receipts" DROP CONSTRAINT "FK_offset_receipt_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_command_receipts" DROP CONSTRAINT "FK_offset_receipt_offset"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" DROP CONSTRAINT "FK_offset_allocation_offset"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" DROP CONSTRAINT "FK_offset_allocation_obligation"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" DROP CONSTRAINT "FK_offset_allocation_cycle"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" DROP CONSTRAINT "FK_offset_allocation_debtor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offset_allocations" DROP CONSTRAINT "FK_offset_allocation_creditor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offsets" DROP CONSTRAINT "FK_settlement_offset_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_offsets" DROP CONSTRAINT "FK_settlement_offset_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_cycle_changes" DROP CONSTRAINT "FK_cycle_change_cycle"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_cycle_changes" DROP CONSTRAINT "FK_cycle_change_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_adjustment_audit" DROP CONSTRAINT "FK_settlement_adjustment_audit_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_adjustment_audit" DROP CONSTRAINT "FK_settlement_adjustment_audit_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_adjustment_receipts" DROP CONSTRAINT "FK_settlement_adjustment_receipt_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_settlement_adjustment_receipts" DROP CONSTRAINT "FK_settlement_adjustment_receipt_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_settlement_rule_changes" DROP CONSTRAINT "FK_commitment_rule_change_rule"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_settlement_rule_changes" DROP CONSTRAINT "FK_commitment_rule_change_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_settlement_rules" DROP CONSTRAINT "FK_commitment_settlement_rule_origin"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_command_receipts" DROP CONSTRAINT "FK_recurrence_receipts_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_command_receipts" DROP CONSTRAINT "FK_recurrence_receipts_commitment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_command_receipts" DROP CONSTRAINT "FK_recurrence_receipts_occurrence"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_occurrences" DROP CONSTRAINT "FK_financial_occurrences_version"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_occurrences" DROP CONSTRAINT "FK_financial_occurrences_installment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_shares" DROP CONSTRAINT "FK_recurrence_shares_version"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_shares" DROP CONSTRAINT "FK_recurrence_shares_member"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_versions" DROP CONSTRAINT "FK_recurrence_versions_commitment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_versions" DROP CONSTRAINT "FK_recurrence_versions_owner"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_recurrence_versions" DROP CONSTRAINT "FK_recurrence_versions_expected_member"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_command_receipts" DROP CONSTRAINT "FK_installment_receipts_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_command_receipts" DROP CONSTRAINT "FK_installment_receipts_commitment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_command_receipts" DROP CONSTRAINT "FK_installment_receipts_installment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_resolutions" DROP CONSTRAINT "FK_installment_resolution_installment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_resolutions" DROP CONSTRAINT "FK_installment_resolution_payoff"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_resolutions" DROP CONSTRAINT "FK_installment_resolution_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_payoffs" DROP CONSTRAINT "FK_installment_payoff_commitment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_payoffs" DROP CONSTRAINT "FK_installment_payoff_fact"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_payoffs" DROP CONSTRAINT "FK_installment_payoff_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_anticipations" DROP CONSTRAINT "FK_installment_anticipation_installment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_anticipations" DROP CONSTRAINT "FK_installment_anticipation_fact"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_anticipations" DROP CONSTRAINT "FK_installment_anticipation_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_shares" DROP CONSTRAINT "FK_installment_shares_installment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_shares" DROP CONSTRAINT "FK_installment_shares_member"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installments" DROP CONSTRAINT "FK_installments_plan"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_plans" DROP CONSTRAINT "FK_installment_plans_commitment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_installment_plans" DROP CONSTRAINT "FK_installment_plans_expected_member"`,
        );
        await queryRunner.query(
            `ALTER TABLE "obligation_waivers" DROP CONSTRAINT "FK_obligation_waiver_origin"`,
        );
        await queryRunner.query(
            `ALTER TABLE "obligation_waivers" DROP CONSTRAINT "FK_obligation_waiver_creditor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "obligation_waivers" DROP CONSTRAINT "FK_obligation_waiver_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_command_receipts" DROP CONSTRAINT "FK_income_command_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_command_receipts" DROP CONSTRAINT "FK_income_command_commitment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_receipts" DROP CONSTRAINT "FK_financial_receipts_commitment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_receipts" DROP CONSTRAINT "FK_financial_receipts_occurrence"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_receipts" DROP CONSTRAINT "FK_financial_receipts_member"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_receipts" DROP CONSTRAINT "FK_financial_receipts_recorder"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_receipts" DROP CONSTRAINT "FK_financial_receipts_person"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_shares" DROP CONSTRAINT "FK_income_shares_version"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_shares" DROP CONSTRAINT "FK_income_shares_member"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_versions" DROP CONSTRAINT "FK_income_versions_commitment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_versions" DROP CONSTRAINT "FK_income_versions_owner"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_income_versions" DROP CONSTRAINT "FK_income_versions_expected_recipient"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_non_recurring_versions" DROP CONSTRAINT "FK_non_recurring_version_commitment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_non_recurring_versions" DROP CONSTRAINT "FK_non_recurring_version_installment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_non_recurring_versions" DROP CONSTRAINT "FK_non_recurring_version_expected_member"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_non_recurring_versions" DROP CONSTRAINT "FK_non_recurring_version_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_cancellations" DROP CONSTRAINT "FK_commitment_cancellation_root"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_cancellations" DROP CONSTRAINT "FK_commitment_cancellation_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" DROP CONSTRAINT "FK_commitment_adjustment_root"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" DROP CONSTRAINT "FK_commitment_adjustment_occurrence"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" DROP CONSTRAINT "FK_commitment_adjustment_installment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" DROP CONSTRAINT "FK_commitment_adjustment_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_adjustments" DROP CONSTRAINT "FK_commitment_adjustment_proposal"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" DROP CONSTRAINT "FK_fulfillment_reversal_root"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" DROP CONSTRAINT "FK_fulfillment_reversal_occurrence"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" DROP CONSTRAINT "FK_fulfillment_reversal_installment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" DROP CONSTRAINT "FK_fulfillment_reversal_disbursement"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" DROP CONSTRAINT "FK_fulfillment_reversal_external"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" DROP CONSTRAINT "FK_fulfillment_reversal_external_settlement"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" DROP CONSTRAINT "FK_fulfillment_reversal_receipt"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_fulfillment_reversals" DROP CONSTRAINT "FK_fulfillment_reversal_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_closure_effects" DROP CONSTRAINT "FK_financial_closure_effect_origin"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_closure_effects" DROP CONSTRAINT "FK_financial_closure_effect_successor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_closure_effects" DROP CONSTRAINT "FK_financial_closure_effect_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_integrity_command_receipts" DROP CONSTRAINT "FK_integrity_receipt_origin"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_integrity_command_receipts" DROP CONSTRAINT "FK_integrity_receipt_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" DROP CONSTRAINT "FK_commitment_change_proposal_origin"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" DROP CONSTRAINT "FK_commitment_change_proposal_author"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" DROP CONSTRAINT "FK_commitment_change_proposal_recipient"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" DROP CONSTRAINT "FK_commitment_change_proposal_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_change_proposals" DROP CONSTRAINT "FK_commitment_change_proposal_decider"`,
        );
        await queryRunner.query(
            `ALTER TABLE "finances_command_receipts" DROP CONSTRAINT "finances_command_receipts_actor_id_fkey"`,
        );
        await queryRunner.query(
            `ALTER TABLE "finances_command_receipts" DROP CONSTRAINT "finances_command_receipts_result_space_id_result_version_fkey"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liability_settlements" DROP CONSTRAINT "FK_external_settlement_origin"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liability_settlements" DROP CONSTRAINT "FK_external_settlement_receipt"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liability_settlements" DROP CONSTRAINT "FK_external_settlement_holder"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liability_settlements" DROP CONSTRAINT "FK_external_settlement_person"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_expense_command_receipts" DROP CONSTRAINT "FK_expense_receipts_commitment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_expense_command_receipts" DROP CONSTRAINT "FK_expense_receipts_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligation_changes" DROP CONSTRAINT "FK_obligation_changes_allocation"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligation_changes" DROP CONSTRAINT "FK_obligation_changes_obligation"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligation_changes" DROP CONSTRAINT "FK_obligation_changes_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "FK_obligations_external_liability"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "FK_obligations_occurrence"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "FK_obligations_receipt"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "FK_obligations_origin"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "FK_obligations_debtor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "FK_obligations_creditor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "FK_obligations_cycle"`,
        );
        await queryRunner.query(
            `ALTER TABLE "inter_member_obligations" DROP CONSTRAINT "FK_obligations_closure_agreement"`,
        );
        await queryRunner.query(
            `ALTER TABLE "settlement_cycles" DROP CONSTRAINT "FK_settlement_cycles_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liabilities" DROP CONSTRAINT "FK_external_liabilities_commitment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liabilities" DROP CONSTRAINT "FK_financial_external_liabilities_occurrence"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liabilities" DROP CONSTRAINT "FK_external_liabilities_holder"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liabilities" DROP CONSTRAINT "FK_external_liabilities_recorder"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_external_liabilities" DROP CONSTRAINT "FK_external_liabilities_personal_holder"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" DROP CONSTRAINT "FK_financial_disbursements_commitment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" DROP CONSTRAINT "FK_financial_disbursements_occurrence"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" DROP CONSTRAINT "FK_financial_disbursements_payer"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" DROP CONSTRAINT "FK_financial_disbursements_personal_payer"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_disbursements" DROP CONSTRAINT "FK_financial_disbursements_recorder"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_shares" DROP CONSTRAINT "FK_financial_shares_version"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_shares" DROP CONSTRAINT "FK_financial_shares_member"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" DROP CONSTRAINT "FK_financial_versions_commitment"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitment_versions" DROP CONSTRAINT "FK_financial_versions_expected_payer"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" DROP CONSTRAINT "FK_financial_commitments_author"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" DROP CONSTRAINT "FK_financial_commitments_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "financial_commitments" DROP CONSTRAINT "FK_financial_commitments_personal_owner"`,
        );
        await queryRunner.query(
            `ALTER TABLE "default_settlement_rule_changes" DROP CONSTRAINT "default_settlement_rule_changes_space_id_fkey"`,
        );
        await queryRunner.query(
            `ALTER TABLE "default_settlement_rule_changes" DROP CONSTRAINT "default_settlement_rule_changes_actor_person_id_fkey"`,
        );
        await queryRunner.query(
            `ALTER TABLE "default_settlement_rules" DROP CONSTRAINT "default_settlement_rules_space_id_fkey"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_task_occurrences" DROP CONSTRAINT "FK_routine_occurrence_rule"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_task_recurrences" DROP CONSTRAINT "FK_routine_recurrence_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_task_recurrences" DROP CONSTRAINT "FK_routine_recurrence_creator"`,
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
            `ALTER TABLE "shopping_purchase_corrections" DROP CONSTRAINT "FK_shopping_correction_purchase"`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_purchase_corrections" DROP CONSTRAINT "FK_shopping_correction_author"`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_purchase_corrections" DROP CONSTRAINT "FK_shopping_correction_member"`,
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
            `ALTER TABLE "shopping_items" DROP CONSTRAINT "FK_shopping_item_list"`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_items" DROP CONSTRAINT "FK_shopping_item_creator"`,
        );
        await queryRunner.query(
            `ALTER TABLE "shopping_items" DROP CONSTRAINT "FK_shopping_item_creator_member"`,
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
            `ALTER TABLE "routine_command_audit" DROP CONSTRAINT "FK_routine_audit_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_command_audit" DROP CONSTRAINT "FK_routine_audit_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_command_receipts" DROP CONSTRAINT "FK_routine_receipt_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_history" DROP CONSTRAINT "FK_routine_history_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_history" DROP CONSTRAINT "FK_routine_history_actor"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" DROP CONSTRAINT "FK_routine_task_space"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" DROP CONSTRAINT "FK_routine_task_shopping_list"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" DROP CONSTRAINT "FK_routine_task_creator"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" DROP CONSTRAINT "FK_routine_task_assignee"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" DROP CONSTRAINT "FK_routine_task_creator_member"`,
        );
        await queryRunner.query(
            `ALTER TABLE "routine_tasks" DROP CONSTRAINT "FK_routine_task_assignee_member"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."UQ_space_invitations_pending"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."UQ_space_invitations_token_hash"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_space_invitations_history"`,
        );
        await queryRunner.query(`DROP TABLE "space_invitations"`);
        await queryRunner.query(
            `DROP INDEX "public"."UQ_spaces_personal_owner"`,
        );
        await queryRunner.query(`DROP TABLE "spaces"`);
        await queryRunner.query(
            `DROP INDEX "public"."UQ_space_members_active_person"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."UQ_space_members_active_slot"`,
        );
        await queryRunner.query(`DROP TABLE "space_members"`);
        await queryRunner.query(`DROP TABLE "space_command_receipts"`);
        await queryRunner.query(
            `DROP INDEX "public"."UQ_space_closure_processes_open"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_space_closure_processes_history"`,
        );
        await queryRunner.query(`DROP TABLE "space_closure_processes"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_space_closure_history_page"`,
        );
        await queryRunner.query(`DROP TABLE "space_closure_history"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_space_closure_audit_process"`,
        );
        await queryRunner.query(`DROP TABLE "space_closure_audit"`);
        await queryRunner.query(`DROP TABLE "persons"`);
        await queryRunner.query(`DROP TABLE "space_closure_command_receipts"`);
        await queryRunner.query(
            `DROP INDEX "public"."UQ_auth_sessions_token_hash"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_auth_sessions_person_id"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_auth_sessions_expires_at"`,
        );
        await queryRunner.query(`DROP TABLE "auth_sessions"`);
        await queryRunner.query(
            `DROP INDEX "public"."UQ_auth_credentials_email"`,
        );
        await queryRunner.query(`DROP TABLE "auth_credentials"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_reversal_application_origin"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_reversal_application_source_cycle"`,
        );
        await queryRunner.query(
            `DROP TABLE "settlement_reversal_applications"`,
        );
        await queryRunner.query(`DROP TABLE "settlement_reversals"`);
        await queryRunner.query(`DROP TABLE "financial_settlement_audit"`);
        await queryRunner.query(
            `DROP TABLE "financial_settlement_command_receipts"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_settlement_allocations_obligation"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_settlement_allocations_cycle"`,
        );
        await queryRunner.query(`DROP TABLE "settlement_allocations"`);
        await queryRunner.query(`DROP TABLE "settlement_transfers"`);
        await queryRunner.query(`DROP TABLE "settlement_offset_audit"`);
        await queryRunner.query(
            `DROP TABLE "settlement_offset_command_receipts"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_offset_allocation_cycle"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_offset_allocation_obligation"`,
        );
        await queryRunner.query(`DROP TABLE "settlement_offset_allocations"`);
        await queryRunner.query(`DROP TABLE "settlement_offsets"`);
        await queryRunner.query(`DROP TABLE "settlement_cycle_changes"`);
        await queryRunner.query(
            `DROP TABLE "financial_settlement_adjustment_audit"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_settlement_adjustment_receipts"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_commitment_settlement_rule_changes"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_commitment_settlement_rules"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_recurrence_command_receipts"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_financial_occurrences_space_date"`,
        );
        await queryRunner.query(`DROP TABLE "financial_occurrences"`);
        await queryRunner.query(`DROP TABLE "financial_recurrence_shares"`);
        await queryRunner.query(`DROP TABLE "financial_recurrence_versions"`);
        await queryRunner.query(
            `DROP TABLE "financial_installment_command_receipts"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."UQ_installment_resolution_active"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_installment_resolutions"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."UQ_installment_payoff_active"`,
        );
        await queryRunner.query(`DROP TABLE "financial_installment_payoffs"`);
        await queryRunner.query(
            `DROP TABLE "financial_installment_anticipations"`,
        );
        await queryRunner.query(`DROP TABLE "financial_installment_shares"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_installments_space_due"`,
        );
        await queryRunner.query(`DROP TABLE "financial_installments"`);
        await queryRunner.query(`DROP TABLE "financial_installment_plans"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_obligation_waiver_origin"`,
        );
        await queryRunner.query(`DROP TABLE "obligation_waivers"`);
        await queryRunner.query(
            `DROP TABLE "financial_income_command_receipts"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_financial_receipts_occurrence"`,
        );
        await queryRunner.query(`DROP TABLE "financial_receipts"`);
        await queryRunner.query(`DROP TABLE "financial_income_shares"`);
        await queryRunner.query(`DROP TABLE "financial_income_versions"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_non_recurring_version_selection"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_non_recurring_versions"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_commitment_cancellations"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_commitment_adjustment_target"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_commitment_adjustments"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_fulfillment_reversal_original"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_fulfillment_reversal_target"`,
        );
        await queryRunner.query(`DROP TABLE "financial_fulfillment_reversals"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_financial_command_audit_origin"`,
        );
        await queryRunner.query(`DROP TABLE "financial_command_audit"`);
        await queryRunner.query(`DROP TABLE "financial_closure_effects"`);
        await queryRunner.query(
            `DROP TABLE "financial_integrity_command_receipts"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_commitment_change_proposals_recipient"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_commitment_change_proposals"`,
        );
        await queryRunner.query(`DROP TABLE "finances_command_receipts"`);
        await queryRunner.query(
            `DROP TABLE "financial_external_liability_settlements"`,
        );
        await queryRunner.query(
            `DROP TABLE "financial_expense_command_receipts"`,
        );
        await queryRunner.query(`DROP TABLE "inter_member_obligation_changes"`);
        await queryRunner.query(
            `DROP INDEX "public"."UQ_obligations_open_one_time"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."UQ_obligations_open_occurrence"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_obligations_space_origin"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."UQ_obligations_closure_agreement"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_obligations_space_cycle"`,
        );
        await queryRunner.query(`DROP TABLE "inter_member_obligations"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_settlement_cycles_open"`,
        );
        await queryRunner.query(`DROP TABLE "settlement_cycles"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_financial_external_liabilities_occurrence"`,
        );
        await queryRunner.query(`DROP TABLE "financial_external_liabilities"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_financial_disbursements_occurrence"`,
        );
        await queryRunner.query(`DROP TABLE "financial_disbursements"`);
        await queryRunner.query(`DROP TABLE "financial_commitment_shares"`);
        await queryRunner.query(`DROP TABLE "financial_commitment_versions"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_financial_commitments_space_registered"`,
        );
        await queryRunner.query(`DROP TABLE "financial_commitments"`);
        await queryRunner.query(`DROP TABLE "default_settlement_rule_changes"`);
        await queryRunner.query(`DROP TABLE "default_settlement_rules"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_routine_occurrence_list"`,
        );
        await queryRunner.query(`DROP TABLE "routine_task_occurrences"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_routine_recurrence_space"`,
        );
        await queryRunner.query(`DROP TABLE "routine_task_recurrences"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_shopping_audit_space"`,
        );
        await queryRunner.query(`DROP TABLE "shopping_command_audit"`);
        await queryRunner.query(`DROP TABLE "shopping_command_receipts"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_shopping_history_page"`,
        );
        await queryRunner.query(`DROP TABLE "shopping_history"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_shopping_correction_page"`,
        );
        await queryRunner.query(`DROP TABLE "shopping_purchase_corrections"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_shopping_purchase_page"`,
        );
        await queryRunner.query(`DROP TABLE "shopping_purchase_records"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_shopping_item_page"`);
        await queryRunner.query(`DROP TABLE "shopping_items"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_shopping_list_page"`);
        await queryRunner.query(`DROP TABLE "shopping_lists"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_routine_audit_space"`,
        );
        await queryRunner.query(`DROP TABLE "routine_command_audit"`);
        await queryRunner.query(`DROP TABLE "routine_command_receipts"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_routine_history_page"`,
        );
        await queryRunner.query(`DROP TABLE "routine_history"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_routine_task_list"`);
        await queryRunner.query(
            `DROP INDEX "public"."IDX_routine_task_assignee"`,
        );
        await queryRunner.query(
            `DROP INDEX "public"."IDX_routine_task_shopping_list"`,
        );
        await queryRunner.query(`DROP TABLE "routine_tasks"`);
    }
}
