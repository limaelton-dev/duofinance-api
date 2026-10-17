import {
    Check,
    Column,
    Entity,
    ForeignKey,
    Index,
    PrimaryColumn,
    Unique,
} from 'typeorm';
import type { SplitInput } from '../../../domain/shared-expense/responsibility-split.js';
import type { SettlementRuleSnapshot } from '../../../domain/settlement-rule/settlement-rule.js';
import {
    safeBigInt,
    FinancialCommitmentOrmEntity,
} from './shared-expense.orm-entity.js';

@Entity('financial_income_versions')
@Unique('UQ_income_versions_space', ['spaceId', 'commitmentId'])
@Check(
    'CHK_income_versions_values',
    `amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND ((owner_person_id IS NOT NULL AND split_input IS NULL AND expected_recipient_member_id IS NULL AND rule_snapshot IS NULL AND rule_source_version = 0) OR (owner_person_id IS NULL AND split_input IS NOT NULL AND (rule_snapshot IS NULL) = (rule_source_version = 0)))`,
)
@ForeignKey(
    () => FinancialCommitmentOrmEntity,
    ['spaceId', 'commitmentId'],
    ['spaceId', 'id'],
    { name: 'FK_income_versions_commitment', onDelete: 'RESTRICT' },
)
@ForeignKey('persons', ['ownerPersonId'], ['id'], {
    name: 'FK_income_versions_owner',
    onDelete: 'RESTRICT',
})
@ForeignKey(
    'space_members',
    ['spaceId', 'expectedRecipientMemberId'],
    ['spaceId', 'id'],
    { name: 'FK_income_versions_expected_recipient', onDelete: 'RESTRICT' },
)
export class FinancialIncomeVersionOrmEntity {
    @PrimaryColumn({ name: 'commitment_id', type: 'uuid' })
    commitmentId!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
    @Column({ name: 'expected_receipt_date', type: 'date' })
    expectedReceiptDate!: string;
    @Column({ name: 'owner_person_id', type: 'uuid', nullable: true })
    ownerPersonId!: string | null;
    @Column({ name: 'split_input', type: 'jsonb', nullable: true })
    splitInput!: SplitInput | null;
    @Column({
        name: 'expected_recipient_member_id',
        type: 'uuid',
        nullable: true,
    })
    expectedRecipientMemberId!: string | null;
    @Column({ name: 'rule_snapshot', type: 'jsonb', nullable: true })
    ruleSnapshot!: SettlementRuleSnapshot | null;
    @Column({ name: 'rule_source_version', type: 'integer' })
    ruleSourceVersion!: number;
}

@Entity('financial_income_shares')
@Check(
    'CHK_income_shares_values',
    `amount_in_cents >= 0 AND amount_in_cents <= 9007199254740991`,
)
@ForeignKey(
    () => FinancialIncomeVersionOrmEntity,
    ['spaceId', 'commitmentId'],
    ['spaceId', 'commitmentId'],
    { name: 'FK_income_shares_version', onDelete: 'RESTRICT' },
)
@ForeignKey('space_members', ['spaceId', 'memberId'], ['spaceId', 'id'], {
    name: 'FK_income_shares_member',
    onDelete: 'RESTRICT',
})
export class FinancialIncomeShareOrmEntity {
    @PrimaryColumn({ name: 'commitment_id', type: 'uuid' })
    commitmentId!: string;
    @PrimaryColumn({ name: 'member_id', type: 'uuid' }) memberId!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
}

@Entity('financial_receipts')
@Index('IDX_financial_receipts_occurrence', ['spaceId', 'occurrenceId'], {
    where: 'occurrence_id IS NOT NULL',
})
@Unique('UQ_receipt_sequence', ['commitmentId', 'sequence'])
@Check('CHK_receipt_sequence', 'sequence > 0')
@Unique('UQ_financial_receipts_origin', ['spaceId', 'commitmentId', 'id'])
@Check(
    'CHK_financial_receipts_values',
    `amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((recipient_person_id IS NOT NULL AND recipient_member_id IS NULL) OR (recipient_person_id IS NULL AND recipient_member_id IS NOT NULL))`,
)
@ForeignKey(
    () => FinancialCommitmentOrmEntity,
    ['spaceId', 'commitmentId'],
    ['spaceId', 'id'],
    {
        name: 'FK_financial_receipts_commitment',
        onDelete: 'RESTRICT',
    },
)
@ForeignKey(
    'financial_occurrences',
    ['spaceId', 'commitmentId', 'occurrenceId'],
    ['spaceId', 'commitmentId', 'id'],
    {
        name: 'FK_financial_receipts_occurrence',
        onDelete: 'RESTRICT',
    },
)
@ForeignKey(
    'space_members',
    ['spaceId', 'recipientMemberId'],
    ['spaceId', 'id'],
    { name: 'FK_financial_receipts_member', onDelete: 'RESTRICT' },
)
@ForeignKey('persons', ['recordedByPersonId'], ['id'], {
    name: 'FK_financial_receipts_recorder',
    onDelete: 'RESTRICT',
})
@ForeignKey('persons', ['recipientPersonId'], ['id'], {
    name: 'FK_financial_receipts_person',
    onDelete: 'RESTRICT',
})
export class FinancialReceiptOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column({ name: 'occurrence_id', type: 'uuid', nullable: true })
    occurrenceId!: string | null;
    @Column('integer') sequence!: number;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
    @Column({ name: 'fact_date', type: 'date' }) factDate!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
    @Column({ name: 'recorded_by_person_id', type: 'uuid' })
    recordedByPersonId!: string;
    @Column({ name: 'recipient_person_id', type: 'uuid', nullable: true })
    recipientPersonId!: string | null;
    @Column({ name: 'recipient_member_id', type: 'uuid', nullable: true })
    recipientMemberId!: string | null;
}

@Entity('financial_income_command_receipts')
@Check(
    'CHK_income_command_receipts',
    `operation IN ('RECORD_INCOME','RECORD_INCOME_RECEIPT') AND status = 'COMPLETED' AND octet_length(request_hash) = 32`,
)
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_income_command_actor',
    onDelete: 'RESTRICT',
})
@ForeignKey(() => FinancialCommitmentOrmEntity, ['commitmentId'], ['id'], {
    name: 'FK_income_command_commitment',
    onDelete: 'RESTRICT',
})
export class FinancialIncomeCommandReceiptOrmEntity {
    @PrimaryColumn({ name: 'actor_id', type: 'uuid' })
    actorId!: string;
    @PrimaryColumn({ type: 'varchar', length: 32 }) operation!: string;
    @PrimaryColumn({ name: 'idempotency_key', type: 'uuid' })
    idempotencyKey!: string;
    @Column({ name: 'request_hash', type: 'bytea' }) requestHash!: Buffer;
    @Column({ type: 'varchar', length: 16 }) status!: string;
    @Column({ name: 'commitment_id', type: 'uuid' })
    commitmentId!: string;
    @Column({ type: 'jsonb' }) result!: unknown;
    @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

export const incomeEntities = [
    FinancialIncomeVersionOrmEntity,
    FinancialIncomeShareOrmEntity,
    FinancialReceiptOrmEntity,
    FinancialIncomeCommandReceiptOrmEntity,
];
