import {
    Body,
    Controller,
    Header,
    HttpCode,
    Param,
    Post,
} from '@nestjs/common';
import {
    CurrentActor,
    type RequestActor,
} from '../../../shared/technical/http/current-actor.decorator.js';
import { IdempotencyKey } from '../../../shared/technical/http/idempotency-key.decorator.js';
import { TaskShoppingList } from '../application/task-shopping-list.js';
import {
    params,
    parseZodInput,
    linkTaskShoppingList,
    unlinkTaskShoppingList,
} from './routine.dto.js';

@Controller('spaces/:spaceId/tasks/:taskId/shopping-list')
export class TaskShoppingListController {
    constructor(private readonly commands: TaskShoppingList) {}
    @Post()
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    link(
        @CurrentActor() actor: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        const p = params(raw);
        return this.commands.change(
            actor.personId.value,
            p.spaceId,
            p.taskId!,
            key,
            parseZodInput(linkTaskShoppingList, body),
        );
    }
    @Post('removal')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    unlink(
        @CurrentActor() actor: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        const p = params(raw);
        return this.commands.change(
            actor.personId.value,
            p.spaceId,
            p.taskId!,
            key,
            {
                ...parseZodInput(unlinkTaskShoppingList, body),
                shoppingListId: null,
            },
        );
    }
}
