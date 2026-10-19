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
import { ShoppingLists } from '../application/shopping-lists.js';
import { ShoppingQueries } from '../application/shopping-queries.js';
import {
    params,
    parseZodInput,
    createList,
    renameList,
    listQuery,
    pageQuery,
    listVersion,
} from './shopping.dto.js';

@Controller('spaces/:spaceId/shopping-lists')
export class ShoppingListController {
    constructor(
        private readonly lists: ShoppingLists,
        private readonly queries: ShoppingQueries,
    ) {}
    @Post()
    @Header('Cache-Control', 'no-store')
    create(
        @CurrentActor() a: RequestActor,
        @Param() p: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        return this.lists.create(
            a.personId.value,
            params(p).spaceId,
            key,
            parseZodInput(createList, body),
        );
    }
    @Post(':listId/name')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    rename(
        @CurrentActor() a: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        const p = params(raw);
        return this.lists.rename(
            a.personId.value,
            p.spaceId,
            p.listId!,
            key,
            parseZodInput(renameList, body),
        );
    }
    @Post(':listId/archival')
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    archive(
        @CurrentActor() actor: RequestActor,
        @Param() raw: unknown,
        @IdempotencyKey() key: string,
        @Body() body: unknown,
    ) {
        const p = params(raw);
        return this.lists.archive(
            actor.personId.value,
            p.spaceId,
            p.listId!,
            key,
            parseZodInput(listVersion, body),
        );
    }
    @Get()
    @Header('Cache-Control', 'no-store')
    list(
        @CurrentActor() a: RequestActor,
        @Param() p: unknown,
        @Query() q: unknown,
    ) {
        return this.queries.list(
            a.personId.value,
            params(p).spaceId,
            parseZodInput(listQuery, q),
        );
    }
    @Get(':listId')
    @Header('Cache-Control', 'no-store')
    detail(@CurrentActor() a: RequestActor, @Param() raw: unknown) {
        const p = params(raw);
        return this.queries.detail(a.personId.value, p.spaceId, p.listId!);
    }
    @Get(':listId/history')
    @Header('Cache-Control', 'no-store')
    history(
        @CurrentActor() a: RequestActor,
        @Param() raw: unknown,
        @Query() q: unknown,
    ) {
        const p = params(raw);
        return this.queries.history(
            a.personId.value,
            p.spaceId,
            p.listId!,
            parseZodInput(pageQuery, q),
        );
    }
}
