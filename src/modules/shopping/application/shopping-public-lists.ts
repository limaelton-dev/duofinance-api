import { Inject, Injectable } from '@nestjs/common';
import {
    SPACE_PARTICIPANTS_PORT,
    type SpaceParticipantsPort,
} from '../../spaces/application/ports/public/space-participants.port.js';
import type { PersonId } from '../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../spaces/domain/space/space-id.js';
import { requireActiveList } from '../domain/shopping-list.js';
import { shoppingSummary } from '../domain/shopping-item.js';
import { SHOPPING_STORE, type ShoppingStore } from './shopping-store.js';
import { ShoppingQueries } from './shopping-queries.js';
import type { ShoppingListsPort } from './ports/public/shopping-lists.port.js';

@Injectable()
export class ShoppingPublicLists implements ShoppingListsPort {
    constructor(
        @Inject(SHOPPING_STORE) private readonly store: ShoppingStore,
        @Inject(SPACE_PARTICIPANTS_PORT)
        private readonly participants: SpaceParticipantsPort,
        private readonly queries: ShoppingQueries,
    ) {}
    async lockActive(actor: PersonId, space: SpaceId, id: string) {
        await this.participants.lockForWrite(actor, space);
        requireActiveList(await this.store.lockList(space.value, id));
    }
    reference(actor: PersonId, space: SpaceId, id: string) {
        return this.queries.read(actor.value, space.value, async () => {
            const list = await this.store.find(space.value, id);
            const summary =
                (await this.store.summary(space.value, [id])).get(id) ??
                shoppingSummary();
            return {
                id,
                name: list.name,
                status: list.status,
                summary: {
                    activeItemCount: summary.activeItemCount,
                    actionableItemCount: summary.actionableItemCount,
                    isComplete: summary.isComplete,
                },
            };
        });
    }
}
