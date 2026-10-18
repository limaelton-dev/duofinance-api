import { Inject, Injectable } from '@nestjs/common';
import type { PersonId } from '../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../spaces/domain/space/space-id.js';
import { ShoppingQueries } from './shopping-queries.js';
import { SHOPPING_STORE, type ShoppingStore } from './shopping-store.js';
import type { ShoppingAttentionQueryPort } from './ports/public/shopping-attention-query.port.js';
import { ShoppingAttentionUnavailableError } from './ports/public/shopping-attention-query.port.js';
import { shoppingReference } from './shopping-clock.js';

@Injectable()
export class ShoppingAttentionQuery implements ShoppingAttentionQueryPort {
    constructor(
        @Inject(SHOPPING_STORE) private readonly store: ShoppingStore,
        private readonly queries: ShoppingQueries,
    ) {}
    read(actor: PersonId, space: SpaceId, instant: Date) {
        const reference = shoppingReference(instant);
        return this.queries.read(
            actor.value,
            space.value,
            () => this.store.attention(space.value),
            (result, context) => ({
                ...result,
                spaceId: space.value,
                actorMemberId: context.actorMemberId,
                ...reference,
            }),
            new ShoppingAttentionUnavailableError(),
        );
    }
}
