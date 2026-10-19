import type {
    OpenAPIObject,
    ReferenceObject,
    ResponseObject,
    SchemaObject,
} from '@nestjs/swagger';
import { todayCompositionSchemas } from './today.schemas.js';

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
const uuid: SchemaObject = { type: 'string', format: 'uuid' };
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

export const todayOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components' | 'tags'
> = {
    tags: [
        { name: 'Today', description: 'Composição autorizada da visão Hoje.' },
    ],
    paths: {
        '/v2/spaces/{spaceId}/today': {
            get: {
                operationId: 'getToday',
                tags: ['Today'],
                summary: 'Consultar Hoje no espaço atual',
                description:
                    'Compõe portas públicas de Finanças, Rotina e Compras com uma referência temporal em America/Sao_Paulo e snapshot por fonte. Preserva finance/routine e acrescenta shopping e blocos ordenados ATTENTION → TODAY → NEXT_SETTLEMENT → UPCOMING → TASKS → SHOPPING, com limites, totais reais e referências navegáveis. Datas de acerto não se tornam vencimentos. Falha técnica isolada preserva as fontes saudáveis; blocos mistos ficam PARTIAL com total desconhecido. Autoriza antes e depois; perda de acesso bloqueia toda resposta. GET não escreve. Atenção de encerramento usa o processo real de Espaços, com indisponibilidade isolada da fonte e referência ao plano.',
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
                    200: response(
                        ref('TodayResponse'),
                        'Contexto autorizado e fonte financeira disponível ou indisponível explicitamente.',
                    ),
                    400: error('VALIDATION_ERROR'),
                    401: error('UNAUTHENTICATED'),
                    404: error('SPACE_NOT_FOUND'),
                    409: error('SHARED_SPACE_REQUIRED'),
                    500: error('INTERNAL_ERROR'),
                },
            },
        },
    },
    components: {
        schemas: {
            ...todayCompositionSchemas,
            TodaySettlementSummary: object({
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
                nextCycle: {
                    oneOf: [ref('SettlementCycleSummary'), { type: 'null' }],
                },
                overdueCycles: object({
                    items: {
                        type: 'array',
                        maxItems: 3,
                        items: ref('SettlementCycleSummary'),
                    },
                    totalCount: { type: 'integer', minimum: 0 },
                }),
            }),
            TodayFinanceAvailable: object({
                status: { type: 'string', enum: ['AVAILABLE'] },
                data: object({
                    upcomingCommitments: object({
                        items: {
                            type: 'array',
                            maxItems: 4,
                            items: {
                                oneOf: [
                                    object({
                                        commitmentId: uuid,
                                        kind: {
                                            type: 'string',
                                            enum: ['INCOME'],
                                        },
                                        description: { type: 'string' },
                                        expectedReceiptDate: {
                                            type: 'string',
                                            format: 'date',
                                        },
                                        amountInCents: {
                                            type: 'integer',
                                            minimum: 1,
                                            maximum: Number.MAX_SAFE_INTEGER,
                                        },
                                        receivedAmountInCents: {
                                            type: 'integer',
                                            minimum: 0,
                                            maximum: Number.MAX_SAFE_INTEGER,
                                        },
                                        remainingAmountInCents: {
                                            type: 'integer',
                                            minimum: 1,
                                            maximum: Number.MAX_SAFE_INTEGER,
                                        },
                                    }),
                                    object({
                                        commitmentId: uuid,
                                        occurrenceId: {
                                            oneOf: [uuid, { type: 'null' }],
                                        },
                                        kind: {
                                            type: 'string',
                                            enum: ['EXPENSE', 'INCOME'],
                                        },
                                        description: { type: 'string' },
                                        expectedDate: {
                                            type: 'string',
                                            format: 'date',
                                        },
                                        amountInCents: {
                                            oneOf: [
                                                {
                                                    type: 'integer',
                                                    minimum: 1,
                                                    maximum:
                                                        Number.MAX_SAFE_INTEGER,
                                                },
                                                { type: 'null' },
                                            ],
                                        },
                                        expectedAmountInCents: {
                                            oneOf: [
                                                {
                                                    type: 'integer',
                                                    minimum: 1,
                                                    maximum:
                                                        Number.MAX_SAFE_INTEGER,
                                                },
                                                { type: 'null' },
                                            ],
                                        },
                                        valuePending: { type: 'boolean' },
                                        fulfilledAmountInCents: {
                                            type: 'integer',
                                            minimum: 0,
                                            maximum: Number.MAX_SAFE_INTEGER,
                                        },
                                        remainingAmountInCents: {
                                            oneOf: [
                                                {
                                                    type: 'integer',
                                                    minimum: 1,
                                                    maximum:
                                                        Number.MAX_SAFE_INTEGER,
                                                },
                                                { type: 'null' },
                                            ],
                                        },
                                        overdue: { type: 'boolean' },
                                    }),
                                ],
                            },
                        },
                        totalCount: { type: 'integer', minimum: 0 },
                    }),
                    settlements: {
                        oneOf: [
                            ref('TodaySettlementSummary'),
                            { type: 'null' },
                        ],
                    },
                }),
            }),
            TodayFinanceUnavailable: object({
                status: { type: 'string', enum: ['UNAVAILABLE'] },
                error: object({
                    code: {
                        type: 'string',
                        enum: ['FINANCE_TODAY_UNAVAILABLE'],
                    },
                    message: {
                        type: 'string',
                        enum: [
                            'Não foi possível carregar as finanças. Tente novamente.',
                        ],
                    },
                }),
            }),
            TodayResponse: object({
                closure: {
                    oneOf: [
                        object({
                            status: { type: 'string', enum: ['AVAILABLE'] },
                            data: {
                                oneOf: [
                                    ref('SpaceClosureView'),
                                    { type: 'null' },
                                ],
                            },
                        }),
                        object({
                            status: { type: 'string', enum: ['UNAVAILABLE'] },
                            error: object({
                                code: {
                                    type: 'string',
                                    enum: ['SPACE_CLOSURE_UNAVAILABLE'],
                                },
                                message: { type: 'string' },
                            }),
                        }),
                    ],
                },
                shopping: ref('TodayShoppingSource'),
                blocks: {
                    type: 'array',
                    minItems: 6,
                    maxItems: 6,
                    items: ref('TodayBlock'),
                },
                capabilities: object({
                    spaceClosureAttention: {
                        type: 'string',
                        enum: ['SUPPORTED'],
                    },
                }),
                routine: {
                    oneOf: [
                        object({
                            status: { type: 'string', enum: ['AVAILABLE'] },
                            data: ref('RoutineAttentionSummary'),
                        }),
                        object({
                            status: { type: 'string', enum: ['UNAVAILABLE'] },
                            error: object({
                                code: {
                                    type: 'string',
                                    enum: ['ROUTINE_TODAY_UNAVAILABLE'],
                                },
                                message: { type: 'string' },
                            }),
                        }),
                    ],
                },
                spaceId: uuid,
                spaceType: { type: 'string', enum: ['PERSONAL', 'SHARED'] },
                spaceStatus: {
                    type: 'string',
                    enum: ['ACTIVE', 'CLOSING', 'CLOSED'],
                },
                referenceDate: {
                    type: 'string',
                    format: 'date',
                    description:
                        'Data civil calculada uma vez no servidor em America/Sao_Paulo.',
                },
                finance: {
                    oneOf: [
                        ref('TodayFinanceAvailable'),
                        ref('TodayFinanceUnavailable'),
                    ],
                    discriminator: {
                        propertyName: 'status',
                        mapping: {
                            AVAILABLE:
                                '#/components/schemas/TodayFinanceAvailable',
                            UNAVAILABLE:
                                '#/components/schemas/TodayFinanceUnavailable',
                        },
                    },
                },
            }),
        },
    },
};
