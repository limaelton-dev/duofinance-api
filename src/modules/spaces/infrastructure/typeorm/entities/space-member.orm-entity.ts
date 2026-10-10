import {
    Check,
    Column,
    Entity,
    ForeignKey,
    Index,
    PrimaryColumn,
    Unique,
} from 'typeorm';

@Entity({ name: 'space_members' })
@Unique('UQ_space_members_space_id', ['spaceId', 'id'])
@Check('CHK_space_members_status', `"status" = 'ACTIVE'`)
@Check('CHK_space_members_slot', `"slot" IN (1, 2)`)
@Index('UQ_space_members_active_person', ['spaceId', 'personId'], {
    unique: true,
    where: `"status" = 'ACTIVE'`,
})
@Index('UQ_space_members_active_slot', ['spaceId', 'slot'], {
    unique: true,
    where: `"status" = 'ACTIVE'`,
})
export class SpaceMemberOrmEntity {
    @PrimaryColumn({ type: 'uuid' })
    id!: string;

    @Column({ name: 'space_id', type: 'uuid' })
    @ForeignKey('spaces', 'id', {
        name: 'FK_space_members_space',
        onDelete: 'RESTRICT',
    })
    spaceId!: string;

    @Column({ name: 'person_id', type: 'uuid' })
    @ForeignKey('persons', 'id', {
        name: 'FK_space_members_person',
        onDelete: 'RESTRICT',
    })
    personId!: string;

    @Column({ type: 'varchar', length: 16 })
    status!: string;

    @Column({ type: 'smallint' })
    slot!: number;

    @Column({ name: 'joined_at', type: 'timestamptz' })
    joinedAt!: Date;
}
