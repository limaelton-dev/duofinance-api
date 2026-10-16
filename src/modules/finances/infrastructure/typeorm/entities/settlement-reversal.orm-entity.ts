import {
    Check,
    Column,
    Entity,
    ForeignKey,
    Index,
    PrimaryColumn,
    Unique,
} from 'typeorm';
import {
    safeBigInt,
    InterMemberObligationOrmEntity,
    SettlementCycleOrmEntity,
} from './shared-expense.orm-entity.js';
import {
    SettlementTransferOrmEntity,
    SettlementAllocationOrmEntity,
} from './settlement-transfer.orm-entity.js';
import {
    SettlementOffsetOrmEntity,
    SettlementOffsetAllocationOrmEntity,
} from './settlement-offset.orm-entity.js';
@Entity('settlement_reversals')
@Unique('UQ_settlement_reversal_space_id', ['spaceId', 'id'])
@Unique('UQ_settlement_reversal_transfer', ['originalTransferId'])
@Unique('UQ_settlement_reversal_offset', ['originalOffsetId'])
@Check(
    'CHK_settlement_reversal_values',
    `amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((original_kind = 'TRANSFER' AND original_transfer_id IS NOT NULL AND original_offset_id IS NULL) OR (original_kind = 'OFFSET' AND original_offset_id IS NOT NULL AND original_transfer_id IS NULL))`,
)
@ForeignKey(
    () => SettlementTransferOrmEntity,
    ['spaceId', 'originalTransferId'],
    ['spaceId', 'id'],
    { name: 'FK_reversal_original_transfer', onDelete: 'RESTRICT' },
)
@ForeignKey(
    () => SettlementOffsetOrmEntity,
    ['spaceId', 'originalOffsetId'],
    ['spaceId', 'id'],
    { name: 'FK_reversal_original_offset', onDelete: 'RESTRICT' },
)
@ForeignKey('persons', ['createdByPersonId'], ['id'], {
    name: 'FK_reversal_actor',
    onDelete: 'RESTRICT',
})
export class SettlementReversalOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'original_kind', type: 'varchar', length: 8 })
    originalKind!: string;
    @Column({ name: 'original_transfer_id', type: 'uuid', nullable: true })
    originalTransferId!: string | null;
    @Column({ name: 'original_offset_id', type: 'uuid', nullable: true })
    originalOffsetId!: string | null;
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
@Entity('settlement_reversal_applications')
@Unique('UQ_reversal_application_transfer', ['originalTransferAllocationId'])
@Unique('UQ_reversal_application_offset', ['originalOffsetAllocationId'])
@Index('IDX_reversal_application_origin', ['spaceId', 'originalObligationId'])
@Index('IDX_reversal_application_source_cycle', ['spaceId', 'sourceCycleId'])
@Check(
    'CHK_reversal_application_values',
    `amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND debtor_member_id <> creditor_member_id AND num_nonnulls(original_transfer_allocation_id,original_offset_allocation_id) = 1`,
)
@ForeignKey(
    () => SettlementReversalOrmEntity,
    ['spaceId', 'reversalId'],
    ['spaceId', 'id'],
    { name: 'FK_reversal_application_reversal', onDelete: 'RESTRICT' },
)
@ForeignKey(
    () => SettlementAllocationOrmEntity,
    ['spaceId', 'originalTransferAllocationId'],
    ['spaceId', 'id'],
    { name: 'FK_reversal_application_transfer', onDelete: 'RESTRICT' },
)
@ForeignKey(
    () => SettlementOffsetAllocationOrmEntity,
    ['spaceId', 'originalOffsetAllocationId'],
    ['spaceId', 'id'],
    { name: 'FK_reversal_application_offset', onDelete: 'RESTRICT' },
)
@ForeignKey(
    () => InterMemberObligationOrmEntity,
    ['spaceId', 'originalObligationId'],
    ['spaceId', 'id'],
    {
        name: 'FK_reversal_application_original_obligation',
        onDelete: 'RESTRICT',
    },
)
@ForeignKey(
    () => InterMemberObligationOrmEntity,
    ['spaceId', 'effectObligationId'],
    ['spaceId', 'id'],
    { name: 'FK_reversal_application_effect_obligation', onDelete: 'RESTRICT' },
)
@ForeignKey(
    () => SettlementCycleOrmEntity,
    ['spaceId', 'sourceCycleId'],
    ['spaceId', 'id'],
    { name: 'FK_reversal_application_source_cycle', onDelete: 'RESTRICT' },
)
@ForeignKey(
    () => SettlementCycleOrmEntity,
    ['spaceId', 'correctionCycleId'],
    ['spaceId', 'id'],
    { name: 'FK_reversal_application_correction_cycle', onDelete: 'RESTRICT' },
)
@ForeignKey('space_members', ['spaceId', 'debtorMemberId'], ['spaceId', 'id'], {
    name: 'FK_reversal_application_debtor',
    onDelete: 'RESTRICT',
})
@ForeignKey(
    'space_members',
    ['spaceId', 'creditorMemberId'],
    ['spaceId', 'id'],
    { name: 'FK_reversal_application_creditor', onDelete: 'RESTRICT' },
)
export class SettlementReversalApplicationOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'reversal_id', type: 'uuid' }) reversalId!: string;
    @Column({
        name: 'original_transfer_allocation_id',
        type: 'uuid',
        nullable: true,
    })
    originalTransferAllocationId!: string | null;
    @Column({
        name: 'original_offset_allocation_id',
        type: 'uuid',
        nullable: true,
    })
    originalOffsetAllocationId!: string | null;
    @Column({ name: 'original_obligation_id', type: 'uuid' })
    originalObligationId!: string;
    @Column({ name: 'effect_obligation_id', type: 'uuid', nullable: true })
    effectObligationId!: string | null;
    @Column({ name: 'source_cycle_id', type: 'uuid', nullable: true })
    sourceCycleId!: string | null;
    @Column({ name: 'correction_cycle_id', type: 'uuid', nullable: true })
    correctionCycleId!: string | null;
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
export const settlementReversalEntities = [
    SettlementReversalOrmEntity,
    SettlementReversalApplicationOrmEntity,
];
