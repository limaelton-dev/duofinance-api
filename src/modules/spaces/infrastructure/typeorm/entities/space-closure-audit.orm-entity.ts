import {
    Check,
    Column,
    Entity,
    ForeignKey,
    Index,
    PrimaryColumn,
} from 'typeorm';

@Entity({ name: 'space_closure_audit' })
@ForeignKey(
    'space_closure_processes',
    ['processId', 'spaceId'],
    ['id', 'spaceId'],
    { name: 'FK_space_closure_audit_process', onDelete: 'RESTRICT' },
)
@Check('CHK_space_closure_audit_revision', `"plan_revision" >= 1`)
@Index('IDX_space_closure_audit_process', ['processId', 'recordedAt', 'id'])
export class SpaceClosureAuditOrmEntity {
    @PrimaryColumn({ type: 'uuid' })
    id!: string;

    @Column({ name: 'space_id', type: 'uuid' })
    spaceId!: string;

    @Column({ name: 'process_id', type: 'uuid' })
    processId!: string;

    @Column({ name: 'actor_id', type: 'uuid' })
    @ForeignKey('persons', 'id', {
        name: 'FK_space_closure_audit_actor',
        onDelete: 'RESTRICT',
    })
    actorId!: string;

    @Column({ type: 'varchar', length: 48 })
    action!: string;

    @Column({ name: 'idempotency_key', type: 'uuid' })
    idempotencyKey!: string;

    @Column({ name: 'plan_revision', type: 'integer' })
    planRevision!: number;

    @Column({ name: 'recorded_at', type: 'timestamptz' })
    recordedAt!: Date;
}
