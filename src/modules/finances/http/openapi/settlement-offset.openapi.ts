import type {
    OpenAPIObject,
    OperationObject,
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
    required: Object.keys(properties).filter(
        (name) => name !== 'compensatedAmountInCents',
    ),
    properties,
});
const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const date: SchemaObject = { type: 'string', format: 'date' };
const amount: SchemaObject = {
    type: 'integer',
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
};
const total: SchemaObject = { type: 'string', pattern: '^(0|[1-9][0-9]*)$' };
const nullable = (schema: SchemaObject | ReferenceObject): SchemaObject => ({
    oneOf: [schema, { type: 'null' }],
});
const ids: SchemaObject = {
    type: 'array',
    maxItems: 50,
    uniqueItems: true,
    items: uuid,
};
const scope = object({ cycleIds: ids, obligationIds: ids });
scope.anyOf = [
    { properties: { cycleIds: { minItems: 1 } } },
    { properties: { obligationIds: { minItems: 1 } } },
];
scope.description =
    'Seleção explícita de ciclos ou pendências, incluindo avulsas. Pelo menos uma lista contém IDs; a união dos ciclos envolvidos admite até 50 referências. Nada fora da seleção é aplicado.';
const cycle = object({
    id: uuid,
    version: amount,
    targetDate: date,
    status: { type: 'string', enum: ['OPEN', 'FINALIZED'] },
});
const requestedAllocation = object({
    obligationId: uuid,
    expectedObligationVersion: amount,
    amountInCents: amount,
});
const origin = ref('SettlementOffsetOrigin');
const allocation = object({
    id: uuid,
    obligationId: uuid,
    cycleId: nullable(uuid),
    debtorMemberId: uuid,
    creditorMemberId: uuid,
    amountInCents: amount,
    origin,
});
const fact = {
    spaceId: uuid,
    offset: object({
        id: uuid,
        amountInCents: {
            ...amount,
            description:
                'Valor compensado em cada direção: A→B 35000 e B→A 8000 geram compensação 8000, duas aplicações de 8000 e restante A→B 27000. Não representa transferência de dinheiro.',
        },
        factDate: date,
        registeredAt: { type: 'string' as const, format: 'date-time' },
        createdByPersonId: uuid,
    }),
    allocations: {
        type: 'array' as const,
        minItems: 2,
        maxItems: 50,
        items: allocation,
    },
    affectedCycleIds: {
        type: 'array' as const,
        uniqueItems: true,
        items: uuid,
    },
    replayed: { type: 'boolean' as const },
};
const context = {
    spaceId: uuid,
    spaceStatus: {
        type: 'string' as const,
        enum: ['ACTIVE', 'CLOSING', 'CLOSED'],
    },
    actorMemberId: uuid,
    members: {
        type: 'array' as const,
        items: object({
            memberId: uuid,
            personId: uuid,
            displayName: { type: 'string' },
        }),
    },
};
const direction: SchemaObject = {
    type: 'string',
    enum: ['ALL', 'PAYABLE', 'RECEIVABLE'],
};
const page = (properties: Record<string, SchemaObject | ReferenceObject>) =>
    object({
        ...properties,
        pageSize: { type: 'integer', enum: [20] },
        nextCursor: nullable({ type: 'string' }),
    });
const response = (schema: string, description: string): ResponseObject => ({
    description,
    headers: {
        'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
    },
    content: { 'application/json': { schema: ref(schema) } },
});
const errors = {
    400: response(
        'ErrorResponse',
        'VALIDATION_ERROR: revise o campo informado.',
    ),
    401: response('ErrorResponse', 'UNAUTHENTICATED.'),
    403: response('ErrorResponse', 'INVALID_CSRF_TOKEN.'),
    404: response(
        'ErrorResponse',
        'Espaço, ciclo, pendência ou compensação inexistente ou inacessível.',
    ),
    409: response(
        'ErrorResponse',
        'CONCURRENT_MODIFICATION exige releitura; SETTLEMENT_CYCLE_FINALIZED bloqueia aplicação; IDEMPOTENCY_KEY_REUSED exige a chave e entrada originais.',
    ),
    429: response('ErrorResponse', 'TOO_MANY_REQUESTS.'),
    500: response('ErrorResponse', 'INTERNAL_ERROR, sem aplicação parcial.'),
};
const space = {
    name: 'spaceId',
    in: 'path' as const,
    required: true,
    schema: uuid,
};
const cursor = {
    name: 'cursor',
    in: 'query' as const,
    required: false,
    schema: { type: 'string' as const, minLength: 1, maxLength: 512 },
    description: 'Cursor opaco vinculado ao ator, espaço e filtros originais.',
};
const optionalId = (name: string) => ({
    name,
    in: 'query' as const,
    required: false,
    schema: uuid,
});
const operation = (
    operationId: string,
    summary: string,
    schema: string,
): OperationObject => ({
    operationId,
    tags: ['Finances'],
    summary,
    security: [{ sessionCookie: [] }],
    parameters: [space],
    responses: { ...errors, 200: response(schema, 'Consulta autorizada.') },
});
const options = operation(
    'getSettlementOffsetOptions',
    'Consultar compensação possível no escopo explícito sem resolver pendências',
    'SettlementOffsetOptions',
);
options.parameters?.push(
    ...['cycleIds', 'obligationIds'].map((name) => ({
        name,
        in: 'query' as const,
        required: false,
        schema: { type: 'string' as const, maxLength: 1849 },
        description:
            'Até 50 UUIDs separados por vírgula, sem duplicatas. Informe ao menos uma das listas do escopo.',
    })),
    {
        name: 'direction',
        in: 'query',
        required: false,
        schema: { ...direction, default: 'ALL' },
    },
    cursor,
);
const history = operation(
    'listSettlementOffsets',
    'Consultar histórico de compensações por ciclo ou pendência',
    'SettlementOffsetHistory',
);
history.parameters?.push(
    optionalId('cycleId'),
    optionalId('obligationId'),
    cursor,
);
const detail = operation(
    'getSettlementOffset',
    'Consultar compensação e aplicações históricas completas',
    'SettlementOffsetDetail',
);
detail.parameters?.push({
    name: 'offsetId',
    in: 'path',
    required: true,
    schema: uuid,
});
const record = operation(
    'recordSettlementOffset',
    'Confirmar aplicações equivalentes nas duas direções sem transferência de caixa',
    'RecordSettlementOffsetResponse',
);
record.parameters?.push(
    {
        name: 'X-CSRF-Token',
        in: 'header',
        required: true,
        schema: { type: 'string' },
    },
    { name: 'Idempotency-Key', in: 'header', required: true, schema: uuid },
);
record.requestBody = {
    required: true,
    content: {
        'application/json': { schema: ref('RecordSettlementOffsetRequest') },
    },
};
record.responses = {
    ...errors,
    200: response('RecordSettlementOffsetResponse', 'Replay autorizado.'),
    201: response(
        'RecordSettlementOffsetResponse',
        'Compensação, aplicações, histórico, recibo e auditoria confirmados atomicamente.',
    ),
};

