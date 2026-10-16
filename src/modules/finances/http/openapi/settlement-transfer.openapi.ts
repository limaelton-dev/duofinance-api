import type {
    OpenAPIObject,
    ReferenceObject,
    SchemaObject,
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
    required: Object.keys(properties).filter(
        (name) =>
            ![
                'reversedAmountInCents',
                'effectiveAmountInCents',
                'reversalId',
            ].includes(name),
    ),
    properties,
});
const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const date: SchemaObject = { type: 'string', format: 'date' };
const instant: SchemaObject = { type: 'string', format: 'date-time' };
const money: SchemaObject = {
    type: 'integer',
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
};
const total: SchemaObject = { type: 'string', pattern: '^(0|[1-9][0-9]*)$' };
const nullable = (schema: SchemaObject | ReferenceObject): SchemaObject => ({
    oneOf: [schema, { type: 'null' }],
});
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
const space = {
    name: 'spaceId',
    in: 'path' as const,
    required: true,
    schema: uuid,
};
const optionalUuid = (name: string) => ({
    name,
    in: 'query' as const,
    required: false,
    schema: uuid,
});
const cursor = {
    name: 'cursor',
    in: 'query' as const,
    required: false,
    schema: { type: 'string' as const, minLength: 1, maxLength: 512 },
};
const member = object({
    memberId: uuid,
    personId: uuid,
    displayName: { type: 'string' },
});
const context = {
    spaceId: uuid,
    spaceStatus: {
        type: 'string' as const,
        enum: ['ACTIVE', 'CLOSING', 'CLOSED'],
    },
    actorMemberId: uuid,
    members: { type: 'array' as const, items: member },
};
const origin = ref('InterMemberObligationOrigin');
const transfer = object({
    id: uuid,
    payerMemberId: uuid,
    recipientMemberId: uuid,
    amountInCents: money,
    reversedAmountInCents: { ...money, minimum: 0 },
    effectiveAmountInCents: { ...money, minimum: 0 },
    reversalId: nullable(uuid),
    factDate: date,
    registeredAt: instant,
    createdByPersonId: uuid,
    mode: { type: 'string', enum: ['MANUAL'] },
});
const allocation = object({
    id: uuid,
    obligationId: uuid,
    cycleId: nullable(uuid),
    amountInCents: money,
    reversedAmountInCents: { ...money, minimum: 0 },
    effectiveAmountInCents: { ...money, minimum: 0 },
    origin,
});
const fact = {
    spaceId: uuid,
    transfer,
    allocations: { type: 'array' as const, minItems: 1, items: allocation },
    affectedCycleIds: { type: 'array' as const, items: uuid },
};
const option = object({
    id: uuid,
    version: money,
    status: { type: 'string', enum: ['OPEN', 'PARTIALLY_SETTLED'] },
    debtorMemberId: uuid,
    creditorMemberId: uuid,
    originalAmountInCents: money,
    recognizedAmountInCents: money,
    remainingAmountInCents: money,
    factDate: date,
    registeredAt: instant,
    origin,
    settlementCycle: nullable(
        object({
            id: uuid,
            targetDate: date,
            status: { type: 'string', enum: ['OPEN'] },
        }),
    ),
});
const direction = { type: 'string' as const, enum: ['PAYABLE', 'RECEIVABLE'] };
const position = object({
    payableAmountInCents: total,
    receivableAmountInCents: total,
    net: object({
        direction: {
            type: 'string',
            enum: ['PAYABLE', 'RECEIVABLE', 'BALANCED'],
        },
        amountInCents: total,
    }),
});
const page = (properties: Record<string, SchemaObject | ReferenceObject>) =>
    object({
        ...properties,
        pageSize: { type: 'integer', enum: [20] },
        nextCursor: nullable({ type: 'string' }),
    });
