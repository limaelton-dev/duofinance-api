import { Controller, Get, Header, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import {
    CurrentActor,
    type RequestActor,
} from '../../shared/technical/http/current-actor.decorator.js';
import { parseZodInput } from '../../shared/technical/http/validation/parse-zod-input.js';
import {
    SHOPPING_LISTS_PORT,
    type ShoppingListsPort,
} from '../../modules/shopping/application/ports/public/shopping-lists.port.js';
import {
    ROUTINE_LINKED_TASKS_PORT,
    type RoutineLinkedTasksPort,
} from '../../modules/routine/application/ports/public/routine-linked-tasks.port.js';
import { SpaceId } from '../../modules/spaces/domain/space/space-id.js';
import { PersonId } from '../../modules/spaces/domain/person/person-id.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const params = z.object({ spaceId: uuid, listId: uuid }).strict();
const page = z
    .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        cursor: z.string().min(1).max(3000).optional(),
    })
    .strict();
@Controller('spaces/:spaceId/shopping-lists/:listId/tasks')
export class ShoppingTasksController {
    constructor(
        @Inject(SHOPPING_LISTS_PORT)
        private readonly shopping: ShoppingListsPort,
        @Inject(ROUTINE_LINKED_TASKS_PORT)
        private readonly routine: RoutineLinkedTasksPort,
    ) {}
    @Get()
    @Header('Cache-Control', 'no-store')
    async list(
        @CurrentActor() actor: RequestActor,
        @Param() raw: unknown,
        @Query() query: unknown,
    ) {
        const p = parseZodInput(params, raw);
        const q = parseZodInput(page, query);
        const space = SpaceId.from(p.spaceId);
        const person = PersonId.from(actor.personId.value);
        await this.shopping.reference(person, space, p.listId);
        return {
            spaceId: p.spaceId,
            shoppingListId: p.listId,
            ...(await this.routine.read(person, space, p.listId, q)),
        };
    }
}
