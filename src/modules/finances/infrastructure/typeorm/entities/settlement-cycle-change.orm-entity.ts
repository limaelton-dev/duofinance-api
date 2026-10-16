import { Check, Column, Entity, ForeignKey, PrimaryColumn } from 'typeorm';
import { SettlementCycleOrmEntity } from './shared-expense.orm-entity.js';
@Entity('settlement_cycle_changes')
@Check('CHK_cycle_change_finalization', `version > 1 AND type = 'FINALIZED'`)
@ForeignKey(
    () => SettlementCycleOrmEntity,
    ['spaceId', 'cycleId'],
    ['spaceId', 'id'],
    { name: 'FK_cycle_change_cycle', onDelete: 'RESTRICT' },
)
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_cycle_change_actor',
    onDelete: 'RESTRICT',
})
export class SettlementCycleChangeOrmEntity {
    @PrimaryColumn({ name: 'cycle_id', type: 'uuid' }) cycleId!: string;
    @PrimaryColumn('integer') version!: number;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @Column({ type: 'varchar', length: 24 }) type!: string;
    @Column('jsonb') snapshot!: unknown;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
