import type {
    OpenAPIObject,
    SchemaObject,
    ReferenceObject,
} from '@nestjs/swagger';
const object = (
    properties: Record<string, SchemaObject | ReferenceObject>,
): SchemaObject => ({
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
});
const uuid: SchemaObject = { type: 'string', format: 'uuid' },
    date: SchemaObject = { type: 'string', format: 'date' },
    text: SchemaObject = { type: 'string' },
    total: SchemaObject = { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
    money: SchemaObject = {
        type: 'integer',
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
    };
const nullable = (schema: SchemaObject): SchemaObject => ({
    oneOf: [schema, { type: 'null' }],
});
const itemProperties = {
    id: uuid,
    type: {
        type: 'string',
        enum: [
            'EXPENSE',
            'EXPECTED_INCOME',
            'DISBURSEMENT',
            'RECEIPT',
            'EXTERNAL_LIABILITY',
            'EXTERNAL_SETTLEMENT',
            'INTERNAL_TRANSFER',
            'INTERNAL_OFFSET',
            'INTERNAL_WAIVER',
        ],
    } as SchemaObject,
    commitmentId: nullable(uuid),
    externalLiabilityId: nullable(uuid),
    description: text,
    amountInCents: money,
    relevantDate: date,
    dateNature: {
        type: 'string',
        enum: ['EXPECTED', 'ACTUAL'],
    } as SchemaObject,
    registeredAt: { type: 'string', format: 'date-time' } as SchemaObject,
    recordedByPersonId: uuid,
    participantMemberId: nullable(uuid),
    participantPersonId: nullable(uuid),
    recipientMemberId: nullable(uuid),
    memberIds: { type: 'array', items: uuid } as SchemaObject,
};
const metricProperties = Object.fromEntries(
    [
        'expenseAmountInCents',
        'realizedIncomeAmountInCents',
        'paidAmountInCents',
        'receivedAmountInCents',
        'assumedAmountInCents',
        'externalSettledAmountInCents',
        'disbursedAmountInCents',
        'supportedAmountInCents',
        'internalTransfersSentAmountInCents',
        'internalTransfersReceivedAmountInCents',
    ].map((name) => [name, total]),
);
metricProperties.economicResultInCents = {
    type: 'string',
    pattern: '^-?(0|[1-9][0-9]*)$',
};
const common = {
    spaceId: uuid,
    spaceType: { type: 'string', enum: ['PERSONAL', 'SHARED'] } as SchemaObject,
    month: {
        type: 'string',
        pattern: '^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$',
    } as SchemaObject,
    referenceDate: date,
    memberId: nullable(uuid),
    members: {
        type: 'array',
        maxItems: 2,
        items: object({ memberId: uuid, personId: uuid, displayName: text }),
    } as SchemaObject,
};
const cursor = nullable({ type: 'string', minLength: 1, maxLength: 1024 });
const schemas = {
    FinancialTimelineResponse: object({
        ...common,
        view: { type: 'string', enum: ['CALENDAR', 'HISTORY'] },
        items: { type: 'array', maxItems: 20, items: object(itemProperties) },
        nextCursor: cursor,
    }),
    FinancialForecastResponse: object({
        ...common,
        items: {
            type: 'array',
            maxItems: 20,
            items: object({
                ...itemProperties,
                type: { type: 'string', enum: ['EXPECTED_INCOME'] },
                receivedAmountInCents: money,
                remainingAmountInCents: money,
            }),
        },
        totals: object({
            expectedAmountInCents: total,
            receivedAmountInCents: total,
            remainingAmountInCents: total,
        }),
        nextCursor: cursor,
    }),
    FinancialOverviewResponse: object({
        ...common,
        totals: object(metricProperties),
        byMember: {
            type: 'array',
            maxItems: 2,
            items: object({ memberId: uuid, ...metricProperties }),
        },
        currentExternalLiabilities: object({
            referenceDate: date,
            outstandingAmountInCents: total,
            byMember: {
                type: 'array',
                maxItems: 2,
                items: object({
                    memberId: uuid,
                    outstandingAmountInCents: total,
                }),
            },
        }),
    }),
};
export const financialReviewOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: Object.fromEntries(
        ['timeline', 'forecast', 'overview'].map((operation) => [
            `/v2/spaces/{spaceId}/financial-${operation}`,
            {
                get: {
                    operationId: `getFinancial${operation[0].toUpperCase() + operation.slice(1)}`,
                    tags: ['Finances'],
                    summary: `Consultar ${operation} financeiro por mês calendário`,
                    description:
                        'Somente leitura. Datas civis; referência em America/Sao_Paulo. memberId seleciona membro autorizado apenas no compartilhado. Overview: totals do espaço sem filtro ou do membro selecionado; byMember.expense é responsabilidade e realizedIncome é participação acumulada realizada, received é dinheiro recebido. Aberto atual abrange todas as datas e possui referência própria. Forecast usa apenas receitas conhecidas pendentes com previsão a partir da referência, total original/recebido/restante de todos os compromissos selecionados, sem mover atrasos. Timeline conserva montantes originais e fatos independentes; previsão permanece na data original. CALENDAR e HISTORY usam os mesmos fatos, apresentação agrupável por relevantDate. Página de 20; cursor vincula ator/espaço/operação/visão/mês/membro. Snapshot único por resposta, sem snapshot entre páginas. Sem agregados novos e sem escrita.',
                    security: [{ sessionCookie: [] }],
                    parameters: [
                        {
                            name: 'spaceId',
                            in: 'path',
                            required: true,
                            schema: uuid,
                        },
                        {
                            name: 'month',
                            in: 'query',
                            required: true,
                            schema: common.month,
                        },
                        {
                            name: 'memberId',
                            in: 'query',
                            required: false,
                            schema: uuid,
                        },
                        ...(operation === 'timeline'
                            ? [
                                  {
                                      name: 'view',
                                      in: 'query',
                                      required: true,
                                      schema: {
                                          type: 'string',
                                          enum: ['CALENDAR', 'HISTORY'],
                                      },
                                  },
                              ]
                            : []),
                        ...(operation !== 'overview'
                            ? [
                                  {
                                      name: 'cursor',
                                      in: 'query',
                                      required: false,
                                      schema: {
                                          type: 'string',
                                          minLength: 1,
                                          maxLength: 1024,
                                      },
                                  },
                              ]
                            : []),
                    ],
                    responses: {
                        200: {
                            description:
                                'Consulta autorizada com valores exatos. Itens monetários inteiros seguros; totais em strings de centavos.',
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
                                        $ref: `#/components/schemas/Financial${operation[0].toUpperCase() + operation.slice(1)}Response`,
                                    },
                                },
                            },
                        },
                        ...Object.fromEntries(
                            [
                                [400, 'VALIDATION_ERROR'],
                                [401, 'UNAUTHENTICATED'],
                                [404, 'SPACE_NOT_FOUND'],
                                [429, 'TOO_MANY_REQUESTS'],
                                [500, 'INTERNAL_ERROR'],
                            ].map(([status, code]) => [
                                status,
                                {
                                    description: code,
                                    content: {
                                        'application/json': {
                                            schema: {
                                                $ref: '#/components/schemas/ErrorResponse',
                                            },
                                        },
                                    },
                                },
                            ]),
                        ),
                    },
                },
            },
        ]),
    ) as OpenAPIObject['paths'],
    components: { schemas },
};
