import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManagerProvider } from '../../../shared/technical/database/typeorm/entity-manager.provider.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../spaces/application/ports/public/space-access.port.js';
import { PersonId } from '../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../spaces/domain/space/space-id.js';
import type { ShoppingClosurePort } from '../application/ports/public/shopping-closure.port.js';
import {
    SPACE_CLOSURE_PORT,
    type SpaceClosurePort,
} from '../../spaces/application/ports/public/space-closure.port.js';
import {
    SHOPPING_STORE,
    type ShoppingStore,
} from '../application/shopping-store.js';
import { ShoppingError } from '../domain/shopping-error.js';
import { archiveList } from '../domain/shopping-list.js';
import {
    ShoppingAuditOrmEntity,
    ShoppingListOrmEntity,
    rowToList,
} from './shopping.orm-entity.js';

@Injectable()
export class TypeOrmShoppingClosure implements ShoppingClosurePort {
    constructor(
        private readonly manager: EntityManagerProvider,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_CLOSURE_PORT) private readonly closures: SpaceClosurePort,
        @Inject(SHOPPING_STORE) private readonly lists: ShoppingStore,
    ) {}
    async complete(
        actorId: string,
        spaceId: string,
        processId: string,
        now: Date,
    ): Promise<void> {
        const manager = this.manager.get();
        if (!manager.queryRunner?.isTransactionActive)
            throw new Error('Shopping closure requires a transaction');
        await this.access.assertCanRead(
            PersonId.from(actorId),
            SpaceId.from(spaceId),
        );
        const process = await this.closures.lockForProcess(actorId, spaceId);
        if (
            !process ||
            process.processId !== processId ||
            process.spaceStatus !== 'CLOSING' ||
            process.processStatus !== 'OPEN' ||
            process.planStatus !== 'APPROVED' ||
            !process.requiredMemberIds.every((memberId) =>
                process.approvals.some(
                    (approval) =>
                        approval.memberId === memberId &&
                        approval.planRevision === process.planRevision,
                ),
            )
        )
            throw new ShoppingError('CONCURRENT_MODIFICATION');
        const participant = process.participants.find(
            (member) => member.personId === actorId,
        );
        if (!participant) throw new ShoppingError('CONCURRENT_MODIFICATION');
        const closure = { processId, planRevision: process.planRevision };
        const rows = await manager
            .createQueryBuilder(ShoppingListOrmEntity, 'list')
            .where('list.spaceId=:spaceId AND list.status=:status', {
                spaceId,
                status: 'ACTIVE',
            })
            .orderBy('list.id', 'ASC')
            .setLock('pessimistic_write')
            .getMany();
        for (const row of rows) {
            const before = rowToList(row),
                after = archiveList(before, now.toISOString());
            await this.lists.update(before, after);
            await this.lists.event({
                id: randomUUID(),
                spaceId,
                aggregateId: before.id,
                sequence: after.version,
                type: 'ARCHIVED',
                actor: {
                    personId: actorId,
                    memberId: participant.memberId,
                    displayName: participant.displayName,
                },
                registeredAt: now,
                data: { before, after, closure },
            });
            await manager.insert(ShoppingAuditOrmEntity, {
                id: randomUUID(),
                spaceId,
                actorId,
                action: 'CLOSE_SPACE_SHOPPING_LIST',
                aggregateId: before.id,
                key: processId,
                registeredAt: now,
            });
        }
    }
    async summary(actorId: string, spaceId: string) {
        await this.access.assertCanRead(
            PersonId.from(actorId),
            SpaceId.from(spaceId),
        );
        const [row] = await this.manager
            .get()
            .query(
                `SELECT count(*)::int AS "activeListCount" FROM shopping_lists WHERE space_id=$1 AND status='ACTIVE'`,
                [spaceId],
            );
        return row;
    }
}
