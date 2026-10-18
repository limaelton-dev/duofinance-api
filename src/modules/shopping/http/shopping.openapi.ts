import type {
    OpenAPIObject,
    OperationObject,
    SchemaObject,
    ReferenceObject,
} from '@nestjs/swagger';

const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const instant: SchemaObject = { type: 'string', format: 'date-time' };
const version: SchemaObject = {
    type: 'integer',
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
};
const ref = (name: string): ReferenceObject => ({
    $ref: `#/components/schemas/${name}`,
});
const nullable = (schema: SchemaObject | ReferenceObject): SchemaObject => ({
    oneOf: [schema, { type: 'null' }],
});
const object = (
    properties: Record<string, SchemaObject | ReferenceObject>,
    required = Object.keys(properties),
): SchemaObject => ({
    type: 'object',
    additionalProperties: false,
    properties,
    required,
});
const name = nullable({ type: 'string', minLength: 1, maxLength: 120 });
const listProperties = {
    id: uuid,
    spaceId: uuid,
    name,
    status: { type: 'string' as const, enum: ['ACTIVE', 'ARCHIVED'] },
    version,
    creator: ref('ShoppingAuthor'),
    createdAt: instant,
    archivedAt: nullable(instant),
};
const pageProperties = {
    nextCursor: nullable({ type: 'string' }),
};
export const shoppingSchemas: Record<string, SchemaObject> = {
    ShoppingAuthor: object({
        personId: uuid,
        memberId: nullable(uuid),
        displayName: { type: 'string' },
    }),
    ShoppingCreateList: object({ name }, []),
    ShoppingRenameList: object({ expectedVersion: version, name }),
    ShoppingList: object(listProperties),
    ShoppingSummary: object({
        ...Object.fromEntries(
            [
                'activeItemCount',
                'pendingItemCount',
                'partiallyPurchasedItemCount',
                'purchasedItemCount',
                'actionableItemCount',
            ].map((key) => [key, { type: 'integer' as const, minimum: 0 }]),
        ),
        isComplete: {
            type: 'boolean',
            description:
                'Ausência de pendência entre itens ativos. Confira activeItemCount para distinguir lista vazia.',
        },
        canSuggestArchival: { type: 'boolean' },
    }),
    ShoppingListView: object({
        ...listProperties,
        summary: ref('ShoppingSummary'),
        allowedActions: { type: 'array', items: { type: 'string' } },
    }),
    ShoppingListPage: object({
        ...pageProperties,
        items: { type: 'array', items: ref('ShoppingListView') },
        totalCount: { type: 'integer', minimum: 0 },
    }),
    ShoppingHistoryPage: object({
        ...pageProperties,
        items: {
            type: 'array',
            items: object({
                id: uuid,
                spaceId: uuid,
                aggregateId: uuid,
                sequence: version,
                type: { type: 'string', enum: ['CREATED', 'RENAMED'] },
                actor: ref('ShoppingAuthor'),
                registeredAt: instant,
                data: { type: 'object', additionalProperties: true },
            }),
        },
    }),
};
shoppingSchemas.ShoppingListDetail = object({
    ...shoppingSchemas.ShoppingListView.properties,
    items: object({
        ...pageProperties,
        items: { type: 'array', maxItems: 0, items: {} },
    }),
});
export function shoppingOperation(
    method: 'get' | 'post',
    path: string,
    result: string,
    body?: string,
): OperationObject {
    const parameters: NonNullable<OperationObject['parameters']> = [
        ...path.matchAll(/\{(\w+)\}/g),
    ].map(([, name]) => ({
        name,
        in: 'path',
        required: true,
        schema: uuid,
    }));
    if (method === 'post')
        parameters.push(
            {
                name: 'Idempotency-Key',
                in: 'header',
                required: true,
                schema: uuid,
            },
            ...['X-CSRF-Token', 'Origin'].map((name) => ({
                name,
                in: 'header' as const,
                required: true,
                schema: { type: 'string' as const },
            })),
        );
    if (method === 'get' && result.endsWith('Page'))
        parameters.push(
            {
                name: 'limit',
                in: 'query',
                schema: {
                    type: 'integer',
                    default: 20,
                    minimum: 1,
                    maximum: 100,
                },
            },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
        );
    return {
        operationId:
            method +
            path.replace(/[^a-zA-Z0-9]+(.)/g, (_, next: string) =>
                next.toUpperCase(),
            ),
        tags: ['Shopping'],
        summary: body ? 'Registrar alteração em compras' : 'Consultar compras',
        description:
            'Dados privados do espaço. Escritas exigem espaço e lista ativos, versão vigente e chave estável. Replay revalida acesso e devolve o resultado original. Histórico preserva quem registrou no aplicativo. Consultas usam snapshot curto e cursores vinculados ao contexto e filtros; listas seguem criação/ID e histórico segue sequência/ID crescentes.',
        security: [{ sessionCookie: [] }],
        parameters,
        ...(body
            ? {
                  requestBody: {
                      required: true,
                      content: { 'application/json': { schema: ref(body) } },
                  },
              }
            : {}),
        responses: Object.fromEntries(
            [
                [
                    method === 'post' && path.endsWith('/shopping-lists')
                        ? '201'
                        : '200',
                    result,
                ],
                ...['400', '401', '403', '404', '409', '500'].map((status) => [
                    status,
                    'ErrorResponse',
                ]),
            ].map(([status, schema]) => [
                status,
                {
                    description:
                        status === '409'
                            ? 'CONCURRENT_MODIFICATION, IDEMPOTENCY_KEY_REUSED ou SHOPPING_LIST_ARCHIVED'
                            : status === '400'
                              ? 'VALIDATION_ERROR com campo útil em português'
                              : 'Resultado da operação',
                    headers: {
                        'Cache-Control': {
                            schema: { type: 'string', enum: ['no-store'] },
                        },
                    },
                    content: { 'application/json': { schema: ref(schema) } },
                },
            ]),
        ),
    };
}
const base = '/v2/spaces/{spaceId}/shopping-lists';
export const shoppingOpenApi: Pick<
    OpenAPIObject,
    'tags' | 'paths' | 'components'
> = {
    tags: [{ name: 'Shopping', description: 'Listas de compras por espaço.' }],
    paths: {
        [base]: {
            post: shoppingOperation(
                'post',
                base,
                'ShoppingList',
                'ShoppingCreateList',
            ),
            get: shoppingOperation('get', base, 'ShoppingListPage'),
        },
        [`${base}/{listId}`]: {
            get: shoppingOperation(
                'get',
                `${base}/{listId}`,
                'ShoppingListDetail',
            ),
        },
        [`${base}/{listId}/name`]: {
            post: shoppingOperation(
                'post',
                `${base}/{listId}/name`,
                'ShoppingList',
                'ShoppingRenameList',
            ),
        },
        [`${base}/{listId}/history`]: {
            get: shoppingOperation(
                'get',
                `${base}/{listId}/history`,
                'ShoppingHistoryPage',
            ),
        },
    },
    components: { schemas: shoppingSchemas },
};
shoppingOpenApi.paths[base]!.get!.parameters!.push({
    name: 'status',
    in: 'query',
    schema: {
        type: 'string',
        enum: ['ACTIVE', 'ARCHIVED', 'ALL'],
        default: 'ACTIVE',
    },
});
