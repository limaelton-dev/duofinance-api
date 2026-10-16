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
} from './shared-expense.orm-entity.js';
@Entity('obligation_waivers')
@Unique('UQ_obligation_waiver_space_id', ['spaceId', 'id'])
@Index('IDX_obligation_waiver_origin', [
    'spaceId',
    'obligationId',
    'registeredAt',
    'id',
])
@Check(
    'CHK_obligation_waiver_values',
    `amount_in_cents > 0 AND amount_in_cents <= 9007199254740991 AND fact_date <= (registered_at AT TIME ZONE 'America/Sao_Paulo')::date AND (reason IS NULL OR (length(reason) BETWEEN 1 AND 500 AND reason = btrim(reason)))`,
)
@ForeignKey(
    () => InterMemberObligationOrmEntity,
    ['spaceId', 'obligationId'],
    ['spaceId', 'id'],
    { name: 'FK_obligation_waiver_origin', onDelete: 'RESTRICT' },
)
@ForeignKey(
    'space_members',
    ['spaceId', 'creditorMemberId'],
    ['spaceId', 'id'],
    { name: 'FK_obligation_waiver_creditor', onDelete: 'RESTRICT' },
)
@ForeignKey('persons', ['createdByPersonId'], ['id'], {
    name: 'FK_obligation_waiver_actor',
    onDelete: 'RESTRICT',
})
export class ObligationWaiverOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'obligation_id', type: 'uuid' }) obligationId!: string;
    @Column({ name: 'creditor_member_id', type: 'uuid' })
    creditorMemberId!: string;
    @Column({
        name: 'amount_in_cents',
        type: 'bigint',
        transformer: safeBigInt,
    })
    amountInCents!: number;
    @Column({ name: 'fact_date', type: 'date' }) factDate!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
    @Column({ name: 'created_by', type: 'uuid' }) createdByPersonId!: string;
    @Column({ type: 'varchar', length: 500, nullable: true }) reason!:
        string | null;
}
