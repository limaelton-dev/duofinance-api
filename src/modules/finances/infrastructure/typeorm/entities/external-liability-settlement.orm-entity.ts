import {
    Entity,
    PrimaryColumn,
    Column,
    Check,
    ForeignKey,
    Unique,
} from 'typeorm';
import {
    safeBigInt,
    FinancialExternalLiabilityOrmEntity,
    FinancialExpenseCommandReceiptOrmEntity,
} from './shared-expense.orm-entity.js';
@Entity('financial_external_liability_settlements')
@Unique('UQ_external_settlement_sequence', ['commitmentId', 'sequence'])
@Unique('UQ_external_settlement_origin', ['spaceId', 'commitmentId', 'id'])
@Check(
    'CHK_external_settlement_values',
    "amount_in_cents BETWEEN 1 AND 9007199254740991 AND sequence > 1 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND num_nonnulls(holder_member_id,holder_person_id)=1 AND ((receipt_operation='SETTLE_EXTERNAL_LIABILITY' AND idempotency_key IS NOT NULL) OR (receipt_operation IS NULL AND idempotency_key IS NULL))",
)
@ForeignKey(
    () => FinancialExternalLiabilityOrmEntity,
    ['spaceId', 'commitmentId', 'externalLiabilityId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_external_settlement_origin', onDelete: 'RESTRICT' },
)
@ForeignKey(
    () => FinancialExpenseCommandReceiptOrmEntity,
    ['recordedByPersonId', 'receiptOperation', 'idempotencyKey'],
    ['actorId', 'operation', 'idempotencyKey'],
    {
        name: 'FK_external_settlement_receipt',
        deferrable: 'INITIALLY DEFERRED',
    },
)
@ForeignKey('space_members', ['spaceId', 'holderMemberId'], ['spaceId', 'id'], {
    name: 'FK_external_settlement_holder',
    onDelete: 'RESTRICT',
})
export class FinancialExternalLiabilitySettlementOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column({ name: 'external_liability_id', type: 'uuid' })
    externalLiabilityId!: string;
    @Column('integer') sequence!: number;
    @Column({ name: 'holder_member_id', type: 'uuid', nullable: true })
    holderMemberId!: string | null;
    @Column({ name: 'holder_person_id', type: 'uuid', nullable: true })
    @ForeignKey('persons', 'id', {
        name: 'FK_external_settlement_person',
        onDelete: 'RESTRICT',
    })
    holderPersonId!: string | null;
    @Column({ name: 'recorded_by_person_id', type: 'uuid' })
    recordedByPersonId!: string;
    @Column({
        name: 'receipt_operation',
        type: 'varchar',
        length: 40,
        nullable: true,
    })
    receiptOperation!: string | null;
    @Column({ name: 'idempotency_key', type: 'uuid', nullable: true })
    idempotencyKey!: string | null;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
    @Column({ name: 'fact_date', type: 'date' }) factDate!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
