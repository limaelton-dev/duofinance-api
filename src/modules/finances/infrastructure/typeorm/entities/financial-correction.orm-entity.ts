import {
    Check,
    Column,
    Entity,
    ForeignKey,
    Index,
    PrimaryColumn,
    Unique,
} from 'typeorm';
import type { EconomicShare } from '../../../domain/shared-expense/responsibility-split.js';
import {
    FinancialCommitmentOrmEntity,
    safeBigInt,
} from './shared-expense.orm-entity.js';

@Entity('financial_commitment_adjustments')
@Unique('UQ_commitment_adjustment_version', [
    'spaceId',
    'commitmentId',
    'commitmentVersion',
])
@Index('IDX_commitment_adjustment_target', [
    'spaceId',
    'commitmentId',
    'targetId',
])
@Check(
    'CHK_commitment_adjustment_values',
    `commitment_version>1 AND direction IN ('INCREASE','DECREASE') AND amount_in_cents BETWEEN 1 AND 9007199254740991 AND previous_amount_in_cents BETWEEN 0 AND 9007199254740991 AND resulting_amount_in_cents BETWEEN 0 AND 9007199254740991 AND resulting_amount_in_cents=previous_amount_in_cents+CASE WHEN direction='INCREASE' THEN amount_in_cents ELSE -amount_in_cents END AND length(reason) BETWEEN 1 AND 500 AND reason=btrim(reason) AND fact_date<=(registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND ((occurrence_id IS NULL AND installment_id IS NULL AND target_id=commitment_id) OR (occurrence_id IS NOT NULL AND target_id=occurrence_id AND (installment_id IS NULL OR installment_id=occurrence_id)))`,
)
@ForeignKey(
    () => FinancialCommitmentOrmEntity,
    ['spaceId', 'commitmentId'],
    ['spaceId', 'id'],
    { name: 'FK_commitment_adjustment_root', onDelete: 'RESTRICT' },
)
@ForeignKey(
    'financial_occurrences',
    ['spaceId', 'commitmentId', 'occurrenceId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_commitment_adjustment_occurrence', onDelete: 'RESTRICT' },
)
@ForeignKey(
    'financial_installments',
    ['spaceId', 'commitmentId', 'installmentId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_commitment_adjustment_installment', onDelete: 'RESTRICT' },
)
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_commitment_adjustment_actor',
    onDelete: 'RESTRICT',
})
@ForeignKey(
    'financial_commitment_change_proposals',
    ['spaceId', 'commitmentId', 'proposalId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_commitment_adjustment_proposal', onDelete: 'RESTRICT' },
)
export class FinancialCommitmentAdjustmentOrmEntity {
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
    @Column({ type: 'varchar', length: 8 }) direction!: 'INCREASE' | 'DECREASE';
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
    @Column({
        name: 'previous_amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    previousAmountInCents!: number;
    @Column({
        name: 'resulting_amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    resultingAmountInCents!: number;
    @Column({ name: 'economic_shares', type: 'jsonb', nullable: true })
    economicShares!: readonly EconomicShare[] | null;
    @Column({ name: 'share_changes', type: 'jsonb', nullable: true })
    shareChanges!:
        readonly { memberId: string; amountInCents: number }[] | null;
    @Column({ name: 'proposal_id', type: 'uuid', nullable: true }) proposalId!:
        string | null;
}

@Entity('financial_commitment_cancellations')
@Unique('UQ_commitment_cancellation_root', ['spaceId', 'commitmentId'])
@Check(
    'CHK_commitment_cancellation_values',
    `commitment_version>1 AND length(reason) BETWEEN 1 AND 500 AND reason=btrim(reason) AND fact_date<=(registered_at AT TIME ZONE 'America/Sao_Paulo')::date`,
)
@ForeignKey(
    () => FinancialCommitmentOrmEntity,
    ['spaceId', 'commitmentId'],
    ['spaceId', 'id'],
    { name: 'FK_commitment_cancellation_root', onDelete: 'RESTRICT' },
)
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_commitment_cancellation_actor',
    onDelete: 'RESTRICT',
})
export class FinancialCommitmentCancellationOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column({ name: 'commitment_version', type: 'integer' })
    commitmentVersion!: number;
    @Column({ type: 'varchar', length: 500 }) reason!: string;
    @Column({ name: 'fact_date', type: 'date' }) factDate!: string;
    @Column({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
