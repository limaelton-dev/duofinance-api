import type {
    OpenAPIObject,
    SchemaObject,
    ReferenceObject,
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
    date: SchemaObject = { type: 'string', format: 'date' },
    positive: SchemaObject = {
        type: 'integer',
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
    };
const common = {
    spaceId: uuid,
    referenceDate: date,
    canSettle: { type: 'boolean' as const },
};
const fact = {
    id: uuid,
    externalLiabilityId: uuid,
    sequence: positive,
    amountInCents: positive,
    factDate: date,
    registeredAt: { type: 'string' as const, format: 'date-time' },
    recordedByPersonId: uuid,
};
const scoped = (
    properties: Record<string, SchemaObject | ReferenceObject>,
): SchemaObject => ({
    oneOf: [
        object({
            ...common,
            ...properties,
            spaceType: { type: 'string', enum: ['PERSONAL'] },
        }),
        object({
            ...common,
            ...properties,
            spaceType: { type: 'string', enum: ['SHARED'] },
            expectedSpaceVersion: positive,
        }),
    ],
});
const response = (name: string, description: string) => ({
    description,
    headers: {
        'Cache-Control': {
            schema: { type: 'string' as const, enum: ['no-store'] },
        },
    },
    content: { 'application/json': { schema: ref(name) } },
});
const error = (...codes: string[]) => ({
    description: codes.join(', '),
    content: {
        'application/json': {
            schema: {
                allOf: [
                    ref('ErrorResponse'),
                    {
                        type: 'object' as const,
                        properties: {
                            code: { type: 'string' as const, enum: codes },
                        },
                    },
                ],
            },
        },
    },
});
const failures = {
    400: error('VALIDATION_ERROR'),
    401: error('UNAUTHENTICATED'),
    403: error('INVALID_CSRF_TOKEN', 'EXTERNAL_LIABILITY_HOLDER_REQUIRED'),
    404: error(
        'SPACE_NOT_FOUND',
        'FINANCIAL_COMMITMENT_NOT_FOUND',
        'EXTERNAL_LIABILITY_NOT_FOUND',
    ),
    409: error(
        'SPACE_NOT_ACTIVE',
        'EXTERNAL_LIABILITY_ALREADY_SETTLED',
        'CONCURRENT_MODIFICATION',
        'EXPENSE_OPTIONS_CHANGED',
        'IDEMPOTENCY_KEY_REUSED',
    ),
    429: error('TOO_MANY_REQUESTS'),
    500: error('INTERNAL_ERROR'),
};
const parameters = ['spaceId', 'commitmentId', 'externalLiabilityId'].map(
    (name) => ({ name, in: 'path' as const, required: true, schema: uuid }),
);
const base =
    '/v2/spaces/{spaceId}/financial-commitments/{commitmentId}/external-liabilities/{externalLiabilityId}';
export const externalLiabilitySettlementOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        '/v2/spaces/{spaceId}/external-liabilities': {
            get: {
                operationId: 'listOpenExternalLiabilities',
                tags: ['Finances'],
                summary:
                    'Consultar obriga\u00e7\u00f5es externas abertas do titular',
                security: [{ sessionCookie: [] }],
                parameters: [
                    parameters[0],
                    {
                        name: 'cursor',
                        in: 'query',
                        required: false,
                        schema: { type: 'string' },
                    },
                ],
                responses: {
                    ...failures,
                    200: response(
                        'OpenExternalLiabilities',
                        'P\u00e1gina de at\u00e9 20 obriga\u00e7\u00f5es pr\u00f3prias, ordenada por data e identidade. Cursor vinculado ao espa\u00e7o e titular.',
                    ),
                },
            },
        },
        [base + '/settlement-options']: {
            get: {
                operationId: 'getExternalLiabilitySettlementOptions',
                tags: ['Finances'],
                summary:
                    'Consultar saldo e permiss\u00e3o para pagamento externo',
                security: [{ sessionCookie: [] }],
                parameters,
                responses: {
                    ...failures,
                    200: response(
                        'ExternalLiabilitySettlementOptions',
                        'Leitura autorizada; somente titular pode liquidar.',
                    ),
                },
            },
        },
        [base + '/settlements']: {
            post: {
                operationId: 'settleExternalLiability',
                tags: ['Finances'],
                summary:
                    'Registrar liquida\u00e7\u00e3o parcial ou total de obriga\u00e7\u00e3o externa',
                description:
                    'Desembolso posterior da obriga\u00e7\u00e3o. Reduz somente saldo externo; preserva pagamento direto, suporte, responsabilidade, pend\u00eancias e ciclos. Valor positivo at\u00e9 o saldo, data civil passada ou atual. Titular e acesso corrente verificados antes do replay. Fato, saldo, vers\u00e3o e recibo na mesma transa\u00e7\u00e3o.',
                security: [{ sessionCookie: [] }],
                parameters: [
                    ...parameters,
                    {
                        name: 'Idempotency-Key',
                        in: 'header',
                        required: true,
                        schema: uuid,
                    },
                    {
                        name: 'X-CSRF-Token',
                        in: 'header',
                        required: true,
                        schema: { type: 'string' },
                    },
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: ref('SettleExternalLiabilityRequest'),
                        },
                    },
                },
                responses: {
                    ...failures,
                    201: {
                        ...response(
                            'ExternalLiabilitySettlementResponse',
                            'Pagamento externo registrado.',
                        ),
                        headers: {
                            Location: { schema: { type: 'string' } },
                            'Cache-Control': {
                                schema: { type: 'string', enum: ['no-store'] },
                            },
                        },
                    },
                    200: response(
                        'ExternalLiabilitySettlementResponse',
                        'Replay hist\u00f3rico autorizado, sem outro fato.',
                    ),
                },
            },
        },
    },
    components: {
        schemas: {
            ExternalLiabilitySettlement: {
                oneOf: [
                    object({ ...fact, holderPersonId: uuid }),
                    object({ ...fact, holderMemberId: uuid }),
                ],
            },
            SettleExternalLiabilityRequest: {
                oneOf: [
                    object({
                        amountInCents: positive,
                        factDate: date,
                        expectedCommitmentVersion: positive,
                    }),
                    object({
                        amountInCents: positive,
                        factDate: date,
                        expectedCommitmentVersion: positive,
                        expectedSpaceVersion: positive,
                    }),
                ],
            },
            ExternalLiabilitySettlementResponse: {
                allOf: [
                    {
                        oneOf: [
                            ref('RecordPersonalExpenseResponse'),
                            ref('RecordSharedCashExpenseResponse'),
                        ],
                    },
                    {
                        type: 'object',
                        required: [
                            'settlement',
                            'externalSettledAmountInCents',
                        ],
                    },
                ],
            },
            OpenExternalLiabilities: scoped({
                items: {
                    type: 'array',
                    maxItems: 20,
                    items: object({
                        commitmentId: uuid,
                        commitmentVersion: positive,
                        description: { type: 'string' },
                        externalLiability: ref('ExternalLiability'),
                    }),
                },
                nextCursor: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            }),
            ExternalLiabilitySettlementOptions: scoped({
                commitmentId: uuid,
                description: { type: 'string' },
                expectedCommitmentVersion: positive,
                externalLiability: ref('ExternalLiability'),
            }),
        },
    },
};
