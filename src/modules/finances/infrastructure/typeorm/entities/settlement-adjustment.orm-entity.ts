import {
    Check,
    Column,
    Entity,
    ForeignKey,
    PrimaryColumn,
    Unique,
} from 'typeorm';
import type { SettlementRuleSnapshot } from '../../../domain/settlement-rule/settlement-rule.js';
import { FinancialCommitmentOrmEntity } from './shared-expense.orm-entity.js';

@Entity('financial_commitment_settlement_rules')
@Unique('UQ_commitment_settlement_rule_space', ['spaceId', 'commitmentId'])
@Check(
    'CHK_commitment_settlement_rule_version',
    `version > 0 AND COALESCE(jsonb_typeof(rule) = 'object' AND rule->>'kind' = 'MONTHLY_DAY' AND jsonb_typeof(rule->'dayOfMonth') = 'number' AND (rule->>'dayOfMonth')::numeric BETWEEN 1 AND 31 AND (rule->>'dayOfMonth')::numeric = trunc((rule->>'dayOfMonth')::numeric),false)`,
)
@ForeignKey(
    () => FinancialCommitmentOrmEntity,
    ['spaceId', 'commitmentId'],
    ['spaceId', 'id'],
    { name: 'FK_commitment_settlement_rule_origin', onDelete: 'RESTRICT' },
)
export class FinancialCommitmentSettlementRuleOrmEntity {
    @PrimaryColumn({ name: 'commitment_id', type: 'uuid' })
    commitmentId!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column('integer') version!: number;
    @Column('jsonb') rule!: SettlementRuleSnapshot;
}
@Entity('financial_commitment_settlement_rule_changes')
@Check(
    'CHK_commitment_rule_change_version',
    'version > 0 AND commitment_version > 1',
)
@ForeignKey(
    () => FinancialCommitmentSettlementRuleOrmEntity,
    ['spaceId', 'commitmentId'],
    ['spaceId', 'commitmentId'],
    { name: 'FK_commitment_rule_change_rule', onDelete: 'RESTRICT' },
)
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_commitment_rule_change_actor',
    onDelete: 'RESTRICT',
})
export class FinancialCommitmentSettlementRuleChangeOrmEntity {
    @PrimaryColumn({ name: 'commitment_id', type: 'uuid' })
    commitmentId!: string;
    @PrimaryColumn('integer') version!: number;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_version', type: 'integer' })
    commitmentVersion!: number;
    @Column({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @Column({ name: 'previous_rule', type: 'jsonb', nullable: true })
    previousRule!: SettlementRuleSnapshot | null;
    @Column('jsonb') rule!: SettlementRuleSnapshot;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
@Entity('financial_settlement_adjustment_receipts')
@Check(
    'CHK_settlement_adjustment_receipt',
    `operation IN ('CONFIGURE_COMMITMENT_SETTLEMENT_RULE','MOVE_OBLIGATION','FINALIZE_SETTLEMENT_CYCLE') AND octet_length(request_hash) = 32`,
)
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_settlement_adjustment_receipt_actor',
    onDelete: 'RESTRICT',
})
@ForeignKey('spaces', ['spaceId'], ['id'], {
    name: 'FK_settlement_adjustment_receipt_space',
    onDelete: 'RESTRICT',
})
export class FinancialSettlementAdjustmentReceiptOrmEntity {
    @PrimaryColumn({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @PrimaryColumn({ type: 'varchar', length: 48 }) operation!: string;
    @PrimaryColumn({ name: 'idempotency_key', type: 'uuid' })
    idempotencyKey!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'request_hash', type: 'bytea' }) requestHash!: Buffer;
    @Column('jsonb') result!: unknown;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
@Entity('financial_settlement_adjustment_audit')
@Unique('UQ_settlement_adjustment_audit_command', [
    'actorId',
    'action',
    'idempotencyKey',
])
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_settlement_adjustment_audit_actor',
    onDelete: 'RESTRICT',
})
@ForeignKey('spaces', ['spaceId'], ['id'], {
    name: 'FK_settlement_adjustment_audit_space',
    onDelete: 'RESTRICT',
})
export class FinancialSettlementAdjustmentAuditOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @Column({ name: 'idempotency_key', type: 'uuid' }) idempotencyKey!: string;
    @Column({ type: 'varchar', length: 48 }) action!: string;
    @Column({ name: 'target_id', type: 'uuid' }) targetId!: string;
    @Column('jsonb') payload!: unknown;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
export const settlementAdjustmentEntities = [
    FinancialCommitmentSettlementRuleOrmEntity,
    FinancialCommitmentSettlementRuleChangeOrmEntity,
    FinancialSettlementAdjustmentReceiptOrmEntity,
    FinancialSettlementAdjustmentAuditOrmEntity,
];
