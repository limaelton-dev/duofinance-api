import {
    Check,
    Column,
    Entity,
    ForeignKey,
    Index,
    PrimaryColumn,
    Unique,
} from 'typeorm';
import { safeBigInt } from './shared-expense.orm-entity.js';

@Entity('settlement_transfers')
@Unique('UQ_settlement_transfers_space_id', ['spaceId', 'id'])
@Index('IDX_settlement_transfers_space_registered', [
    'spaceId',
    'registeredAt',
    'id',
])
@Check(
    'CHK_settlement_transfers_values',
    `payer_member_id <> recipient_member_id AND amount_in_cents BETWEEN 1 AND 9007199254740991 AND mode = 'MANUAL' AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date`,
)
@ForeignKey('space_members', ['spaceId', 'payerMemberId'], ['spaceId', 'id'], {
    name: 'FK_settlement_transfers_payer',
    onDelete: 'RESTRICT',
})
@ForeignKey(
    'space_members',
    ['spaceId', 'recipientMemberId'],
    ['spaceId', 'id'],
    { name: 'FK_settlement_transfers_recipient', onDelete: 'RESTRICT' },
)
export class SettlementTransferOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' })
    @ForeignKey('spaces', 'id', {
        name: 'FK_settlement_transfers_space',
        onDelete: 'RESTRICT',
    })
    spaceId!: string;
    @Column({ name: 'payer_member_id', type: 'uuid' }) payerMemberId!: string;
    @Column({ name: 'recipient_member_id', type: 'uuid' })
    recipientMemberId!: string;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
    @Column({ name: 'fact_date', type: 'date' }) factDate!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
    @Column({ name: 'created_by', type: 'uuid' })
    @ForeignKey('persons', 'id', {
        name: 'FK_settlement_transfers_author',
        onDelete: 'RESTRICT',
    })
    createdBy!: string;
    @Column({ type: 'varchar', length: 16 }) mode!: string;
}
@Entity('settlement_allocations')
@Unique('UQ_settlement_allocations_transfer_obligation', [
    'transferId',
    'obligationId',
])
@Unique('UQ_settlement_allocations_space_id', ['spaceId', 'id'])
@Index('IDX_settlement_allocations_obligation', ['spaceId', 'obligationId'])
@Index('IDX_settlement_allocations_cycle', ['spaceId', 'cycleId', 'transferId'])
@Check(
    'CHK_settlement_allocations_amount',
    `amount_in_cents BETWEEN 1 AND 9007199254740991`,
)
@ForeignKey(
    () => SettlementTransferOrmEntity,
    ['spaceId', 'transferId'],
    ['spaceId', 'id'],
    { name: 'FK_settlement_allocations_transfer', onDelete: 'RESTRICT' },
)
@ForeignKey(
    'inter_member_obligations',
    ['spaceId', 'obligationId'],
    ['spaceId', 'id'],
    { name: 'FK_settlement_allocations_obligation', onDelete: 'RESTRICT' },
)
@ForeignKey('settlement_cycles', ['spaceId', 'cycleId'], ['spaceId', 'id'], {
    name: 'FK_settlement_allocations_cycle',
    onDelete: 'RESTRICT',
})
export class SettlementAllocationOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'transfer_id', type: 'uuid' }) transferId!: string;
    @Column({ name: 'obligation_id', type: 'uuid' }) obligationId!: string;
    @Column({ name: 'cycle_id', type: 'uuid', nullable: true }) cycleId!:
        string | null;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
}
@Entity('financial_settlement_command_receipts')
@Check(
    'CHK_settlement_receipt',
    `operation = 'RECORD_MANUAL_SETTLEMENT_TRANSFER' AND status = 'COMPLETED' AND octet_length(request_hash) = 32`,
)
@ForeignKey(
    () => SettlementTransferOrmEntity,
    ['spaceId', 'transferId'],
    ['spaceId', 'id'],
    { name: 'FK_settlement_receipt_transfer', onDelete: 'RESTRICT' },
)
export class FinancialSettlementCommandReceiptOrmEntity {
    @PrimaryColumn({ name: 'actor_id', type: 'uuid' })
    @ForeignKey('persons', 'id', {
        name: 'FK_settlement_receipt_actor',
        onDelete: 'RESTRICT',
    })
    actorId!: string;
    @PrimaryColumn({ type: 'varchar', length: 48 }) operation!: string;
    @PrimaryColumn({ name: 'idempotency_key', type: 'uuid' })
    idempotencyKey!: string;
    @Column({ name: 'request_hash', type: 'bytea' }) requestHash!: Buffer;
    @Column({ type: 'varchar', length: 16 }) status!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'transfer_id', type: 'uuid' }) transferId!: string;
    @Column({ type: 'jsonb' }) result!: unknown;
    @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}
@Entity('financial_settlement_audit')
@Unique('UQ_settlement_audit_transfer', ['transferId'])
@Check(
    'CHK_settlement_audit_action',
    `action = 'RECORD_MANUAL_SETTLEMENT_TRANSFER'`,
)
@ForeignKey(
    () => SettlementTransferOrmEntity,
    ['spaceId', 'transferId'],
    ['spaceId', 'id'],
    { name: 'FK_settlement_audit_transfer', onDelete: 'RESTRICT' },
)
export class FinancialSettlementAuditOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'transfer_id', type: 'uuid' }) transferId!: string;
    @Column({ name: 'actor_id', type: 'uuid' })
    @ForeignKey('persons', 'id', {
        name: 'FK_settlement_audit_actor',
        onDelete: 'RESTRICT',
    })
    actorId!: string;
    @Column({ type: 'varchar', length: 48 }) action!: string;
    @Column({ type: 'jsonb' }) payload!: unknown;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
