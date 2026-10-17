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
import type { EconomicShare } from '../../../domain/shared-expense/responsibility-split.js';
import type { SettlementRuleSnapshot } from '../../../domain/settlement-rule/settlement-rule.js';
import {
    FinancialDisbursementOrmEntity,
    safeBigInt,
} from './shared-expense.orm-entity.js';

@Entity('financial_installment_plans')
@Unique('UQ_installment_plans_origin', ['spaceId', 'commitmentId', 'id'])
@Unique('UQ_installment_plans_commitment', ['spaceId', 'commitmentId'])
@Check(
    'CHK_installment_plans_values',
    `installment_count > 0 AND total_amount_in_cents BETWEEN 1 AND 9007199254740991 AND cadence IN ('MONTHLY','ANNUAL','EXPLICIT') AND (planned_payment_method IS NULL OR planned_payment_method IN ('CARD','PIX','DEBIT','CASH')) AND rule_source_version >= 0 AND (rule_snapshot IS NULL)=(rule_source_version=0) AND ((split_input IS NULL AND expected_member_id IS NULL) OR split_input IS NOT NULL)`,
)
@ForeignKey(
    'financial_commitments',
    ['spaceId', 'commitmentId'],
    ['spaceId', 'id'],
    { name: 'FK_installment_plans_commitment', onDelete: 'RESTRICT' },
)
@ForeignKey(
    'space_members',
    ['spaceId', 'expectedMemberId'],
    ['spaceId', 'id'],
    { name: 'FK_installment_plans_expected_member', onDelete: 'RESTRICT' },
)
export class FinancialInstallmentPlanOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column({ name: 'installment_count', type: 'integer' })
    installmentCount!: number;
    @Column({
        name: 'total_amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    totalAmountInCents!: number;
    @Column({ type: 'varchar', length: 8 }) cadence!:
        'MONTHLY' | 'ANNUAL' | 'EXPLICIT';
    @Column({
        name: 'planned_payment_method',
        type: 'varchar',
        length: 8,
        nullable: true,
    })
    plannedPaymentMethod!: 'CARD' | 'PIX' | 'DEBIT' | 'CASH' | null;
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

@Entity('financial_installments')
@Unique('UQ_installments_origin', ['spaceId', 'commitmentId', 'id'])
@Unique('UQ_installments_position', ['planId', 'position'])
@Unique('UQ_installments_due_date', ['planId', 'dueDate'])
@Index('IDX_installments_space_due', ['spaceId', 'dueDate', 'id'])
@Check(
    'CHK_installments_values',
    `position > 0 AND amount_in_cents BETWEEN 1 AND 9007199254740991`,
)
@ForeignKey(
    () => FinancialInstallmentPlanOrmEntity,
    ['spaceId', 'commitmentId', 'planId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_installments_plan', onDelete: 'RESTRICT' },
)
export class FinancialInstallmentOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column({ name: 'plan_id', type: 'uuid' }) planId!: string;
    @Column('integer') position!: number;
    @Column({ name: 'due_date', type: 'date' }) dueDate!: string;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
}

@Entity('financial_installment_shares')
@Check(
    'CHK_installment_shares_values',
    `amount_in_cents BETWEEN 0 AND 9007199254740991`,
)
@ForeignKey(
    () => FinancialInstallmentOrmEntity,
    ['spaceId', 'commitmentId', 'installmentId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_installment_shares_installment', onDelete: 'RESTRICT' },
)
@ForeignKey('space_members', ['spaceId', 'memberId'], ['spaceId', 'id'], {
    name: 'FK_installment_shares_member',
    onDelete: 'RESTRICT',
})
export class FinancialInstallmentShareOrmEntity {
    @PrimaryColumn({ name: 'installment_id', type: 'uuid' })
    installmentId!: string;
    @PrimaryColumn({ name: 'member_id', type: 'uuid' }) memberId!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
}

@Entity('financial_installment_anticipations')
@Unique('UQ_installment_anticipation_origin', [
    'spaceId',
    'commitmentId',
    'installmentId',
])
@Unique('UQ_installment_anticipation_fact', ['factId'])
@Check(
    'CHK_installment_anticipation_values',
    `expected_remaining_amount_in_cents BETWEEN 1 AND 9007199254740991 AND paid_amount_in_cents BETWEEN 1 AND 9007199254740991 AND effective_amount_in_cents BETWEEN 1 AND 9007199254740991 AND adjustment_in_cents=paid_amount_in_cents-expected_remaining_amount_in_cents AND fact_date<due_date`,
)
@ForeignKey(
    () => FinancialInstallmentOrmEntity,
    ['spaceId', 'commitmentId', 'installmentId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_installment_anticipation_installment', onDelete: 'RESTRICT' },
)
@ForeignKey(
    () => FinancialDisbursementOrmEntity,
    ['spaceId', 'commitmentId', 'factId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_installment_anticipation_fact', onDelete: 'RESTRICT' },
)
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_installment_anticipation_actor',
    onDelete: 'RESTRICT',
})
export class FinancialInstallmentAnticipationOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column({ name: 'installment_id', type: 'uuid' }) installmentId!: string;
    @Column({ name: 'fact_id', type: 'uuid' }) factId!: string;
    @Column({ name: 'due_date', type: 'date' }) dueDate!: string;
    @Column({
        name: 'expected_remaining_amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    expectedRemainingAmountInCents!: number;
    @Column({
        name: 'paid_amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    paidAmountInCents!: number;
    @Column({
        name: 'effective_amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    effectiveAmountInCents!: number;
    @Column({
        name: 'adjustment_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    adjustmentInCents!: number;
    @Column({ name: 'economic_shares', type: 'jsonb', nullable: true })
    economicShares!: readonly EconomicShare[] | null;
    @Column({ name: 'fact_date', type: 'date' }) factDate!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
    @Column({ name: 'actor_id', type: 'uuid' }) actorId!: string;
}

@Entity('financial_installment_payoffs')
@Index('UQ_installment_payoff_active', ['spaceId', 'commitmentId'], {
    unique: true,
    where: 'compensated=false',
})
@Unique('UQ_installment_payoff_scope', ['spaceId', 'commitmentId', 'id'])
@Unique('UQ_installment_payoff_fact', ['factId'])
@Check(
    'CHK_installment_payoff_values',
    `expected_remaining_amount_in_cents BETWEEN 1 AND 9007199254740991 AND paid_amount_in_cents BETWEEN 1 AND 9007199254740991 AND adjustment_in_cents=paid_amount_in_cents-expected_remaining_amount_in_cents`,
)
@ForeignKey(
    'financial_commitments',
    ['spaceId', 'commitmentId'],
    ['spaceId', 'id'],
    { name: 'FK_installment_payoff_commitment', onDelete: 'RESTRICT' },
)
@ForeignKey(
    () => FinancialDisbursementOrmEntity,
    ['spaceId', 'commitmentId', 'factId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_installment_payoff_fact', onDelete: 'RESTRICT' },
)
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_installment_payoff_actor',
    onDelete: 'RESTRICT',
})
export class FinancialInstallmentPayoffOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ type: 'boolean', default: false }) compensated!: boolean;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column({ name: 'fact_id', type: 'uuid' }) factId!: string;
    @Column({
        name: 'expected_remaining_amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    expectedRemainingAmountInCents!: number;
    @Column({
        name: 'paid_amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    paidAmountInCents!: number;
    @Column({
        name: 'adjustment_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    adjustmentInCents!: number;
    @Column({ name: 'economic_shares', type: 'jsonb', nullable: true })
    economicShares!: readonly EconomicShare[] | null;
    @Column({ name: 'expected_economic_shares', type: 'jsonb', nullable: true })
    expectedEconomicShares!: readonly EconomicShare[] | null;
    @Column({
        name: 'recognized_manual_adjustments',
        type: 'jsonb',
        nullable: true,
    })
    recognizedManualAdjustments!: {
        amountInCents: number;
        shareChanges: readonly EconomicShare[] | null;
    } | null;
    @Column({
        name: 'recognized_remaining_shares',
        type: 'jsonb',
        nullable: true,
    })
    recognizedRemainingShares!: readonly EconomicShare[] | null;
    @Column({ name: 'fact_date', type: 'date' }) factDate!: string;
    @Column({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}

@Entity('financial_installment_resolutions')
@Index('UQ_installment_resolution_active', ['installmentId'], {
    unique: true,
    where: 'compensated=false',
})
@Check(
    'CHK_installment_resolution_values',
    `expected_remaining_amount_in_cents BETWEEN 1 AND 9007199254740991 AND ((type='PAYOFF' AND payoff_id IS NOT NULL AND reason IS NULL) OR (type='CANCELLED' AND payoff_id IS NULL AND length(trim(reason)) BETWEEN 1 AND 500))`,
)
@ForeignKey(
    () => FinancialInstallmentOrmEntity,
    ['spaceId', 'commitmentId', 'installmentId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_installment_resolution_installment', onDelete: 'RESTRICT' },
)
@ForeignKey(
    () => FinancialInstallmentPayoffOrmEntity,
    ['spaceId', 'commitmentId', 'payoffId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_installment_resolution_payoff', onDelete: 'RESTRICT' },
)
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_installment_resolution_actor',
    onDelete: 'RESTRICT',
})
export class FinancialInstallmentResolutionOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ type: 'boolean', default: false }) compensated!: boolean;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column({ name: 'installment_id', type: 'uuid' }) installmentId!: string;
    @Column({ type: 'varchar', length: 16 }) type!: 'PAYOFF' | 'CANCELLED';
    @Column({ name: 'payoff_id', type: 'uuid', nullable: true }) payoffId!:
        string | null;
    @Column({
        name: 'expected_remaining_amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    expectedRemainingAmountInCents!: number;
    @Column({ name: 'fact_date', type: 'date' }) factDate!: string;
    @Column({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
    @Column({ type: 'varchar', length: 500, nullable: true }) reason!:
        string | null;
    @Column({ name: 'economic_shares', type: 'jsonb', nullable: true })
    economicShares!: readonly EconomicShare[] | null;
}

@Entity('financial_installment_command_receipts')
@Check(
    'CHK_installment_command_receipts',
    `status='COMPLETED' AND octet_length(request_hash)=32 AND operation IN ('CREATE_INSTALLMENT_COMMITMENT','RECORD_INSTALLMENT_DISBURSEMENT','RECORD_INSTALLMENT_EXTERNAL_LIABILITY','SETTLE_INSTALLMENT_EXTERNAL_LIABILITY','ANTICIPATE_INSTALLMENTS','PAYOFF_INSTALLMENTS','CANCEL_FUTURE_INSTALLMENTS')`,
)
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_installment_receipts_actor',
    onDelete: 'RESTRICT',
})
@ForeignKey(
    'financial_commitments',
    ['spaceId', 'commitmentId'],
    ['spaceId', 'id'],
    { name: 'FK_installment_receipts_commitment', onDelete: 'RESTRICT' },
)
@ForeignKey(
    () => FinancialInstallmentOrmEntity,
    ['spaceId', 'commitmentId', 'installmentId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_installment_receipts_installment', onDelete: 'RESTRICT' },
)
export class FinancialInstallmentCommandReceiptOrmEntity {
    @PrimaryColumn({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @PrimaryColumn({ type: 'varchar', length: 48 }) operation!: string;
    @PrimaryColumn({ name: 'idempotency_key', type: 'uuid' })
    idempotencyKey!: string;
    @Column({ name: 'request_hash', type: 'bytea' }) requestHash!: Buffer;
    @Column({ type: 'varchar', length: 16 }) status!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column({ name: 'installment_id', type: 'uuid', nullable: true })
    installmentId!: string | null;
    @Column({ type: 'jsonb' }) result!: unknown;
    @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}

export const installmentEntities = [
    FinancialInstallmentPlanOrmEntity,
    FinancialInstallmentOrmEntity,
    FinancialInstallmentShareOrmEntity,
    FinancialInstallmentAnticipationOrmEntity,
    FinancialInstallmentPayoffOrmEntity,
    FinancialInstallmentResolutionOrmEntity,
    FinancialInstallmentCommandReceiptOrmEntity,
];
