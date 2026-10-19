import { Injectable } from '@nestjs/common';
import { isPostgresqlUnavailable } from '../../../shared/technical/database/postgresql-unavailable.js';
import { EntityManagerProvider } from '../../../shared/technical/database/typeorm/entity-manager.provider.js';
import { RoutineAttentionUnavailableError } from '../application/ports/public/routine-attention-query.port.js';
import type {
    TaskAttentionReader,
    TaskListFilters,
    TaskAttentionCounts,
} from '../application/task-attention-reader.js';
import type { AttentionReference } from '../domain/task-attention.js';
import type { TaskItem } from '../domain/task-item.js';
import { addDays } from '../domain/task-recurrence.js';
import { routineCountsSql, routinePageSql } from './routine-items.sql.js';
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
                const from =
                        filters.from ??
                        (filters.to ? addDays(filters.to, -365) : null),
                    to =
                        filters.to ??
                        (filters.from ? addDays(filters.from, 365) : null);
                const parameters = [
                    space,
                    actor,
                    reference.referenceDate,
                    reference.referenceInstant,
                    filters.status,
                    filters.scope,
                    filters.attention ?? null,
                    from,
                    to,
                ];
                const [counts]: TaskAttentionCounts[] = await this.provider
                    .get()
                    .query(routineCountsSql, parameters);
                const occurrenceIdentity = after?.split(':').at(-1)?.split('/');
                let afterDate =
                    occurrenceIdentity?.[1] ?? after?.split(':')[2] ?? null;
                if (afterDate === '9999-12-31') afterDate = null;
                const rows: { task: TaskItem; sortKey: string }[] =
                    await this.provider
                        .get()
                        .query(routinePageSql, [
                            ...parameters,
                            after,
                            limit,
                            afterDate,
                            occurrenceIdentity?.[1]
                                ? occurrenceIdentity[0]
                                : null,
                        ]);
                return { rows, counts };
            })
            .catch((error) => {
                if (isPostgresqlUnavailable(error))
                    throw new RoutineAttentionUnavailableError();
                throw error;
            });
    }
}
