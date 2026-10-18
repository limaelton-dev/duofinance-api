import {
    Body,
    Controller,
    Get,
    Header,
    Param,
    Post,
    Query,
} from '@nestjs/common';
import {
    CurrentActor,
    type RequestActor,
} from '../../../shared/technical/http/current-actor.decorator.js';
import { IdempotencyKey } from '../../../shared/technical/http/idempotency-key.decorator.js';
import { ShoppingPurchases } from '../application/shopping-purchases.js';
import { ShoppingQueries } from '../application/shopping-queries.js';
import {
    params,
    parseZodInput,
    recordPurchase,
    pageQuery,
} from './shopping.dto.js';

@Controller('spaces/:spaceId/shopping-lists/:listId/items/:itemId/purchases')
export class ShoppingPurchaseController {
    constructor(
        private readonly commands: ShoppingPurchases,
        private readonly queries: ShoppingQueries,
    ) {}
    @Post()
    @Header('Cache-Control', 'no-store')
    record(
        @CurrentActor() actor: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        const p = params(raw);
        return this.commands.record(
            actor.personId.value,
            p.spaceId,
            p.listId!,
            p.itemId!,
            key,
            parseZodInput(recordPurchase, body),
        );
    }
    @Get()
    @Header('Cache-Control', 'no-store')
    list(
        @CurrentActor() actor: RequestActor,
        @Param() raw: unknown,
        @Query() query: unknown,
    ) {
        const p = params(raw);
        return this.queries.purchases(
            actor.personId.value,
            p.spaceId,
            p.listId!,
            p.itemId!,
            parseZodInput(pageQuery, query),
        );
    }
}