export const settlementOffsetOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        '/v2/spaces/{spaceId}/settlement-offsets/options': { get: options },
        '/v2/spaces/{spaceId}/settlement-offsets': {
            post: record,
            get: history,
        },
        '/v2/spaces/{spaceId}/settlement-offsets/{offsetId}': { get: detail },
    },
    components: {
        schemas: {
            SettlementOffsetOrigin: {
                oneOf: [
                    object({
                        kind: { type: 'string', enum: ['EXPENSE'] },
                        commitmentId: uuid,
                        disbursementId: uuid,
                        description: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 160,
                        },
                    }),
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
            SettlementOffsetOpenObligation: object({
                id: uuid,
                version: amount,
                status: { type: 'string', enum: ['OPEN', 'PARTIALLY_SETTLED'] },
                debtorMemberId: uuid,
                creditorMemberId: uuid,
                originalAmountInCents: amount,
                recognizedAmountInCents: amount,
                remainingAmountInCents: amount,
                compensatedAmountInCents: {
                    type: 'integer',
                    minimum: 0,
                    maximum: Number.MAX_SAFE_INTEGER,
                },
                factDate: date,
                registeredAt: { type: 'string', format: 'date-time' },
                origin,
                settlementCycle: nullable(
                    object({
                        id: uuid,
                        targetDate: date,
                        status: { type: 'string', enum: ['OPEN', 'FINALIZED'] },
                    }),
                ),
            }),
            SettlementOffsetScope: scope,
            RecordSettlementOffsetRequest: object({
                expectedSpaceVersion: amount,
                factDate: date,
                scope: ref('SettlementOffsetScope'),
                expectedCycleVersions: {
                    type: 'array',
                    maxItems: 50,
                    items: object({ cycleId: uuid, version: amount }),
                },
                allocations: {
                    type: 'array',
                    minItems: 2,
                    maxItems: 50,
                    items: requestedAllocation,
                },
            }),
            RecordSettlementOffsetResponse: object(fact),
            SettlementOffsetDetail: object(fact),
            SettlementOffsetOptions: object({
                ...context,
                spaceVersion: amount,
                referenceDate: date,
                canRecord: { type: 'boolean' },
                scope: ref('SettlementOffsetScope'),
                cycles: { type: 'array', maxItems: 50, items: cycle },
                maximumAmountInCents: {
                    ...total,
                    description:
                        'Menor saldo entre as duas direções elegíveis, limitado a 9007199254740991 centavos por fato de compensação. Abrange o escopo inteiro, independentemente da página.',
                },
                reason: nullable({
                    type: 'string',
                    enum: [
                        'NO_RECIPROCAL_OBLIGATIONS',
                        'SPACE_CLOSED',
                        'SETTLEMENT_CYCLE_FINALIZED',
                    ],
                }),
                items: {
                    type: 'array',
                    maxItems: 20,
                    items: ref('SettlementOffsetOpenObligation'),
                },
                page: page({ direction }),
                preview: object({
                    amountInCents: total,
                    allocations: {
                        type: 'array',
                        maxItems: 40,
                        items: requestedAllocation,
                    },
                    complete: {
                        type: 'boolean',
                        description:
                            'Indica se a prévia de até 20 pendências por direção cobre o máximo do escopo inteiro. A confirmação sempre envia aplicações explícitas.',
                    },
                }),
            }),
            SettlementOffsetHistory: object({
                spaceId: uuid,
                items: {
                    type: 'array',
                    maxItems: 20,
                    items: object({
                        ...fact,
                        appliedAmountInCentsInFilter: {
                            ...total,
                            description:
                                'Soma das aplicações no filtro. As duas direções de uma compensação de 8000 podem somar 16000; não representa dinheiro transferido.',
                        },
                    }),
                },
                page: page({
                    cycleId: nullable(uuid),
                    obligationId: nullable(uuid),
                }),
            }),
        },
    },
};
