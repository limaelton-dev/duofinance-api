import type {
    OpenAPIObject,
    ReferenceObject,
    ResponseObject,
    SchemaObject,
} from '@nestjs/swagger';

const ref = (name: string): ReferenceObject => ({
    $ref: `#/components/schemas/${name}`,
});
const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const date: SchemaObject = { type: 'string', format: 'date' };
const amount: SchemaObject = {
    type: 'integer',
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
};
const version: SchemaObject = { type: 'integer', minimum: 1 };
const obj = (
    properties: Record<string, SchemaObject | ReferenceObject>,
): SchemaObject => ({
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
});
const nullable = (schema: SchemaObject | ReferenceObject): SchemaObject => ({
    oneOf: [schema, { type: 'null' }],
});
const split: SchemaObject = {
    oneOf: [
        obj({
            mode: { type: 'string', enum: ['AMOUNTS'] },
            shares: {
                type: 'array',
                minItems: 1,
                maxItems: 2,
                items: obj({
                    memberId: uuid,
                    amountInCents: { type: 'integer', minimum: 0 },
                }),
            },
        }),
        obj({
            mode: { type: 'string', enum: ['PERCENTAGES'] },
            shares: {
                type: 'array',
                minItems: 1,
                maxItems: 2,
                items: obj({
                    memberId: uuid,
                    basisPoints: {
                        type: 'integer',
                        minimum: 0,
                        maximum: 10000,
                    },
                }),
            },
        }),
    ],
};
const settlement: SchemaObject = {
    oneOf: [
        obj({ mode: { type: 'string', enum: ['NONE'] } }),
        obj({ mode: { type: 'string', enum: ['DATE'] }, targetDate: date }),
        obj({ mode: { type: 'string', enum: ['CYCLE'] }, cycleId: uuid }),
        obj({
            mode: { type: 'string', enum: ['SUGGESTED'] },
            referenceDate: date,
            expectedRuleVersion: version,
        }),
    ],
};
const common = {
    description: {
        type: 'string',
        minLength: 1,
        maxLength: 160,
    } as SchemaObject,
    amountInCents: amount,
    expectedReceiptDate: date,
};
const input: SchemaObject = {
    oneOf: [
        obj({ ...common, receipt: nullable(obj({ factDate: date })) }),
        obj({
            ...common,
            expectedSpaceVersion: version,
            participationSplit: split,
            expectedRecipientMemberId: nullable(uuid),
            receipt: nullable(
                obj({ factDate: date, recipientMemberId: uuid, settlement }),
            ),
        }),
    ],
};
const receiptInput: SchemaObject = {
    oneOf: [
        obj({ expectedCommitmentVersion: version, factDate: date }),
        obj({
            expectedCommitmentVersion: version,
            factDate: date,
            expectedSpaceVersion: version,
            recipientMemberId: uuid,
            settlement,
        }),
    ],
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
const error = (...codes: string[]): ResponseObject =>
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
const params = [
    { name: 'spaceId', in: 'path' as const, required: true, schema: uuid },
];
const commitmentParam = {
    name: 'commitmentId',
    in: 'path' as const,
    required: true,
    schema: uuid,
};
const cursorParam = {
    name: 'cursor',
    in: 'query' as const,
    required: false,
    schema: { type: 'string' as const },
};
const headers = [
    {
        name: 'X-CSRF-Token',
        in: 'header' as const,
        required: true,
        schema: { type: 'string' as const },
    },
    {
        name: 'Idempotency-Key',
        in: 'header' as const,
        required: true,
        schema: uuid,
    },
];
const failures = {
    400: error('VALIDATION_ERROR'),
    401: error('UNAUTHENTICATED'),
    404: error('SPACE_NOT_FOUND', 'FINANCIAL_COMMITMENT_NOT_FOUND'),
    409: error(
        'SPACE_NOT_ACTIVE',
        'INCOME_OPTIONS_CHANGED',
        'INCOME_ALREADY_RECEIVED',
        'CONCURRENT_MODIFICATION',
        'IDEMPOTENCY_KEY_REUSED',
    ),
    429: error('TOO_MANY_REQUESTS'),
    500: error('INTERNAL_ERROR'),
};

export const incomeOpenApi: Pick<OpenAPIObject, 'paths' | 'components'> = {
    paths: {
        '/v2/spaces/{spaceId}/income-options': {
            get: {
                operationId: 'getIncomeOptions',
                tags: ['Finances'],
                security: [{ sessionCookie: [] }],
                parameters: [...params, cursorParam],
                responses: {
                    ...failures,
                    200: response(
                        ref('IncomeOptions'),
                        'Contexto autorizado para registrar receita.',
                    ),
                },
            },
        },
        '/v2/spaces/{spaceId}/incomes': {
            get: {
                operationId: 'listIncomes',
                tags: ['Finances'],
                security: [{ sessionCookie: [] }],
                parameters: [
                    ...params,
                    cursorParam,
                    {
                        name: 'status',
                        in: 'query',
                        required: false,
                        schema: {
                            type: 'string',
                            enum: ['ALL', 'PENDING', 'RECEIVED'],
                        },
                    },
                ],
                responses: {
                    ...failures,
                    200: response(
                        ref('IncomeList'),
                        'Receitas persistidas do espaço.',
                    ),
                },
            },
            post: {
                operationId: 'recordIncome',
                tags: ['Finances'],
                security: [{ sessionCookie: [] }],
                parameters: [...params, ...headers],
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: input } },
                },
                responses: {
                    ...failures,
                    201: response(ref('IncomeDetail'), 'Receita criada.'),
                    200: response(ref('IncomeDetail'), 'Replay idempotente.'),
                    403: error('INVALID_CSRF_TOKEN'),
                },
            },
        },
        '/v2/spaces/{spaceId}/financial-commitments/{commitmentId}/receipt-options':
            {
                get: {
                    operationId: 'getIncomeReceiptOptions',
                    tags: ['Finances'],
                    security: [{ sessionCookie: [] }],
                    parameters: [...params, commitmentParam, cursorParam],
                    responses: {
                        ...failures,
                        200: response(
                            ref('IncomeReceiptOptions'),
                            'Recebimento e opções atuais sem efeitos de escrita.',
                        ),
                    },
                },
            },
        '/v2/spaces/{spaceId}/financial-commitments/{commitmentId}/receipts': {
            post: {
                operationId: 'recordIncomeReceipt',
                tags: ['Finances'],
                security: [{ sessionCookie: [] }],
                parameters: [...params, commitmentParam, ...headers],
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: receiptInput } },
                },
                responses: {
                    ...failures,
                    201: response(
                        ref('IncomeDetail'),
                        'Recebimento integral criado.',
                    ),
                    200: response(ref('IncomeDetail'), 'Replay idempotente.'),
                    403: error('INVALID_CSRF_TOKEN'),
                },
            },
        },
    },
    components: {
        schemas: {
            IncomeInput: input,
            IncomeReceiptInput: receiptInput,
            IncomeDetail: {
                type: 'object',
                required: [
                    'spaceId',
                    'spaceType',
                    'commitment',
                    'receipt',
                    'status',
                    'receivedAmountInCents',
                    'obligation',
                    'settlementCycle',
                ],
                properties: {
                    spaceId: uuid,
                    spaceType: { type: 'string', enum: ['PERSONAL', 'SHARED'] },
                    commitment: {
                        type: 'object',
                        required: [
                            'id',
                            'kind',
                            'modality',
                            'version',
                            'description',
                            'amountInCents',
                            'expectedReceiptDate',
                            'createdByPersonId',
                            'registeredAt',
                        ],
                        properties: {
                            id: uuid,
                            kind: { type: 'string', enum: ['INCOME'] },
                            modality: { type: 'string', enum: ['ONE_TIME'] },
                            version,
                            description: { type: 'string' },
                            amountInCents: amount,
                            expectedReceiptDate: date,
                            createdByPersonId: uuid,
                            registeredAt: {
                                type: 'string',
                                format: 'date-time',
                            },
                            ownerPersonId: uuid,
                            participationSplit: { type: 'object' },
                            expectedRecipientMemberId: nullable(uuid),
                            settlementRuleSnapshot: nullable({
                                type: 'object',
                            }),
                            settlementRuleSourceVersion: { type: 'integer' },
                        },
                    },
                    receipt: nullable(
                        obj({
                            id: uuid,
                            amountInCents: amount,
                            factDate: date,
                            registeredAt: {
                                type: 'string',
                                format: 'date-time',
                            },
                            recordedByPersonId: uuid,
                            recipientPersonId: nullable(uuid),
                            recipientMemberId: nullable(uuid),
                        }),
                    ),
                    status: { type: 'string', enum: ['PENDING', 'RECEIVED'] },
                    receivedAmountInCents: { type: 'integer', minimum: 0 },
                    obligation: nullable({ type: 'object' }),
                    settlementCycle: nullable({ type: 'object' }),
                    replayed: { type: 'boolean' },
                },
            },
            IncomeOptions: {
                type: 'object',
                properties: {
                    spaceId: uuid,
                    spaceType: { type: 'string', enum: ['PERSONAL', 'SHARED'] },
                    canCreate: { type: 'boolean' },
                    referenceDate: date,
                    members: { type: 'array', items: { type: 'object' } },
                },
            },
            IncomeReceiptOptions: {
                type: 'object',
                properties: {
                    spaceId: uuid,
                    spaceType: { type: 'string', enum: ['PERSONAL', 'SHARED'] },
                    commitmentId: uuid,
                    expectedCommitmentVersion: version,
                    amountInCents: amount,
                    canReceive: { type: 'boolean' },
                    referenceDate: date,
                },
            },
            IncomeList: obj({
                items: {
                    type: 'array',
                    items: obj({
                        id: uuid,
                        description: { type: 'string' },
                        amountInCents: amount,
                        expectedReceiptDate: date,
                        registeredAt: { type: 'string', format: 'date-time' },
                        status: {
                            type: 'string',
                            enum: ['PENDING', 'RECEIVED'],
                        },
                        receivedAmountInCents: { type: 'integer', minimum: 0 },
                    }),
                },
                nextCursor: nullable({ type: 'string' }),
            }),
        },
    },
};
