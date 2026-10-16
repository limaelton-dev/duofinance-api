import {
    Check,
    Column,
    Entity,
    ForeignKey,
    PrimaryColumn,
    Unique,
    Index,
} from 'typeorm';
import {
    safeBigInt,
    InterMemberObligationOrmEntity,
    SettlementCycleOrmEntity,
} from './shared-expense.orm-entity.js';
@Entity('settlement_offsets')
@Unique('UQ_settlement_offsets_space_id', ['spaceId', 'id'])
@Check(
    'CHK_settlement_offset_values',
    `amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date`,
)
@ForeignKey('spaces', ['spaceId'], ['id'], {
    name: 'FK_settlement_offset_space',
    onDelete: 'RESTRICT',
})
@ForeignKey('persons', ['createdByPersonId'], ['id'], {
    name: 'FK_settlement_offset_actor',
    onDelete: 'RESTRICT',
})
export class SettlementOffsetOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
    @Column({ name: 'fact_date', type: 'date' }) factDate!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
    @Column({ name: 'created_by', type: 'uuid' }) createdByPersonId!: string;
}
@Entity('settlement_offset_allocations')
@Unique('UQ_offset_allocation_space_id', ['spaceId', 'id'])
@Unique('UQ_offset_allocation_obligation', ['offsetId', 'obligationId'])
@Index('IDX_offset_allocation_cycle', ['spaceId', 'cycleId'])
@Index('IDX_offset_allocation_obligation', ['spaceId', 'obligationId'])
@Check(
    'CHK_offset_allocation_values',
    `amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND debtor_member_id <> creditor_member_id`,
)
@ForeignKey(
    () => SettlementOffsetOrmEntity,
    ['spaceId', 'offsetId'],
    ['spaceId', 'id'],
    { name: 'FK_offset_allocation_offset', onDelete: 'RESTRICT' },
)
@ForeignKey(
    () => InterMemberObligationOrmEntity,
    ['spaceId', 'obligationId'],
    ['spaceId', 'id'],
    { name: 'FK_offset_allocation_obligation', onDelete: 'RESTRICT' },
)
@ForeignKey(
    () => SettlementCycleOrmEntity,
    ['spaceId', 'cycleId'],
    ['spaceId', 'id'],
    { name: 'FK_offset_allocation_cycle', onDelete: 'RESTRICT' },
)
@ForeignKey('space_members', ['spaceId', 'debtorMemberId'], ['spaceId', 'id'], {
    name: 'FK_offset_allocation_debtor',
    onDelete: 'RESTRICT',
})
@ForeignKey(
    'space_members',
    ['spaceId', 'creditorMemberId'],
    ['spaceId', 'id'],
    { name: 'FK_offset_allocation_creditor', onDelete: 'RESTRICT' },
)
export class SettlementOffsetAllocationOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'offset_id', type: 'uuid' }) offsetId!: string;
    @Column({ name: 'obligation_id', type: 'uuid' }) obligationId!: string;
    @Column({ name: 'cycle_id', type: 'uuid', nullable: true }) cycleId!:
        string | null;
    @Column({ name: 'debtor_member_id', type: 'uuid' }) debtorMemberId!: string;
    @Column({ name: 'creditor_member_id', type: 'uuid' })
    creditorMemberId!: string;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
}
@Entity('settlement_offset_command_receipts')
@Check('CHK_offset_receipt_hash', 'octet_length(request_hash) = 32')
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_offset_receipt_actor',
    onDelete: 'RESTRICT',
})
@ForeignKey(
    () => SettlementOffsetOrmEntity,
    ['spaceId', 'offsetId'],
    ['spaceId', 'id'],
    { name: 'FK_offset_receipt_offset', onDelete: 'RESTRICT' },
)
export class SettlementOffsetCommandReceiptOrmEntity {
    @PrimaryColumn({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @PrimaryColumn({ name: 'idempotency_key', type: 'uuid' })
    idempotencyKey!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'offset_id', type: 'uuid' }) offsetId!: string;
    @Column({ name: 'request_hash', type: 'bytea' }) requestHash!: Buffer;
    @Column('jsonb') result!: unknown;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
@Entity('settlement_offset_audit')
@Unique('UQ_offset_audit_command', ['actorId', 'idempotencyKey'])
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_offset_audit_actor',
    onDelete: 'RESTRICT',
})
@ForeignKey(
    () => SettlementOffsetOrmEntity,
    ['spaceId', 'offsetId'],
    ['spaceId', 'id'],
    { name: 'FK_offset_audit_offset', onDelete: 'RESTRICT' },
)
export class SettlementOffsetAuditOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @Column({ name: 'idempotency_key', type: 'uuid' }) idempotencyKey!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'offset_id', type: 'uuid' }) offsetId!: string;
    @Column({ type: 'varchar', length: 40 }) action!: string;
    @Column('jsonb') payload!: unknown;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
export const settlementOffsetEntities = [
    SettlementOffsetOrmEntity,
    SettlementOffsetAllocationOrmEntity,
    SettlementOffsetCommandReceiptOrmEntity,
    SettlementOffsetAuditOrmEntity,
];
