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
    FinancialCommitmentOrmEntity,
    safeBigInt,
} from './shared-expense.orm-entity.js';

@Entity('financial_recurrence_versions')
@Unique('UQ_recurrence_versions_space', ['spaceId', 'commitmentId', 'version'])
@Check(
    'CHK_recurrence_versions_values',
    `version > 0 AND amount_in_cents BETWEEN 1 AND 9007199254740991 AND frequency IN ('MONTHLY','ANNUAL') AND day_of_month BETWEEN 1 AND 31 AND ((frequency='MONTHLY' AND month_of_year IS NULL) OR (frequency='ANNUAL' AND month_of_year BETWEEN 1 AND 12)) AND (ends_on IS NULL OR ends_on >= starts_on) AND ((owner_person_id IS NOT NULL AND split_input IS NULL AND expected_member_id IS NULL AND rule_snapshot IS NULL AND rule_source_version=0) OR (owner_person_id IS NULL AND split_input IS NOT NULL AND rule_source_version >= 0 AND (rule_snapshot IS NULL)=(rule_source_version=0)))`,
)
@ForeignKey(
    () => FinancialCommitmentOrmEntity,
    ['spaceId', 'commitmentId'],
    ['spaceId', 'id'],
    { name: 'FK_recurrence_versions_commitment', onDelete: 'RESTRICT' },
)
@ForeignKey('persons', ['ownerPersonId'], ['id'], {
    name: 'FK_recurrence_versions_owner',
    onDelete: 'RESTRICT',
})
@ForeignKey(
    'space_members',
    ['spaceId', 'expectedMemberId'],
    ['spaceId', 'id'],
    { name: 'FK_recurrence_versions_expected_member', onDelete: 'RESTRICT' },
)
export class FinancialRecurrenceVersionOrmEntity {
    @PrimaryColumn({ name: 'commitment_id', type: 'uuid' })
    commitmentId!: string;
    @PrimaryColumn('integer') version!: number;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
    @Column({ type: 'varchar', length: 8 }) frequency!: 'MONTHLY' | 'ANNUAL';
    @Column({ name: 'day_of_month', type: 'integer' }) dayOfMonth!: number;
    @Column({ name: 'month_of_year', type: 'integer', nullable: true })
    monthOfYear!: number | null;
    @Column({ name: 'starts_on', type: 'date' }) startsOn!: string;
    @Column({ name: 'ends_on', type: 'date', nullable: true }) endsOn!:
        string | null;
    @Column({ name: 'owner_person_id', type: 'uuid', nullable: true })
    ownerPersonId!: string | null;
    @Column({ name: 'split_input', type: 'jsonb', nullable: true })
    splitInput!: SplitInput | null;
    @Column({ name: 'expected_member_id', type: 'uuid', nullable: true })
    expectedMemberId!: string | null;
    @Column({ name: 'rule_snapshot', type: 'jsonb', nullable: true })
    ruleSnapshot!: SettlementRuleSnapshot | null;
    @Column({ name: 'rule_source_version', type: 'integer' })
    ruleSourceVersion!: number;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}

@Entity('financial_recurrence_shares')
@Check(
    'CHK_recurrence_shares_values',
    `amount_in_cents BETWEEN 0 AND 9007199254740991`,
)
@ForeignKey(
    () => FinancialRecurrenceVersionOrmEntity,
    ['spaceId', 'commitmentId', 'version'],
    ['spaceId', 'commitmentId', 'version'],
    { name: 'FK_recurrence_shares_version', onDelete: 'RESTRICT' },
)
@ForeignKey('space_members', ['spaceId', 'memberId'], ['spaceId', 'id'], {
    name: 'FK_recurrence_shares_member',
    onDelete: 'RESTRICT',
})
export class FinancialRecurrenceShareOrmEntity {
    @PrimaryColumn({ name: 'commitment_id', type: 'uuid' })
    commitmentId!: string;
    @PrimaryColumn('integer') version!: number;
    @PrimaryColumn({ name: 'member_id', type: 'uuid' }) memberId!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
}

@Entity('financial_occurrences')
@Unique('UQ_financial_occurrences_date', [
    'spaceId',
    'commitmentId',
    'referenceDate',
])
@Unique('UQ_financial_occurrences_origin', ['spaceId', 'commitmentId', 'id'])
@Index('IDX_financial_occurrences_space_date', [
    'spaceId',
    'referenceDate',
    'id',
])
@Check(
    'CHK_financial_occurrences_state',
    `economic_version > 0 AND state_version > 0 AND amount_in_cents BETWEEN 1 AND 9007199254740991 AND status IN ('PENDING','PARTIALLY_FULFILLED','FULFILLED','CANCELLED')`,
)
@ForeignKey(
    () => FinancialRecurrenceVersionOrmEntity,
    ['spaceId', 'commitmentId', 'economicVersion'],
    ['spaceId', 'commitmentId', 'version'],
    { name: 'FK_financial_occurrences_version', onDelete: 'RESTRICT' },
)
export class FinancialOccurrenceOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column({ name: 'reference_date', type: 'date' }) referenceDate!: string;
    @Column({ name: 'economic_version', type: 'integer' })
    economicVersion!: number;
    @Column({ name: 'state_version', type: 'integer' }) stateVersion!: number;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
    @Column({ type: 'varchar', length: 24 })
    status!: 'PENDING' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | 'CANCELLED';
    @Column({ name: 'materialized_at', type: 'timestamptz' })
    materializedAt!: Date;
}

@Entity('financial_recurrence_command_receipts')
@Check(
    'CHK_recurrence_command_receipts',
    `status='COMPLETED' AND octet_length(request_hash)=32 AND operation IN ('CREATE_FIXED_RECURRING_COMMITMENT','RECORD_RECURRING_DISBURSEMENT','RECORD_RECURRING_RECEIPT','RECORD_RECURRING_EXTERNAL_LIABILITY','SETTLE_RECURRING_EXTERNAL_LIABILITY')`,
)
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_recurrence_receipts_actor',
    onDelete: 'RESTRICT',
})
@ForeignKey(
    () => FinancialCommitmentOrmEntity,
    ['spaceId', 'commitmentId'],
    ['spaceId', 'id'],
    {
        name: 'FK_recurrence_receipts_commitment',
        onDelete: 'RESTRICT',
    },
)
@ForeignKey(
    'financial_occurrences',
    ['spaceId', 'commitmentId', 'occurrenceId'],
    ['spaceId', 'commitmentId', 'id'],
    {
        name: 'FK_recurrence_receipts_occurrence',
        onDelete: 'RESTRICT',
    },
)
export class FinancialRecurrenceCommandReceiptOrmEntity {
    @PrimaryColumn({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @PrimaryColumn({ type: 'varchar', length: 40 }) operation!: string;
    @PrimaryColumn({ name: 'idempotency_key', type: 'uuid' })
    idempotencyKey!: string;
    @Column({ name: 'request_hash', type: 'bytea' }) requestHash!: Buffer;
    @Column({ type: 'varchar', length: 16 }) status!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column({ name: 'occurrence_id', type: 'uuid', nullable: true })
    occurrenceId!: string | null;
    @Column({ type: 'jsonb' }) result!: unknown;
    @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

export const recurrenceEntities = [
    FinancialRecurrenceVersionOrmEntity,
    FinancialRecurrenceShareOrmEntity,
    FinancialOccurrenceOrmEntity,
    FinancialRecurrenceCommandReceiptOrmEntity,
];
