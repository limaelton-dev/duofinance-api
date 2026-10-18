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
import { ShoppingPurchases } from '../application/shopping-purchases.js';
import { ShoppingCorrections } from '../application/shopping-corrections.js';
import { ShoppingQueries } from '../application/shopping-queries.js';
import {
    params,
    parseZodInput,
    recordPurchase,
    pageQuery,
    correctPurchase,
} from './shopping.dto.js';

@Controller('spaces/:spaceId/shopping-lists/:listId/items/:itemId/purchases')
export class ShoppingPurchaseController {
    constructor(
        private readonly commands: ShoppingPurchases,
        private readonly queries: ShoppingQueries,
        private readonly corrections: ShoppingCorrections,
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
    @Post(':purchaseId/corrections')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    correct(
        @CurrentActor() actor: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        const p = params(raw);
        return this.corrections.correct(
            actor.personId.value,
            p.spaceId,
            p.listId!,
            p.itemId!,
            p.purchaseId!,
            key,
            parseZodInput(correctPurchase, body),
        );
    }
    @Get(':purchaseId/corrections')
    @Header('Cache-Control', 'no-store')
    history(
        @CurrentActor() actor: RequestActor,
        @Param() raw: unknown,
        @Query() query: unknown,
    ) {
        const p = params(raw);
        return this.queries.corrections(
            actor.personId.value,
            p.spaceId,
            p.listId!,
            p.itemId!,
            p.purchaseId!,
            parseZodInput(pageQuery, query),
        );
    }
}
