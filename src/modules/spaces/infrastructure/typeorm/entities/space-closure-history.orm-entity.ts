import {
    Check,
    Column,
    Entity,
    ForeignKey,
    Index,
    PrimaryColumn,
} from 'typeorm';
import type { SpaceClosureView } from '../../../application/ports/public/space-closure.port.js';

@Entity({ name: 'space_closure_history' })
@ForeignKey(
    'space_closure_processes',
    ['processId', 'spaceId'],
    ['id', 'spaceId'],
    { name: 'FK_space_closure_history_process', onDelete: 'RESTRICT' },
)
@ForeignKey('space_members', ['actorMemberId', 'spaceId'], ['id', 'spaceId'], {
    name: 'FK_space_closure_history_actor',
    onDelete: 'RESTRICT',
})
@Check('CHK_space_closure_history_revision', `"plan_revision" >= 1`)
@Check(
    'CHK_space_closure_history_snapshot',
    `jsonb_typeof("snapshot") = 'object'`,
)
@Index('IDX_space_closure_history_page', ['spaceId', 'recordedAt', 'id'])
export class SpaceClosureHistoryOrmEntity {
    @PrimaryColumn({ type: 'uuid' })
    id!: string;

    @Column({ name: 'space_id', type: 'uuid' })
    spaceId!: string;

    @Column({ name: 'process_id', type: 'uuid' })
    processId!: string;

    @Column({ type: 'varchar', length: 48 })
    action!: string;

    @Column({ name: 'actor_member_id', type: 'uuid' })
    actorMemberId!: string;

    @Column({ name: 'plan_revision', type: 'integer' })
    planRevision!: number;

    @Column({ name: 'recorded_at', type: 'timestamptz' })
    recordedAt!: Date;

    @Column({ type: 'jsonb' })
    snapshot!: SpaceClosureView;
}