const errors = {
    400: error('VALIDATION_ERROR'),
    401: error('UNAUTHENTICATED'),
    404: error('SPACE_NOT_FOUND'),
    409: error('SHARED_SPACE_REQUIRED'),
    429: error('TOO_MANY_REQUESTS'),
    500: error('INTERNAL_ERROR'),
};
export const settlementTransferOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        '/v2/spaces/{spaceId}/settlement-transfers/options': {
            get: {
                operationId: 'getSettlementTransferOptions',
                tags: ['Finances'],
                summary:
                    'Consultar pendências elegíveis para transferência manual',
                security: [{ sessionCookie: [] }],
                parameters: [
                    space,
                    {
                        name: 'direction',
                        in: 'query',
                        required: false,
                        schema: { ...direction, default: 'PAYABLE' },
                    },
                    optionalUuid('cycleId'),
                    cursor,
                ],
                responses: {
                    ...errors,
                    404: error('SPACE_NOT_FOUND', 'SETTLEMENT_CYCLE_NOT_FOUND'),
                    200: response(
                        ref('SettlementTransferOptions'),
                        'Pendências elegíveis e resumo completo da direção.',
                    ),
                },
            },
        },
        '/v2/spaces/{spaceId}/settlement-transfers': {
            post: {
                operationId: 'recordManualSettlementTransfer',
                tags: ['Finances'],
                summary:
                    'Registrar transferência manual com distribuição integral',
                security: [{ sessionCookie: [] }],
                parameters: [
                    space,
                    {
                        name: 'X-CSRF-Token',
                        in: 'header',
                        required: true,
                        schema: { type: 'string' },
                    },
                    {
                        name: 'Idempotency-Key',
                        in: 'header',
                        required: true,
                        schema: uuid,
                    },
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: ref(
                                'RecordManualSettlementTransferRequest',
                            ),
                        },
                    },
                },
                responses: {
                    ...errors,
                    200: response(
                        ref('RecordManualSettlementTransferResponse'),
                        'Replay autorizado.',
                    ),
                    201: response(
                        ref('RecordManualSettlementTransferResponse'),
                        'Transferência e alocações confirmadas.',
                    ),
                    403: error('INVALID_CSRF_TOKEN'),
                    404: error(
                        'SPACE_NOT_FOUND',
                        'INTER_MEMBER_OBLIGATION_NOT_FOUND',
                    ),
                    409: error(
                        'SHARED_SPACE_REQUIRED',
                        'SPACE_NOT_ACTIVE',
                        'CONCURRENT_MODIFICATION',
                        'SETTLEMENT_CYCLE_FINALIZED',
                        'IDEMPOTENCY_KEY_REUSED',
                    ),
                },
            },
            get: {
                operationId: 'listSettlementTransfers',
                tags: ['Finances'],
                summary: 'Consultar histórico de transferências',
                security: [{ sessionCookie: [] }],
                parameters: [
                    space,
                    optionalUuid('cycleId'),
                    optionalUuid('obligationId'),
                    cursor,
                ],
                responses: {
                    ...errors,
                    404: error(
                        'SPACE_NOT_FOUND',
                        'SETTLEMENT_CYCLE_NOT_FOUND',
                        'INTER_MEMBER_OBLIGATION_NOT_FOUND',
                    ),
                    200: response(
                        ref('SettlementTransferHistory'),
                        'Histórico paginado sem duplicar transferências nos filtros.',
                    ),
                },
            },
        },
        '/v2/spaces/{spaceId}/settlement-transfers/{transferId}': {
            get: {
                operationId: 'getSettlementTransfer',
                tags: ['Finances'],
                summary: 'Consultar transferência e todas as alocações',
                security: [{ sessionCookie: [] }],
                parameters: [
                    space,
                    {
                        name: 'transferId',
                        in: 'path',
                        required: true,
                        schema: uuid,
                    },
                ],
                responses: {
                    ...errors,
                    404: error(
                        'SPACE_NOT_FOUND',
                        'SETTLEMENT_TRANSFER_NOT_FOUND',
                    ),
                    200: response(
                        ref('SettlementTransferDetail'),
                        'Fato histórico completo.',
                    ),
                },
            },
        },
    },
    components: {
        schemas: {
            RecordManualSettlementTransferRequest: object({
                expectedSpaceVersion: money,
                payerMemberId: uuid,
                recipientMemberId: uuid,
                amountInCents: money,
                factDate: date,
                allocations: {
                    type: 'array',
                    minItems: 1,
                    items: object({
                        obligationId: uuid,
                        expectedObligationVersion: money,
                        amountInCents: money,
                    }),
                },
            }),
            RecordManualSettlementTransferResponse: object({
                ...fact,
                replayed: { type: 'boolean' },
            }),
            SettlementTransferDetail: object({
                ...fact,
                spaceStatus: context.spaceStatus,
                actorMemberId: uuid,
                members: context.members,
            }),
            SettlementTransferHistory: object({
                ...context,
                items: {
                    type: 'array',
                    maxItems: 20,
                    items: object({
                        ...fact,
                        appliedAmountInCentsInFilter: money,
                    }),
                },
                page: page({
                    cycleId: nullable(uuid),
                    obligationId: nullable(uuid),
                }),
            }),
            SettlementTransferOptions: object({
                ...context,
                spaceVersion: money,
                referenceDate: date,
                canRecord: { type: 'boolean' },
                summary: position,
                items: { type: 'array', maxItems: 20, items: option },
                page: page({ direction, cycleId: nullable(uuid) }),
            }),
        },
    },
};
