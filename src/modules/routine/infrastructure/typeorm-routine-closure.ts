import { Inject, Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../shared/technical/database/typeorm/entity-manager.provider.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../spaces/application/ports/public/space-access.port.js';
import { PersonId } from '../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../spaces/domain/space/space-id.js';
import type { RoutineClosurePort } from '../application/ports/public/routine-closure.port.js';

@Injectable()
export class TypeOrmRoutineClosure implements RoutineClosurePort {
    constructor(
        private readonly manager: EntityManagerProvider,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
    ) {}
    async summary(actorId: string, spaceId: string) {
        await this.access.assertCanRead(
            PersonId.from(actorId),
            SpaceId.from(spaceId),
        );
        const [row] = await this.manager.get().query(
            `SELECT ((SELECT count(*) FROM routine_tasks WHERE space_id=$1 AND status='PENDING') +
                (SELECT count(*) FROM routine_task_occurrences WHERE space_id=$1 AND status='PENDING'))::int AS "pendingTaskCount",
                (SELECT count(*)::int FROM routine_task_recurrences WHERE space_id=$1 AND status='ACTIVE') AS "activeRecurrenceCount"`,
            [spaceId],
        );
        return row;
    }
}
