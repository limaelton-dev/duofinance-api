import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
    SHOPPING_LISTS_PORT,
    type ShoppingListsPort,
} from '../../shopping/application/ports/public/shopping-lists.port.js';
import { PersonId } from '../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../spaces/domain/space/space-id.js';
import { linkShoppingList } from '../domain/task.js';
import { RoutineError } from '../domain/routine-error.js';
import { RoutineCommands } from './routine-commands.js';
import { ROUTINE_STORE, type RoutineStore } from './routine-store.js';

@Injectable()
export class TaskShoppingList {
    constructor(
        private readonly commands: RoutineCommands,
        @Inject(ROUTINE_STORE) private readonly store: RoutineStore,
        @Inject(SHOPPING_LISTS_PORT)
        private readonly shopping: ShoppingListsPort,
    ) {}
    change(
        actor: string,
        space: string,
        id: string,
        key: string,
        input: { expectedVersion: number; shoppingListId: string | null },
    ) {
        return this.commands.execute(
            actor,
            space,
            key,
            input.shoppingListId === null
                ? 'UNLINK_TASK_SHOPPING_LIST'
                : 'LINK_TASK_SHOPPING_LIST',
            id,
            input,
            async (_, now) => {
                const before = await this.store.find(space, id);
                if (before.version !== input.expectedVersion)
                    throw new RoutineError('CONCURRENT_MODIFICATION');
                if (input.shoppingListId !== null)
                    await this.shopping.lockActive(
                        PersonId.from(actor),
                        SpaceId.from(space),
                        input.shoppingListId,
                    );
                const after = linkShoppingList(before, input.shoppingListId);
                await this.store.update(before, after);
                await this.store.event({
                    id: randomUUID(),
                    spaceId: space,
                    aggregateId: id,
                    sequence: after.version,
                    type: 'SHOPPING_LIST_CHANGED',
                    actorId: actor,
                    registeredAt: new Date(now),
                    data: {
                        before: before.shoppingListId,
                        after: input.shoppingListId,
                    },
                });
                return after;
            },
        );
    }
}
