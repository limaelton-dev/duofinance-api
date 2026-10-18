import {
    Check,
    Column,
    Entity,
    ForeignKey,
    Index,
    PrimaryColumn,
    Unique,
} from 'typeorm';
import type { Task, Deadline, Participant, Urgency } from '../domain/task.js';

@Entity('routine_tasks')
@Index('IDX_routine_task_list', [
    'spaceId',
    'status',
    'urgency',
    'deadlineDate',
    'id',
])
@Index('IDX_routine_task_assignee', ['spaceId', 'assigneePersonId', 'status'])
@Unique('UQ_routine_task_space', ['spaceId', 'id'])
@Check(
    'CHK_routine_task_values',
    `version > 0 AND length(description) BETWEEN 1 AND 500 AND description=btrim(description) AND urgency IN ('LOW','NORMAL','HIGH','URGENT') AND status IN ('PENDING','COMPLETED','CANCELLED') AND (deadline_time IS NULL OR (deadline_date IS NOT NULL AND deadline_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')) AND ((status='COMPLETED')=(completion IS NOT NULL)) AND (assignee_member_id IS NULL OR assignee_person_id IS NOT NULL)`,
)
@ForeignKey('spaces', ['spaceId'], ['id'], {
    name: 'FK_routine_task_space',
    onDelete: 'RESTRICT',
})
@ForeignKey('persons', ['creatorPersonId'], ['id'], {
    name: 'FK_routine_task_creator',
    onDelete: 'RESTRICT',
})
@ForeignKey('persons', ['assigneePersonId'], ['id'], {
    name: 'FK_routine_task_assignee',
    onDelete: 'RESTRICT',
})
@ForeignKey(
    'space_members',
    ['spaceId', 'creatorMemberId'],
    ['spaceId', 'id'],
    { name: 'FK_routine_task_creator_member', onDelete: 'RESTRICT' },
)
@ForeignKey(
    'space_members',
    ['spaceId', 'assigneeMemberId'],
    ['spaceId', 'id'],
    { name: 'FK_routine_task_assignee_member', onDelete: 'RESTRICT' },
)
export class TaskOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ type: 'varchar', length: 500 }) description!: string;
    @Column({ name: 'creator_person_id', type: 'uuid' })
    creatorPersonId!: string;
    @Column({ name: 'creator_member_id', type: 'uuid', nullable: true })
    creatorMemberId!: string | null;
    @Column({ name: 'assignee_person_id', type: 'uuid', nullable: true })
    assigneePersonId!: string | null;
    @Column({ name: 'assignee_member_id', type: 'uuid', nullable: true })
    assigneeMemberId!: string | null;
    @Column({ name: 'deadline_date', type: 'date', nullable: true })
    deadlineDate!: string | null;
    @Column({
        name: 'deadline_time',
        type: 'varchar',
        length: 5,
        nullable: true,
    })
    deadlineTime!: string | null;
    @Column({ type: 'varchar', length: 10 }) urgency!: Urgency;
    @Column({ type: 'varchar', length: 12 }) status!: Task['status'];
    @Column({ type: 'integer' }) version!: number;
    @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
    @Column({ type: 'jsonb', nullable: true }) completion!: Task['completion'];
}
@Entity('routine_history')
@Index('IDX_routine_history_page', ['spaceId', 'aggregateId', 'sequence'])
@Unique('UQ_routine_history_version', ['aggregateId', 'sequence'])
@ForeignKey('spaces', ['spaceId'], ['id'], {
    name: 'FK_routine_history_space',
    onDelete: 'RESTRICT',
})
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_routine_history_actor',
    onDelete: 'RESTRICT',
})
export class RoutineHistoryOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'aggregate_id', type: 'uuid' }) aggregateId!: string;
    @Column({ type: 'integer' }) sequence!: number;
    @Column({ type: 'varchar', length: 40 }) type!: string;
    @Column({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
    @Column({ type: 'jsonb' }) data!: object;
}
@Entity('routine_command_receipts')
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_routine_receipt_actor',
    onDelete: 'RESTRICT',
})
export class RoutineReceiptOrmEntity {
    @PrimaryColumn({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @PrimaryColumn({ type: 'varchar', length: 60 }) operation!: string;
    @PrimaryColumn({ type: 'uuid' }) key!: string;
    @Column({ type: 'varchar', length: 64 }) digest!: string;
    @Column({ type: 'jsonb' }) result!: object;
}
@Entity('routine_command_audit')
@Index('IDX_routine_audit_space', ['spaceId', 'registeredAt'])
@ForeignKey('spaces', ['spaceId'], ['id'], {
    name: 'FK_routine_audit_space',
    onDelete: 'RESTRICT',
})
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_routine_audit_actor',
    onDelete: 'RESTRICT',
})
export class RoutineAuditOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @Column({ type: 'varchar', length: 60 }) action!: string;
    @Column({ name: 'aggregate_id', type: 'uuid' }) aggregateId!: string;
    @Column({ type: 'uuid' }) key!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}

export function taskToRow(task: Task): TaskOrmEntity {
    return {
        id: task.id,
        spaceId: task.spaceId,
        description: task.description,
        creatorPersonId: task.creator.personId,
        creatorMemberId: task.creator.memberId,
        assigneePersonId: task.assignee?.personId ?? null,
        assigneeMemberId: task.assignee?.memberId ?? null,
        deadlineDate: task.deadline?.date ?? null,
        deadlineTime: task.deadline?.time ?? null,
        urgency: task.urgency,
        status: task.status,
        version: task.version,
        createdAt: new Date(task.createdAt),
        completion: task.completion,
    };
}
export function rowToTask(row: TaskOrmEntity): Task {
    const creator: Participant = {
        personId: row.creatorPersonId,
        memberId: row.creatorMemberId,
    };
    const deadline: Deadline = row.deadlineDate
        ? { date: row.deadlineDate, time: row.deadlineTime }
        : null;
    return {
        id: row.id,
        spaceId: row.spaceId,
        description: row.description,
        creator,
        assignee: row.assigneePersonId
            ? { personId: row.assigneePersonId, memberId: row.assigneeMemberId }
            : null,
        deadline,
        urgency: row.urgency,
        status: row.status,
        version: row.version,
        createdAt: row.createdAt.toISOString(),
        completion: row.completion,
    };
}
