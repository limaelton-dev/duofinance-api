import { Check, Entity, Column, ForeignKey, PrimaryColumn } from 'typeorm';
@Entity('default_settlement_rule_changes')
@Check('default_settlement_rule_changes_version_check', 'version > 0')
@Check('default_settlement_rule_changes_kind_check', "kind = 'MONTHLY_DAY'")
@Check(
    'default_settlement_rule_changes_day_of_month_check',
    'day_of_month BETWEEN 1 AND 31',
)
@Check(
    'default_settlement_rule_changes_check',
    "(previous_kind IS NULL AND previous_day_of_month IS NULL) OR (previous_kind IS NOT NULL AND previous_day_of_month IS NOT NULL AND previous_kind = 'MONTHLY_DAY' AND previous_day_of_month BETWEEN 1 AND 31)",
)
@Check(
    'default_settlement_rule_changes_check1',
    '(version = 1 AND previous_kind IS NULL) OR (version > 1 AND previous_kind IS NOT NULL)',
)
@ForeignKey('default_settlement_rules', ['spaceId'], ['spaceId'], {
    name: 'default_settlement_rule_changes_space_id_fkey',
    onDelete: 'RESTRICT',
})
@ForeignKey('persons', ['actorPersonId'], ['id'], {
    name: 'default_settlement_rule_changes_actor_person_id_fkey',
    onDelete: 'RESTRICT',
})
export class DefaultSettlementRuleChangeOrmEntity {
    @PrimaryColumn('uuid', {
        name: 'space_id',
        primaryKeyConstraintName: 'PK_default_settlement_rule_changes',
    })
    spaceId!: string;
    @PrimaryColumn('integer', {
        primaryKeyConstraintName: 'PK_default_settlement_rule_changes',
    })
    version!: number;
    @Column('uuid', { name: 'actor_person_id' }) actorPersonId!: string;
    @Column('varchar', { name: 'previous_kind', nullable: true })
    previousKind!: string | null;
    @Column('smallint', { name: 'previous_day_of_month', nullable: true })
    previousDayOfMonth!: number | null;
    @Column('varchar') kind!: string;
    @Column('smallint', { name: 'day_of_month' }) dayOfMonth!: number;
    @Column('timestamptz', { name: 'occurred_at' }) occurredAt!: Date;
}
