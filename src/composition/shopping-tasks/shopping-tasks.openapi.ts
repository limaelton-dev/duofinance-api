import type { OpenAPIObject, SchemaObject } from '@nestjs/swagger';

const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const linkedTask: SchemaObject = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: uuid,
        description: { type: 'string' },
        status: { type: 'string', enum: ['PENDING', 'COMPLETED', 'CANCELLED'] },
        createdAt: { type: 'string', format: 'date-time' },
        shoppingListId: uuid,
    },
    required: ['id', 'description', 'status', 'createdAt', 'shoppingListId'],
};
export const shoppingTasksOpenApi: Pick<OpenAPIObject, 'paths' | 'components'> =
    {
        paths: {
            '/v2/spaces/{spaceId}/shopping-lists/{listId}/tasks': {
                get: {
                    operationId: 'getShoppingListTasks',
                    tags: ['Shopping'],
                    summary: 'Consultar tarefas vinculadas à lista',
                    description:
                        'Referências de tarefas avulsas, incluindo concluídas e canceladas. Cursor por espaço, ator e lista, com ordenação por criação e ID. Arquivar a lista preserva suas referências.',
                    security: [{ sessionCookie: [] }],
                    parameters: [
                        ...['spaceId', 'listId'].map((name) => ({
                            name,
                            in: 'path' as const,
                            required: true,
                            schema: uuid,
                        })),
                        {
                            name: 'limit',
                            in: 'query',
                            schema: {
                                type: 'integer',
                                minimum: 1,
                                maximum: 100,
                                default: 20,
                            },
                        },
                        {
                            name: 'cursor',
                            in: 'query',
                            schema: { type: 'string' },
                        },
                    ],
                    responses: Object.fromEntries(
                        ['200', '400', '401', '403', '404', '500'].map(
                            (code) => [
                                code,
                                {
                                    description:
                                        code === '200'
                                            ? 'Tarefas vinculadas'
                                            : 'Erro da operação',
                                    headers: {
                                        'Cache-Control': {
                                            schema: {
                                                type: 'string',
                                                enum: ['no-store'],
                                            },
                                        },
                                    },
                                    content: {
                                        'application/json': {
                                            schema: {
                                                $ref: `#/components/schemas/${code === '200' ? 'ShoppingLinkedTaskPage' : 'ErrorResponse'}`,
                                            },
                                        },
                                    },
                                },
                            ],
                        ),
                    ),
                },
            },
        },
        components: {
            schemas: {
                ShoppingLinkedTaskPage: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        spaceId: uuid,
                        shoppingListId: uuid,
                        items: { type: 'array', items: linkedTask },
                        totalCount: { type: 'integer', minimum: 0 },
                        nextCursor: {
                            oneOf: [{ type: 'string' }, { type: 'null' }],
                        },
                    },
                    required: [
                        'spaceId',
                        'shoppingListId',
                        'items',
                        'totalCount',
                        'nextCursor',
                    ],
                },
            },
        },
    };
