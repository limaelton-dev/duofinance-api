import { Injectable } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { RoutineAttentionUnavailableError } from '../application/ports/public/routine-attention-query.port.js';
import { EntityManagerProvider } from '../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type {
    TaskAttentionReader,
    TaskListFilters,
    TaskAttentionCounts,
} from '../application/task-attention-reader.js';
import type { AttentionReference } from '../domain/task-attention.js';
import { TaskOrmEntity, rowToTask } from './routine.orm-entity.js';
@Injectable()
export class TypeOrmTaskAttentionReader implements TaskAttentionReader {
    constructor(private readonly provider: EntityManagerProvider) {}
    read(
        space: string,
        actor: string,
        filters: TaskListFilters,
        reference: AttentionReference,
        after: string | null,
        limit: number,
    ) {
        return this.provider
            .readSnapshot(async () => {
                const overdue = `t.status='PENDING' AND (t.deadline_date<:date OR (t.deadline_time IS NOT NULL AND (t.deadline_date::text || ' ' || t.deadline_time)::timestamp < (:instant::timestamptz AT TIME ZONE 'America/Sao_Paulo')))`;
                const today = `t.status='PENDING' AND t.deadline_date=:date`;
                const urgent = `t.status='PENDING' AND t.urgency='URGENT'`;
                const upcoming = `t.status='PENDING' AND t.deadline_date>:date`;
                const noDeadline = `t.status='PENDING' AND t.deadline_date IS NULL`;
                const expressions = {
                    TODAY: today,
                    OVERDUE: overdue,
                    URGENT: urgent,
                    UPCOMING: upcoming,
                    NO_DEADLINE: noDeadline,
                    ATTENTION: `((${overdue}) OR (${today}) OR (${urgent}))`,
                };
                const sortKey = `concat(CASE WHEN ${overdue} THEN '0' WHEN ${today} THEN '1' WHEN t.deadline_date IS NOT NULL THEN '2' ELSE '3' END, ':',CASE t.urgency WHEN 'URGENT' THEN '0' WHEN 'HIGH' THEN '1' WHEN 'NORMAL' THEN '2' ELSE '3' END, ':',coalesce(t.deadline_date::text,'9999-12-31'),':',coalesce(t.deadline_time,'23:59'),':',t.id::text)`;
                const q = this.provider
                    .get()
                    .createQueryBuilder(TaskOrmEntity, 't')
                    .where('t.spaceId=:space', { space })
                    .setParameters({
                        date: reference.referenceDate,
                        instant: reference.referenceInstant,
                    });
                if (filters.status !== 'ALL')
                    q.andWhere('t.status=:status', { status: filters.status });
                if (filters.scope === 'MINE')
                    q.andWhere('t.assigneePersonId=:actor', { actor });
                if (filters.from)
                    q.andWhere('t.deadlineDate>=:from', { from: filters.from });
                if (filters.to)
                    q.andWhere('t.deadlineDate<=:to', { to: filters.to });
                if (filters.attention)
                    q.andWhere(`(${expressions[filters.attention]})`);
                const counts = await q
                    .clone()
                    .select('count(*)::int', 'totalCount')
                    .addSelect(`count(*) FILTER (WHERE ${today})::int`, 'today')
                    .addSelect(
                        `count(*) FILTER (WHERE ${overdue})::int`,
                        'overdue',
                    )
                    .addSelect(
                        `count(*) FILTER (WHERE ${urgent})::int`,
                        'urgent',
                    )
                    .addSelect(
                        `count(*) FILTER (WHERE ${upcoming})::int`,
                        'upcoming',
                    )
                    .addSelect(
                        `count(*) FILTER (WHERE ${noDeadline})::int`,
                        'noDeadline',
                    )
                    .getRawOne<TaskAttentionCounts>();
                if (after) q.andWhere(`${sortKey}>:after`, { after });
                const page = await q
                    .addSelect(sortKey, 'sortKey')
                    .orderBy('"sortKey"', 'ASC')
                    .limit(limit)
                    .getRawAndEntities();
                return {
                    rows: page.entities.map((row, index) => ({
                        task: rowToTask(row),
                        sortKey: page.raw[index].sortKey as string,
                    })),
                    counts: counts!,
                };
            })
            .catch((error) => {
                const cause =
                    error instanceof QueryFailedError
                        ? error.driverError
                        : error;
                const code =
                    typeof cause === 'object' &&
                    cause !== null &&
                    'code' in cause
                        ? cause.code
                        : null;
                if (
                    typeof code === 'string' &&
                    (code.startsWith('08') ||
                        [
                            '53000',
                            '53100',
                            '53200',
                            '53300',
                            '53400',
                            '57014',
                            '57P01',
                            '57P02',
                            '57P03',
                            'ECONNREFUSED',
                            'ECONNRESET',
                            'ETIMEDOUT',
                            'EPIPE',
                        ].includes(code))
                )
                    throw new RoutineAttentionUnavailableError();
                throw error;
            });
    }
}
