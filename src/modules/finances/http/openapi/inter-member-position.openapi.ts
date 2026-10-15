import type {
    OpenAPIObject,
    SchemaObject,
    ReferenceObject,
    ResponseObject,
} from '@nestjs/swagger';
const ref = (name: string): ReferenceObject => ({
    $ref: `#/components/schemas/${name}`,
});
const object = (
    properties: Record<string, SchemaObject | ReferenceObject>,
): SchemaObject => ({
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
});
const uuid: SchemaObject = { type: 'string', format: 'uuid' },
    date: SchemaObject = { type: 'string', format: 'date' };
const money: SchemaObject = {
    type: 'integer',
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
};
const total: SchemaObject = {
    type: 'string',
    pattern: '^(0|[1-9][0-9]*)$',
    description:
        'Centavos inteiros exatos, inclusive acima do inteiro seguro JavaScript.',
};
const direction: SchemaObject = {
    type: 'string',
    enum: ['ALL', 'PAYABLE', 'RECEIVABLE'],
};
const response = (
    schema: SchemaObject | ReferenceObject,
    description: string,
): ResponseObject => ({
    description,
    headers: {
        'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
    },
    content: { 'application/json': { schema } },
});
const error = (...codes: string[]) =>
    response(
        {
            allOf: [
                ref('ErrorResponse'),
                {
                    type: 'object',
                    properties: { code: { type: 'string', enum: codes } },
                },
            ],
        },
        codes.join(', '),
    );
export const interMemberPositionOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        '/v2/spaces/{spaceId}/inter-member-position': {
            get: {
                operationId: 'getInterMemberPosition',
                tags: ['Finances'],
                summary:
                    'Consultar pendências abertas e posição líquida informativa',
                description:
                    'Todas as pendências OPEN com valor aberto positivo, sem período implícito. Direção filtra linhas; totais abrangem o recorte inteiro. Consulta não compensa nem escreve fatos. Totais e página compartilham snapshot por resposta; não há snapshot entre páginas. Rejeita query desconhecida, duplicada ou cursor inválido.',
                security: [{ sessionCookie: [] }],
                parameters: [
                    {
                        name: 'spaceId',
                        in: 'path',
                        required: true,
                        schema: uuid,
                    },
                    {
                        name: 'direction',
                        in: 'query',
                        required: false,
                        schema: { ...direction, default: 'ALL' },
                    },
                    {
                        name: 'cursor',
                        in: 'query',
                        required: false,
                        schema: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 512,
                        },
                        description:
                            'Cursor opaco versionado vinculado à pessoa autenticada, espaço, direção e última chave registeredAt/id; precisão de microssegundos.',
                    },
                ],
                responses: {
                    200: response(
                        ref('InterMemberPositionResponse'),
                        'Posição autorizada; BALANCED com brutos positivos conserva pendências abertas.',
                    ),
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
    components: {
        schemas: {
            InterMemberObligationOrigin: {
                oneOf: [
                    object({
                        kind: { type: 'string', enum: ['EXPENSE'] },
                        commitmentId: uuid,
                        externalLiabilityId: uuid,
                        description: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 160,
                        },
                    }),
                    object({
                        commitmentId: uuid,
                        disbursementId: uuid,
                        description: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 160,
                        },
                    }),
                    object({
                        kind: { type: 'string', enum: ['INCOME'] },
                        commitmentId: uuid,
                        receiptId: uuid,
                        description: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 160,
                        },
                    }),
                ],
            },
            OpenInterMemberObligation: object({
                id: uuid,
                version: { ...money, minimum: 1 },
                status: { type: 'string', enum: ['OPEN', 'PARTIALLY_SETTLED'] },
                debtorMemberId: uuid,
                creditorMemberId: uuid,
                originalAmountInCents: { ...money, minimum: 1 },
                recognizedAmountInCents: { ...money, minimum: 1 },
                remainingAmountInCents: { ...money, minimum: 1 },
                factDate: date,
                registeredAt: { type: 'string', format: 'date-time' },
                origin: ref('InterMemberObligationOrigin'),
                settlementCycle: {
                    oneOf: [
                        { type: 'null' },
                        object({
                            id: uuid,
                            targetDate: date,
                            status: {
                                type: 'string',
                                enum: ['OPEN', 'FINALIZED'],
                            },
                        }),
                    ],
                },
            }),
            InterMemberPositionResponse: object({
                spaceId: uuid,
                spaceStatus: {
                    type: 'string',
                    enum: ['ACTIVE', 'CLOSING', 'CLOSED'],
                },
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
                scope: { type: 'string', enum: ['OPEN_OBLIGATIONS'] },
                summary: object({
                    payableAmountInCents: total,
                    receivableAmountInCents: total,
                    net: {
                        oneOf: [
                            object({
                                direction: {
                                    type: 'string',
                                    enum: ['PAYABLE', 'RECEIVABLE'],
                                },
                                amountInCents: {
                                    ...total,
                                    pattern: '^[1-9][0-9]*$',
                                },
                            }),
                            object({
                                direction: {
                                    type: 'string',
                                    enum: ['BALANCED'],
                                },
                                amountInCents: { type: 'string', enum: ['0'] },
                            }),
                        ],
                    },
                }),
                items: {
                    type: 'array',
                    maxItems: 20,
                    items: ref('OpenInterMemberObligation'),
                },
                page: object({
                    direction,
                    pageSize: { type: 'integer', enum: [20] },
                    nextCursor: {
                        oneOf: [
                            { type: 'null' },
                            { type: 'string', minLength: 1, maxLength: 512 },
                        ],
                    },
                }),
            }),
        },
    },
};
