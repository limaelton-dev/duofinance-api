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
    ClosureConsent,
    ClosureParticipant,
} from '../../../domain/space/closure-plan.js';

@Entity({ name: 'space_closure_processes' })
@Unique('UQ_space_closure_processes_id_space', ['id', 'spaceId'])
@ForeignKey(
    'space_members',
    ['requestedByMemberId', 'spaceId'],
    ['id', 'spaceId'],
    {
        name: 'FK_space_closure_processes_requester',
        onDelete: 'RESTRICT',
    },
)
@Check(
    'CHK_space_closure_processes_status',
    `"status" IN ('OPEN', 'COMPLETED', 'CANCELLED')`,
)
@Check('CHK_space_closure_processes_revision', `"plan_revision" >= 1`)
@Check(
    'CHK_space_closure_processes_plan_status',
    `"plan_status" IN ('DRAFT', 'PROPOSED', 'APPROVED', 'REJECTED')`,
)
@Check(
    'CHK_space_closure_processes_cutoff',
    `"proposed_cutoff_date" IS NULL OR "proposed_cutoff_date" >= "cutoff_date"`,
)
@Check(
    'CHK_space_closure_processes_participants',
    `jsonb_typeof("participants") = 'array' AND jsonb_array_length("participants") BETWEEN 1 AND 2`,
)
@Check(
    'CHK_space_closure_processes_consents',
    `jsonb_typeof("approvals") = 'array' AND jsonb_typeof("confirmations") = 'array'`,
)
@Check(
    'CHK_space_closure_processes_resolution',
    `
    ("status" = 'OPEN' AND "completed_at" IS NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'COMPLETED' AND "completed_at" IS NOT NULL AND "completed_at" >= "started_at" AND "cancelled_at" IS NULL)
    OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "cancelled_at" >= "started_at" AND "completed_at" IS NULL)`,
)
@Index('UQ_space_closure_processes_open', ['spaceId'], {
    unique: true,
    where: `"status" = 'OPEN'`,
})
@Index('IDX_space_closure_processes_history', ['spaceId', 'startedAt', 'id'])
export class SpaceClosureProcessOrmEntity {
    @PrimaryColumn({ type: 'uuid' })
    id!: string;

    @Column({ name: 'space_id', type: 'uuid' })
    @ForeignKey('spaces', 'id', {
        name: 'FK_space_closure_processes_space',
        onDelete: 'RESTRICT',
    })
    spaceId!: string;

    @Column({ type: 'varchar', length: 16 })
    status!: 'OPEN' | 'COMPLETED' | 'CANCELLED';

    @Column({ name: 'requested_by_member_id', type: 'uuid' })
    requestedByMemberId!: string;

    @Column({ name: 'started_at', type: 'timestamptz' })
    startedAt!: Date;

    @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
    completedAt!: Date | null;

    @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
    cancelledAt!: Date | null;

    @Column({ name: 'cutoff_date', type: 'date' })
    cutoffDate!: string;

    @Column({ name: 'proposed_cutoff_date', type: 'date', nullable: true })
    proposedCutoffDate!: string | null;

    @Column({ name: 'plan_revision', type: 'integer' })
    planRevision!: number;

    @Column({ name: 'plan_status', type: 'varchar', length: 16 })
    planStatus!: 'DRAFT' | 'PROPOSED' | 'APPROVED' | 'REJECTED';

    @Column({ type: 'jsonb' })
    participants!: ClosureParticipant[];

    @Column({ type: 'jsonb' })
    approvals!: ClosureConsent[];

    @Column({ type: 'jsonb' })
    confirmations!: ClosureConsent[];
}
