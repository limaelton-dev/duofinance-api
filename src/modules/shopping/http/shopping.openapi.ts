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
const quantity: SchemaObject = {
    type: 'string',
    pattern: '^(0|[1-9]\\d{0,11})(\\.\\d{1,3})?$',
    description:
        'Decimal exato com até 3 casas e máximo 999999999999.999. Quantidade desejada é positiva; respostas removem zeros fracionários finais.',
};
const unit = nullable({ type: 'string', minLength: 1, maxLength: 30 });
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
    ShoppingListVersion: object({ expectedVersion: version }),
    ShoppingList: object(listProperties),
    ShoppingAddItem: object(
        {
            expectedVersion: version,
            description: { type: 'string', minLength: 1, maxLength: 500 },
            desiredQuantity: quantity,
            unit,
        },
        ['expectedVersion', 'description', 'desiredQuantity'],
    ),
    ShoppingChangeNeed: {
        ...object(
            { expectedVersion: version, desiredQuantity: quantity, unit },
            ['expectedVersion'],
        ),
        anyOf: [{ required: ['desiredQuantity'] }, { required: ['unit'] }],
    },
    ShoppingItem: object({
        id: uuid,
        listId: uuid,
        description: { type: 'string', minLength: 1, maxLength: 500 },
        desiredQuantity: quantity,
        purchasedQuantity: quantity,
        remainingQuantity: quantity,
        unit,
        creator: ref('ShoppingAuthor'),
        createdAt: instant,
        removedAt: nullable(instant),
        status: {
            type: 'string',
            enum: ['PENDING', 'PARTIALLY_PURCHASED', 'PURCHASED', 'REMOVED'],
        },
    }),
    ShoppingItemCommand: object({
        id: uuid,
        version,
        item: ref('ShoppingItem'),
    }),
    ShoppingRecordPurchase: object({ expectedVersion: version, quantity }),
    ShoppingCorrectPurchase: object({ expectedVersion: version, quantity }),
    ShoppingCorrection: object({
        id: uuid,
        listId: uuid,
        itemId: uuid,
        purchaseId: uuid,
        sequence: version,
        previousQuantity: quantity,
        quantity,
        unit,
        correctedBy: ref('ShoppingAuthor'),
        correctedAt: instant,
    }),
    ShoppingCorrectionCommand: object({
        id: uuid,
        version,
        item: ref('ShoppingItem'),
        purchase: ref('ShoppingPurchase'),
        correction: ref('ShoppingCorrection'),
    }),
    ShoppingCorrectionPage: object({
        ...pageProperties,
        id: uuid,
        version,
        purchaseId: uuid,
        items: { type: 'array', items: ref('ShoppingCorrection') },
        totalCount: { type: 'integer', minimum: 0 },
    }),
    ShoppingPurchase: object({
        id: uuid,
        listId: uuid,
        itemId: uuid,
        quantity,
        effectiveQuantity: quantity,
        unit,
        registeredBy: ref('ShoppingAuthor'),
        registeredAt: instant,
    }),
    ShoppingPurchaseCommand: object({
        id: uuid,
        version,
        item: ref('ShoppingItem'),
        purchase: ref('ShoppingPurchase'),
    }),
    ShoppingPurchasePage: object({
        ...pageProperties,
        id: uuid,
        version,
        itemId: uuid,
        items: { type: 'array', items: ref('ShoppingPurchase') },
        totalCount: { type: 'integer', minimum: 0 },
    }),
    ShoppingItemDetail: object({
        id: uuid,
        version,
        item: ref('ShoppingItemView'),
    }),
    ShoppingItemsSlice: object({
        ...pageProperties,
        items: { type: 'array', items: ref('ShoppingItemView') },
        totalCount: { type: 'integer', minimum: 0 },
    }),
    ShoppingItemPage: object({
        ...pageProperties,
        id: uuid,
        version,
        summary: ref('ShoppingSummary'),
        items: { type: 'array', items: ref('ShoppingItemView') },
        totalCount: { type: 'integer', minimum: 0 },
    }),
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
                type: {
                    type: 'string',
                    enum: [
                        'CREATED',
                        'RENAMED',
                        'ITEM_ADDED',
                        'ITEM_NEED_CHANGED',
                        'PURCHASE_RECORDED',
                        'PURCHASE_CORRECTED',
                        'ITEM_REMOVED',
                        'ARCHIVED',
                    ],
                },
                actor: ref('ShoppingAuthor'),
                registeredAt: instant,
                data: { type: 'object', additionalProperties: true },
            }),
        },
    }),
};
shoppingSchemas.ShoppingItemView = object({
    ...shoppingSchemas.ShoppingItem.properties,
    allowedActions: { type: 'array', items: { type: 'string' } },
});
shoppingSchemas.ShoppingListDetail = object({
    ...shoppingSchemas.ShoppingListView.properties,
    items: ref('ShoppingItemsSlice'),
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
                    method === 'post' &&
                    (path.endsWith('/shopping-lists') ||
                        path.endsWith('/items') ||
                        path.endsWith('/purchases'))
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
                            ? 'CONCURRENT_MODIFICATION, IDEMPOTENCY_KEY_REUSED, SHOPPING_LIST_ARCHIVED, SHOPPING_ITEM_REMOVED ou DESIRED_QUANTITY_BELOW_PURCHASED'
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
const itemBase = `${base}/{listId}/items`;
shoppingOpenApi.paths[itemBase] = {
    get: shoppingOperation('get', itemBase, 'ShoppingItemPage'),
    post: shoppingOperation(
        'post',
        itemBase,
        'ShoppingItemCommand',
        'ShoppingAddItem',
    ),
};
shoppingOpenApi.paths[`${itemBase}/{itemId}`] = {
    get: shoppingOperation('get', `${itemBase}/{itemId}`, 'ShoppingItemDetail'),
};
shoppingOpenApi.paths[`${itemBase}/{itemId}/need`] = {
    post: shoppingOperation(
        'post',
        `${itemBase}/{itemId}/need`,
        'ShoppingItemCommand',
        'ShoppingChangeNeed',
    ),
};
shoppingOpenApi.paths[itemBase]!.get!.parameters!.push({
    name: 'status',
    in: 'query',
    schema: {
        type: 'string',
        enum: ['ACTIVE', 'PENDING', 'PURCHASED', 'REMOVED', 'ALL'],
        default: 'ACTIVE',
    },
});
const purchaseBase = `${itemBase}/{itemId}/purchases`;
shoppingOpenApi.paths[purchaseBase] = {
    get: shoppingOperation('get', purchaseBase, 'ShoppingPurchasePage'),
    post: shoppingOperation(
        'post',
        purchaseBase,
        'ShoppingPurchaseCommand',
        'ShoppingRecordPurchase',
    ),
};
const correctionBase = `${purchaseBase}/{purchaseId}/corrections`;
shoppingOpenApi.paths[correctionBase] = {
    get: shoppingOperation('get', correctionBase, 'ShoppingCorrectionPage'),
    post: shoppingOperation(
        'post',
        correctionBase,
        'ShoppingCorrectionCommand',
        'ShoppingCorrectPurchase',
    ),
};
shoppingOpenApi.paths[`${base}/{listId}/archival`] = {
    post: shoppingOperation(
        'post',
        `${base}/{listId}/archival`,
        'ShoppingList',
        'ShoppingListVersion',
    ),
};
shoppingOpenApi.paths[`${itemBase}/{itemId}/removal`] = {
    post: shoppingOperation(
        'post',
        `${itemBase}/{itemId}/removal`,
        'ShoppingItemCommand',
        'ShoppingListVersion',
    ),
};
