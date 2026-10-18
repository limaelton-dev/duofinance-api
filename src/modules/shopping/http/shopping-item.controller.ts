import {
    Body,
    Controller,
    Get,
    Header,
    HttpCode,
    Param,
    Post,
    Query,
} from '@nestjs/common';
import {
    CurrentActor,
    type RequestActor,
} from '../../../shared/technical/http/current-actor.decorator.js';
import { IdempotencyKey } from '../../../shared/technical/http/idempotency-key.decorator.js';
import { ShoppingItems } from '../application/shopping-items.js';
import { ShoppingQueries } from '../application/shopping-queries.js';
import {
    params,
    parseZodInput,
    addItem,
    changeNeed,
    itemQuery,
    listVersion,
} from './shopping.dto.js';

@Controller('spaces/:spaceId/shopping-lists/:listId/items')
export class ShoppingItemController {
    constructor(
        private readonly commands: ShoppingItems,
        private readonly queries: ShoppingQueries,
    ) {}
    @Post()
    @Header('Cache-Control', 'no-store')
    add(
        @CurrentActor() actor: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        const p = params(raw);
        return this.commands.add(
            actor.personId.value,
            p.spaceId,
            p.listId!,
            key,
            parseZodInput(addItem, body),
        );
    }
    @Post(':itemId/need')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    change(
        @CurrentActor() actor: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        const p = params(raw);
        return this.commands.changeNeed(
            actor.personId.value,
            p.spaceId,
            p.listId!,
            p.itemId!,
            key,
            parseZodInput(changeNeed, body),
        );
    }
    @Post(':itemId/removal')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    remove(
        @CurrentActor() actor: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        const p = params(raw);
        return this.commands.remove(
            actor.personId.value,
            p.spaceId,
            p.listId!,
            p.itemId!,
            key,
            parseZodInput(listVersion, body),
        );
    }
    @Get()
    @Header('Cache-Control', 'no-store')
    list(
        @CurrentActor() actor: RequestActor,
        @Param() raw: unknown,
        @Query() q: unknown,
    ) {
        const p = params(raw);
        return this.queries.items(
            actor.personId.value,
            p.spaceId,
            p.listId!,
            parseZodInput(itemQuery, q),
        );
    }
    @Get(':itemId')
    @Header('Cache-Control', 'no-store')
    detail(@CurrentActor() actor: RequestActor, @Param() raw: unknown) {
        const p = params(raw);
        return this.queries.item(
            actor.personId.value,
            p.spaceId,
            p.listId!,
            p.itemId!,
        );
    }
}
