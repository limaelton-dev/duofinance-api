import type {
    OpenAPIObject,
    ReferenceObject,
    ResponseObject,
    SchemaObject,
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
                    'Compõe somente contratos públicos. Uma data civil em America/Sao_Paulo por resposta. Próximo acerto é o primeiro OPEN de hoje ou futuro por data-alvo/UUID, inclusive zerado. Atenção traz até três OPEN anteriores com restante bruto positivo e contagem completa, em um snapshot financeiro único. Próximos compromissos permanece vazio no recorte da Wave 1; despesas já pagas e datas de acerto não se tornam vencimentos. Pessoal retorna settlements null sem chamar leitura exclusiva SHARED. Autoriza antes e depois. Falha técnica financeira permite UNAVAILABLE com contexto preservado; acesso, validação e inconsistência mantêm erros HTTP. Não aceita filtros, cursor ou ator do cliente. GET não escreve nem finaliza ciclos.',
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
                        items: { type: 'array', maxItems: 0, items: {} },
                        totalCount: { type: 'integer', enum: [0] },
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
