import {
    Check,
    Column,
    Entity,
    ForeignKey,
    Index,
    PrimaryColumn,
    Unique,
} from 'typeorm';
import type { ReversibleFinancialFactKind } from '../../../domain/reversals/financial-fulfillment-reversal.js';
import {
    FinancialCommitmentOrmEntity,
    safeBigInt,
} from './shared-expense.orm-entity.js';

@Entity('financial_fulfillment_reversals')
@Unique('UQ_fulfillment_reversal_version', [
    'spaceId',
    'commitmentId',
    'commitmentVersion',
])
@Index('IDX_fulfillment_reversal_original', [
    'spaceId',
    'commitmentId',
    'originalId',
])
@Index('IDX_fulfillment_reversal_target', [
    'spaceId',
    'commitmentId',
    'targetId',
])
@Check(
    'CHK_fulfillment_reversal_values',
    `commitment_version>1 AND amount_in_cents BETWEEN 1 AND 9007199254740991 AND length(reason) BETWEEN 1 AND 500 AND reason=btrim(reason) AND fact_date<=(registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND num_nonnulls(disbursement_id,external_liability_id,external_settlement_id,receipt_id)=1 AND original_id=COALESCE(disbursement_id,external_liability_id,external_settlement_id,receipt_id) AND ((original_kind='DISBURSEMENT' AND disbursement_id IS NOT NULL) OR (original_kind='EXTERNAL_LIABILITY' AND external_liability_id IS NOT NULL) OR (original_kind='EXTERNAL_SETTLEMENT' AND external_settlement_id IS NOT NULL) OR (original_kind='RECEIPT' AND receipt_id IS NOT NULL)) AND ((occurrence_id IS NULL AND installment_id IS NULL AND target_id=commitment_id) OR (occurrence_id IS NOT NULL AND target_id=occurrence_id AND (installment_id IS NULL OR installment_id=occurrence_id)))`,
)
@ForeignKey(
    () => FinancialCommitmentOrmEntity,
    ['spaceId', 'commitmentId'],
    ['spaceId', 'id'],
    { name: 'FK_fulfillment_reversal_root', onDelete: 'RESTRICT' },
)
@ForeignKey(
    'financial_occurrences',
    ['spaceId', 'commitmentId', 'occurrenceId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_fulfillment_reversal_occurrence', onDelete: 'RESTRICT' },
)
@ForeignKey(
    'financial_installments',
    ['spaceId', 'commitmentId', 'installmentId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_fulfillment_reversal_installment', onDelete: 'RESTRICT' },
)
@ForeignKey(
    'financial_disbursements',
    ['spaceId', 'commitmentId', 'disbursementId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_fulfillment_reversal_disbursement', onDelete: 'RESTRICT' },
)
@ForeignKey(
    'financial_external_liabilities',
    ['spaceId', 'commitmentId', 'externalLiabilityId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_fulfillment_reversal_external', onDelete: 'RESTRICT' },
)
@ForeignKey(
    'financial_external_liability_settlements',
    ['spaceId', 'commitmentId', 'externalSettlementId'],
    ['spaceId', 'commitmentId', 'id'],
    {
        name: 'FK_fulfillment_reversal_external_settlement',
        onDelete: 'RESTRICT',
    },
)
@ForeignKey(
    'financial_receipts',
    ['spaceId', 'commitmentId', 'receiptId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_fulfillment_reversal_receipt', onDelete: 'RESTRICT' },
)
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_fulfillment_reversal_actor',
    onDelete: 'RESTRICT',
})
export class FinancialFulfillmentReversalOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column({ name: 'target_id', type: 'uuid' }) targetId!: string;
    @Column({ name: 'occurrence_id', type: 'uuid', nullable: true })
    occurrenceId!: string | null;
    @Column({ name: 'installment_id', type: 'uuid', nullable: true })
    installmentId!: string | null;
    @Column({ name: 'commitment_version', type: 'integer' })
    commitmentVersion!: number;
    @Column({ name: 'original_kind', type: 'varchar', length: 24 })
    originalKind!: ReversibleFinancialFactKind;
    @Column({ name: 'original_id', type: 'uuid' }) originalId!: string;
    @Column({ name: 'disbursement_id', type: 'uuid', nullable: true })
    disbursementId!: string | null;
    @Column({ name: 'external_liability_id', type: 'uuid', nullable: true })
    externalLiabilityId!: string | null;
    @Column({ name: 'external_settlement_id', type: 'uuid', nullable: true })
    externalSettlementId!: string | null;
    @Column({ name: 'receipt_id', type: 'uuid', nullable: true }) receiptId!:
        string | null;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
    @Column({ type: 'varchar', length: 500 }) reason!: string;
    @Column({ name: 'fact_date', type: 'date' }) factDate!: string;
    @Column({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
