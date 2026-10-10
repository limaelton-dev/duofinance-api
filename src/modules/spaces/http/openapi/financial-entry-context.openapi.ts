import type {
    OpenAPIObject,
    SchemaObject,
    ReferenceObject,
    ResponseObject,
} from '@nestjs/swagger';
const object = (
    properties: Record<string, SchemaObject | ReferenceObject>,
): SchemaObject => ({
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
});
const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const error = (code: string): ResponseObject => ({
    description: code,
    headers: {
        'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
    },
    content: {
        'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponse' },
            example: {
                code,
                message:
                    code === 'SPACE_NOT_FOUND'
                        ? 'Espaço não encontrado.'
                        : 'Não foi possível processar esta solicitação.',
                details: {},
            },
        },
    },
});
export const financialContextSchema = object({
    spaceId: uuid,
    type: { type: 'string', enum: ['SHARED'] },
    status: { type: 'string', enum: ['ACTIVE', 'CLOSING', 'CLOSED'] },
    version: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    actorMemberId: uuid,
    members: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: object({
            memberId: uuid,
            personId: uuid,
            displayName: { type: 'string' },
        }),
    },
});
export const financialEntryContextOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        '/v2/spaces/{spaceId}/financial-entry-context': {
            get: {
                operationId: 'getFinancialEntryContext',
                tags: ['Spaces'],
                summary:
                    'Consultar participantes autorizados para registro financeiro',
                description:
                    'Leitura independente das opções financeiras. Não cria fatos nem concede acesso de escrita; o comando revalida contexto e versão.',
                security: [{ sessionCookie: [] }],
                parameters: [
                    {
                        name: 'spaceId',
                        in: 'path',
                        required: true,
                        schema: uuid,
                    },
                ],
                responses: {
                    200: {
                        description:
                            'Contexto autorizado sem e-mails, credenciais ou convites.',
                        headers: {
                            'Cache-Control': {
                                schema: { type: 'string', enum: ['no-store'] },
                            },
                        },
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: '#/components/schemas/SpaceFinancialContext',
                                },
                            },
                        },
                    },
                    400: error('VALIDATION_ERROR'),
                    401: error('UNAUTHENTICATED'),
                    404: error('SPACE_NOT_FOUND'),
                    409: error('SHARED_SPACE_REQUIRED'),
                    429: {
                        ...error('TOO_MANY_REQUESTS'),
                        headers: {
                            'Retry-After': {
                                schema: { type: 'integer', minimum: 1 },
                            },
                        },
                    },
                    500: error('INTERNAL_ERROR'),
                },
            },
        },
    },
    components: { schemas: { SpaceFinancialContext: financialContextSchema } },
};
