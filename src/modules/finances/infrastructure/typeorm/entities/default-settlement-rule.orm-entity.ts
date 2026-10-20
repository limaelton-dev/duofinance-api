import { Check, Entity, Column, ForeignKey, PrimaryColumn } from 'typeorm';
@Entity('default_settlement_rules')
@Check('default_settlement_rules_kind_check', "kind = 'MONTHLY_DAY'")
@Check(
    'default_settlement_rules_day_of_month_check',
    'day_of_month BETWEEN 1 AND 31',
)
@Check('default_settlement_rules_version_check', 'version > 0')
@ForeignKey('spaces', ['spaceId'], ['id'], {
    name: 'default_settlement_rules_space_id_fkey',
    onDelete: 'RESTRICT',
})
export class DefaultSettlementRuleOrmEntity {
    @PrimaryColumn('uuid', {
        name: 'space_id',
        primaryKeyConstraintName: 'PK_default_settlement_rules',
    })
    spaceId!: string;
    @Column('varchar') kind!: string;
    @Column('smallint', { name: 'day_of_month' }) dayOfMonth!: number;
    @Column('integer') version!: number;
    @Column('timestamptz', { name: 'created_at' }) createdAt!: Date;
    @Column('timestamptz', { name: 'updated_at' }) updatedAt!: Date;
}
