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
    TaskRecurrence,
    TaskOccurrence,
} from '../domain/task-recurrence.js';
@Entity('routine_task_recurrences')
@Index('IDX_routine_recurrence_assignee', { synchronize: false })
@Index('IDX_routine_recurrence_space', ['spaceId', 'id'])
@Unique('UQ_routine_recurrence_space', ['spaceId', 'id'])
@Check(
    'CHK_routine_recurrence_values',
    `version>0 AND (ends_on IS NULL OR ends_on>=starts_on) AND status IN ('ACTIVE','CANCELLED') AND ((status='CANCELLED')=(cancelled_on IS NOT NULL))`,
)
@ForeignKey('spaces', ['spaceId'], ['id'], {
    name: 'FK_routine_recurrence_space',
    onDelete: 'RESTRICT',
})
@ForeignKey('persons', ['creatorPersonId'], ['id'], {
    name: 'FK_routine_recurrence_creator',
    onDelete: 'RESTRICT',
})
export class TaskRecurrenceOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'creator_person_id', type: 'uuid' })
    creatorPersonId!: string;
    @Column({ name: 'starts_on', type: 'date' }) startsOn!: string;
    @Column({ name: 'ends_on', type: 'date', nullable: true }) endsOn!:
        string | null;
    @Column({ name: 'cancelled_on', type: 'date', nullable: true })
    cancelledOn!: string | null;
    @Column({ type: 'varchar', length: 12 }) status!: TaskRecurrence['status'];
    @Column({ type: 'integer' }) version!: number;
    @Column({ type: 'jsonb' }) snapshot!: TaskRecurrence;
}
@Entity('routine_task_occurrences')
@Index('IDX_routine_occurrence_assignee', { synchronize: false })
@Unique('UQ_routine_occurrence_date', ['recurrenceId', 'scheduledDate'])
@Index('IDX_routine_occurrence_list', [
    'spaceId',
    'status',
    'scheduledDate',
    'id',
])
@Check(
    'CHK_routine_occurrence_values',
    `version>0 AND status IN ('PENDING','COMPLETED','SKIPPED','CANCELLED')`,
)
@ForeignKey(
    () => TaskRecurrenceOrmEntity,
    ['spaceId', 'recurrenceId'],
    ['spaceId', 'id'],
    { name: 'FK_routine_occurrence_rule', onDelete: 'RESTRICT' },
)
export class TaskOccurrenceOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'recurrence_id', type: 'uuid' }) recurrenceId!: string;
    @Column({ name: 'scheduled_date', type: 'date' }) scheduledDate!: string;
    @Column({ type: 'varchar', length: 12 }) status!: TaskOccurrence['status'];
    @Column({ type: 'integer' }) version!: number;
    @Column({ type: 'jsonb' }) snapshot!: TaskOccurrence;
}
