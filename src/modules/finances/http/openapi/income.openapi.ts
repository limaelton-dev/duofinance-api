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
const version: SchemaObject = {
    type: 'integer',
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
};
const total: SchemaObject = { ...amount, minimum: 0 };
const instant: SchemaObject = { type: 'string', format: 'date-time' };
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
        obj({
            ...common,
            receipt: nullable({
                ...obj({ factDate: date, amountInCents: amount }),
                required: ['factDate'],
            }),
        }),
        obj({
            ...common,
            expectedSpaceVersion: version,
            participationSplit: split,
            expectedRecipientMemberId: nullable(uuid),
            receipt: nullable({
                ...obj({
                    factDate: date,
                    amountInCents: amount,
                    recipientMemberId: uuid,
                    settlement,
                }),
                required: ['factDate', 'recipientMemberId', 'settlement'],
            }),
        }),
    ],
};
const receiptInput: SchemaObject = {
    oneOf: [
        {
            ...obj({
                expectedCommitmentVersion: version,
                factDate: date,
                amountInCents: amount,
            }),
            required: ['expectedCommitmentVersion', 'factDate'],
        },
        {
            ...obj({
                expectedCommitmentVersion: version,
                factDate: date,
                amountInCents: amount,
                expectedSpaceVersion: version,
                recipientMemberId: uuid,
                settlement,
            }),
            required: [
                'expectedCommitmentVersion',
                'factDate',
                'expectedSpaceVersion',
                'recipientMemberId',
                'settlement',
            ],
        },
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
    404: error(
        'SPACE_NOT_FOUND',
        'FINANCIAL_COMMITMENT_NOT_FOUND',
        'SETTLEMENT_CYCLE_NOT_FOUND',
    ),
    409: error(
        'SPACE_NOT_ACTIVE',
        'INCOME_OPTIONS_CHANGED',
        'INCOME_ALREADY_RECEIVED',
        'CONCURRENT_MODIFICATION',
        'IDEMPOTENCY_KEY_REUSED',
        'SETTLEMENT_CYCLE_FINALIZED',
    ),
    429: error('TOO_MANY_REQUESTS'),
    500: error('INTERNAL_ERROR'),
};
const member = obj({
    memberId: uuid,
    personId: uuid,
    displayName: { type: 'string' },
});
const members: SchemaObject = {
    type: 'array',
    minItems: 1,
    maxItems: 2,
    items: member,
};
const calculatedSplit: SchemaObject = {
    oneOf: split.oneOf!.map((variant) =>
        obj({
            ...(variant as SchemaObject).properties,
            calculatedShares: {
                type: 'array',
                minItems: 1,
                maxItems: 2,
                items: obj({ memberId: uuid, amountInCents: total }),
            },
        }),
    ),
};
const settlementOptions = {
    members,
    defaultSettlementRule: obj({
        rule: nullable(ref('SettlementRule')),
        version: total,
    }),
    suggestedTargetDate: nullable(date),
    openCycles: {
        type: 'array' as const,
        maxItems: 20,
        items: obj({ id: uuid, targetDate: date, version }),
    },
    nextCursor: nullable({ type: 'string' }),
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
                description:
                    'PENDING inclui todas as receitas com restante positivo, inclusive PARTIALLY_RECEIVED; paginação conta compromissos, preservando o valor original.',
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
                description:
                    'receipt null preserva a previsão sem realização. receipt.amountInCents omitido significa recebimento integral inicial; explícito aceita parcial positiva até o total original. A participação compartilhada permanece original, e o repasse é calculado sobre o recebido acumulado.',
                tags: ['Finances'],
                security: [{ sessionCookie: [] }],
                parameters: [...params, ...headers],
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: input } },
                },
                responses: {
                    ...failures,
                    201: response(ref('IncomeResult'), 'Receita criada.'),
                    200: response(
                        {
                            oneOf: [
                                ref('IncomeResult'),
                                ref('LegacyIncomeReplay'),
                            ],
                        },
                        'Replay autorizado com o resultado histórico original.',
                    ),
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
                description:
                    'Acrescenta fato positivo até o restante e reconcilia somente esta origem considerando acertos anteriores. Valor omitido só é aceito no primeiro recebimento integral legado, sem fatos prévios; após parcial deve ser explícito. Versões capturadas são revalidadas na transação. Mesma chave e conteúdo repetem o resultado histórico original; conteúdo diferente conflita.',
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
                        ref('IncomeResult'),
                        'Recebimento parcial ou integral criado.',
                    ),
                    200: response(
                        {
                            oneOf: [
                                ref('IncomeResult'),
                                ref('LegacyIncomeReplay'),
                            ],
                        },
                        'Replay idempotente do resultado original, inclusive formato legado.',
                    ),
                    403: error('INVALID_CSRF_TOKEN'),
                },
            },
        },
    },
    components: {
        schemas: {
            IncomeInput: input,
            IncomeReceiptInput: receiptInput,
            IncomeReceipt: obj({
                id: uuid,
                amountInCents: amount,
                factDate: date,
                registeredAt: instant,
                recordedByPersonId: uuid,
                recipientPersonId: nullable(uuid),
                recipientMemberId: nullable(uuid),
            }),
            IncomeResult: {
                allOf: [
                    ref('IncomeDetail'),
                    {
                        type: 'object',
                        required: ['replayed'],
                        properties: { replayed: { type: 'boolean' } },
                    },
                ],
            },
            LegacyIncomeReplay: {
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
                    'replayed',
                ],
                properties: {
                    spaceId: uuid,
                    spaceType: { type: 'string', enum: ['PERSONAL', 'SHARED'] },
                    commitment: { type: 'object' },
                    receipt: nullable(ref('IncomeReceipt')),
                    status: { type: 'string', enum: ['PENDING', 'RECEIVED'] },
                    receivedAmountInCents: total,
                    obligation: nullable({ type: 'object' }),
                    settlementCycle: nullable({ type: 'object' }),
                    replayed: { type: 'boolean', enum: [true] },
                },
                not: { required: ['receipts'] },
            },
            IncomeDetail: {
                type: 'object',
                required: [
                    'spaceId',
                    'spaceType',
                    'commitment',
                    'receipt',
                    'status',
                    'receivedAmountInCents',
                    'remainingAmountInCents',
                    'receipts',
                    'obligations',
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
                            participationSplit: calculatedSplit,
                            expectedRecipientMemberId: nullable(uuid),
                            settlementRuleSnapshot: nullable(
                                ref('SettlementRule'),
                            ),
                            settlementRuleSourceVersion: total,
                        },
                    },
                    receipt: nullable(ref('IncomeReceipt')),
                    receipts: { type: 'array', items: ref('IncomeReceipt') },
                    status: {
                        type: 'string',
                        enum: ['PENDING', 'PARTIALLY_RECEIVED', 'RECEIVED'],
                    },
                    receivedAmountInCents: total,
                    remainingAmountInCents: total,
                    obligation: nullable(ref('FinancialFulfillmentObligation')),
                    obligations: {
                        type: 'array',
                        items: ref('FinancialFulfillmentObligation'),
                    },
                    settlementCycle: nullable(
                        obj({
                            id: uuid,
                            targetDate: date,
                            status: {
                                type: 'string',
                                enum: ['OPEN', 'FINALIZED'],
                            },
                        }),
                    ),
                    members,
                },
            },
            IncomeOptions: {
                type: 'object',
                required: [
                    'spaceId',
                    'spaceType',
                    'status',
                    'canCreate',
                    'referenceDate',
                ],
                properties: {
                    ...settlementOptions,
                    spaceId: uuid,
                    spaceType: { type: 'string', enum: ['PERSONAL', 'SHARED'] },
                    status: {
                        type: 'string',
                        enum: ['ACTIVE', 'CLOSING', 'CLOSED'],
                    },
                    version,
                    canCreate: { type: 'boolean' },
                    referenceDate: date,
                },
            },
            IncomeReceiptOptions: {
                type: 'object',
                required: [
                    'spaceId',
                    'spaceType',
                    'commitmentId',
                    'expectedCommitmentVersion',
                    'amountInCents',
                    'receivedAmountInCents',
                    'remainingAmountInCents',
                    'canReceive',
                    'referenceDate',
                ],
                properties: {
                    ...settlementOptions,
                    spaceId: uuid,
                    spaceType: { type: 'string', enum: ['PERSONAL', 'SHARED'] },
                    commitmentId: uuid,
                    expectedCommitmentVersion: version,
                    amountInCents: amount,
                    receivedAmountInCents: total,
                    remainingAmountInCents: total,
                    canReceive: { type: 'boolean' },
                    referenceDate: date,
                    expectedSpaceVersion: version,
                    participationSplit: calculatedSplit,
                    expectedRecipientMemberId: nullable(uuid),
                },
            },
            IncomeList: obj({
                spaceId: uuid,
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
                            enum: ['PENDING', 'PARTIALLY_RECEIVED', 'RECEIVED'],
                        },
                        receivedAmountInCents: { type: 'integer', minimum: 0 },
                        remainingAmountInCents: total,
                    }),
                },
                nextCursor: nullable({ type: 'string' }),
            }),
        },
    },
};
