import { Inject, Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../shared/technical/database/typeorm/entity-manager.provider.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../spaces/application/ports/public/space-access.port.js';
import { PersonId } from '../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../spaces/domain/space/space-id.js';
import type { ShoppingClosurePort } from '../application/ports/public/shopping-closure.port.js';

@Injectable()
export class TypeOrmShoppingClosure implements ShoppingClosurePort {
    constructor(
        private readonly manager: EntityManagerProvider,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
    ) {}
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
