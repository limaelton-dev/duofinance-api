import {
    Check,
    Column,
    Entity,
    ForeignKey,
    Index,
    PrimaryColumn,
    Unique,
} from 'typeorm';
import type {
    EconomicShare,
    SplitInput,
} from '../../../domain/shared-expense/responsibility-split.js';
import {
    FinancialCommitmentOrmEntity,
    safeBigInt,
} from './shared-expense.orm-entity.js';

@Entity('financial_non_recurring_versions')
@Unique('UQ_non_recurring_version_target', [
    'spaceId',
    'commitmentId',
    'version',
    'targetId',
])
@Unique('UQ_non_recurring_version_effective', [
    'spaceId',
    'commitmentId',
    'targetId',
    'effectiveFrom',
])
@Index('IDX_non_recurring_version_selection', [
    'spaceId',
    'commitmentId',
    'targetId',
    'effectiveFrom',
])
@Check(
    'CHK_non_recurring_version_values',
    `version > 1 AND amount_in_cents BETWEEN 1 AND 9007199254740991 AND length(description) BETWEEN 1 AND 160 AND description=btrim(description) AND ((installment_id IS NULL AND target_id=commitment_id) OR (installment_id IS NOT NULL AND installment_id=target_id)) AND ((distribution IS NULL AND economic_shares IS NULL AND expected_member_id IS NULL) OR (distribution IS NOT NULL AND economic_shares IS NOT NULL))`,
)
@ForeignKey(
    () => FinancialCommitmentOrmEntity,
    ['spaceId', 'commitmentId'],
    ['spaceId', 'id'],
    { name: 'FK_non_recurring_version_commitment', onDelete: 'RESTRICT' },
)
@ForeignKey(
    'financial_installments',
    ['spaceId', 'commitmentId', 'installmentId'],
    ['spaceId', 'commitmentId', 'id'],
    { name: 'FK_non_recurring_version_installment', onDelete: 'RESTRICT' },
)
@ForeignKey(
    'space_members',
    ['spaceId', 'expectedMemberId'],
    ['spaceId', 'id'],
    { name: 'FK_non_recurring_version_expected_member', onDelete: 'RESTRICT' },
)
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_non_recurring_version_actor',
    onDelete: 'RESTRICT',
})
export class FinancialNonRecurringVersionOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'commitment_id', type: 'uuid' }) commitmentId!: string;
    @Column({ name: 'target_id', type: 'uuid' }) targetId!: string;
    @Column({ name: 'installment_id', type: 'uuid', nullable: true })
    installmentId!: string | null;
    @Column('integer') version!: number;
    @Column({ name: 'effective_from', type: 'date' }) effectiveFrom!: string;
    @Column({ type: 'varchar', length: 160 }) description!: string;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
    @Column({ type: 'jsonb', nullable: true }) distribution!: SplitInput | null;
    @Column({ name: 'economic_shares', type: 'jsonb', nullable: true })
    economicShares!: readonly EconomicShare[] | null;
    @Column({ name: 'expected_member_id', type: 'uuid', nullable: true })
    expectedMemberId!: string | null;
    @Column({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
