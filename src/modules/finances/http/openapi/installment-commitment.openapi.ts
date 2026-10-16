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
const date: SchemaObject = { type: 'string', format: 'date' };
const cents: SchemaObject = {
    type: 'integer',
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
};
const version: SchemaObject = { type: 'integer', minimum: 1 };
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
const path = (name: string) => ({
    name,
    in: 'path' as const,
    required: true,
    schema: uuid,
});
const csrf = {
    name: 'X-CSRF-Token',
    in: 'header' as const,
    required: true,
    schema: { type: 'string' },
};
const idempotency = {
    name: 'Idempotency-Key',
    in: 'header' as const,
    required: true,
    schema: uuid,
};
const read = [path('spaceId')];
const write = [path('spaceId'), csrf, idempotency];
const common = {
    description: {
        type: 'string',
        minLength: 1,
        maxLength: 160,
    } as SchemaObject,
    count: { type: 'integer', minimum: 1, maximum: 1200 } as SchemaObject,
    firstDueDate: date,
    cadence: { type: 'string', enum: ['MONTHLY', 'ANNUAL'] } as SchemaObject,
    explicitDueDates: {
        type: 'array',
        minItems: 1,
        maxItems: 1200,
        items: date,
    } as SchemaObject,
    totalAmountInCents: cents,
    baseAmountInCents: cents,
    amountsInCents: {
        type: 'array',
        minItems: 1,
        maxItems: 1200,
        items: cents,
    } as SchemaObject,
    plannedPaymentMethod: nullable({
        type: 'string',
        enum: ['CARD', 'PIX', 'DEBIT', 'CASH'],
    }),
};
const personal = object({
    scope: { type: 'string', enum: ['PERSONAL'] },
    ...common,
});
personal.required = ['scope', 'description', 'count'];
const shared = object({
    scope: { type: 'string', enum: ['SHARED'] },
    ...common,
    distribution: ref('ResponsibilitySplit'),
    expectedMemberId: nullable(uuid),
    expectedSpaceVersion: version,
    expectedRuleVersion: { type: 'integer', minimum: 0 },
});
shared.required = ['scope', 'description', 'count', 'distribution'];
const installment = object({
    id: uuid,
    position: version,
    dueDate: date,
    amountInCents: cents,
    economicShares: nullable({
        type: 'array',
        items: object({
            memberId: uuid,
            amountInCents: { type: 'integer', minimum: 0 },
        }),
    }),
    stateVersion: nullable(version),
    status: {
        type: 'string',
        enum: ['PENDING', 'PARTIALLY_FULFILLED', 'FULFILLED'],
    },
    fulfilledAmountInCents: { type: 'integer', minimum: 0 },
    remainingAmountInCents: { type: 'integer', minimum: 0 },
    facts: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
    },
    externalSettlements: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
    },
});
const plan = object({
    id: uuid,
    count: version,
    cadence: { type: 'string', enum: ['MONTHLY', 'ANNUAL', 'EXPLICIT'] },
    status: { type: 'string', enum: ['OPEN', 'COMPLETED'] },
    plannedPaymentMethod: nullable({
        type: 'string',
        enum: ['CARD', 'PIX', 'DEBIT', 'CASH'],
    }),
    totalAmountInCents: cents,
    fulfilledAmountInCents: { type: 'integer', minimum: 0 },
    remainingAmountInCents: { type: 'integer', minimum: 0 },
    installments: { type: 'array', items: ref('Installment') },
});
const commitment = object({
    id: uuid,
    spaceId: uuid,
    kind: { type: 'string', enum: ['EXPENSE'] },
    modality: { type: 'string', enum: ['INSTALLMENT'] },
    description: { type: 'string' },
    createdByPersonId: uuid,
    registeredAt: { type: 'string', format: 'date-time' },
    version,
    scope: { type: 'string', enum: ['PERSONAL', 'SHARED'] },
    plan: ref('InstallmentPlan'),
    ownerPersonId: uuid,
    distribution: ref('ResponsibilitySplit'),
    expectedMemberId: nullable(uuid),
    settlementRuleSnapshot: nullable({
        type: 'object',
        additionalProperties: true,
    }),
    settlementRuleSourceVersion: { type: 'integer', minimum: 0 },
});
commitment.required = [
    'id',
    'spaceId',
    'kind',
    'modality',
    'description',
    'createdByPersonId',
    'registeredAt',
    'version',
    'scope',
    'plan',
];
const settlement: SchemaObject = {
    oneOf: [
        object({ mode: { type: 'string', enum: ['NONE'] } }),
        object({ mode: { type: 'string', enum: ['DATE'] }, targetDate: date }),
        object({ mode: { type: 'string', enum: ['CYCLE'] }, cycleId: uuid }),
        object({
            mode: { type: 'string', enum: ['SUGGESTED'] },
            referenceDate: date,
            expectedRuleVersion: version,
        }),
    ],
};
const fulfillment = {
    expectedCommitmentVersion: version,
    expectedInstallmentVersion: version,
    amountInCents: cents,
    factDate: date,
};
const disbursement = object({
    ...fulfillment,
    method: { type: 'string', enum: ['PIX', 'DEBIT', 'CASH'] },
    payerMemberId: uuid,
    expectedSpaceVersion: version,
    settlement,
});
disbursement.required = Object.keys(fulfillment).concat('method');
const liability = object({
    ...fulfillment,
    holderMemberId: uuid,
    expectedSpaceVersion: version,
    settlement,
});
liability.required = Object.keys(fulfillment);
const externalSettlement = object({
    ...fulfillment,
    expectedSpaceVersion: version,
});
externalSettlement.required = Object.keys(fulfillment);
const command = (
    operationId: string,
    request: string,
    pathParameters: ReturnType<typeof path>[],
) => ({
    operationId,
    tags: ['Finances'],
    security: [{ sessionCookie: [] }],
    parameters: [...write, ...pathParameters],
    requestBody: {
        required: true,
        content: { 'application/json': { schema: ref(request) } },
    },
    responses: {
        201: response(ref('InstallmentCommandResponse'), 'Parcela atualizada.'),
        200: response(ref('InstallmentCommandResponse'), 'Replay autorizado.'),
        400: error('VALIDATION_ERROR'),
        401: error('UNAUTHENTICATED'),
        404: error('FINANCIAL_COMMITMENT_NOT_FOUND'),
        409: error(
            'CONCURRENT_MODIFICATION',
            'IDEMPOTENCY_KEY_REUSED',
            'OCCURRENCE_ALREADY_RESOLVED',
            'EXPENSE_OPTIONS_CHANGED',
        ),
    },
});

export const installmentCommitmentOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        '/v2/spaces/{spaceId}/installment-commitments/preview': {
            post: {
                operationId: 'previewInstallmentCommitment',
                tags: ['Finances'],
                security: [{ sessionCookie: [] }],
                parameters: [...read, csrf],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: ref('InstallmentCommitmentRequest'),
                        },
                    },
                },
                responses: {
                    200: response(
                        ref('InstallmentPreview'),
                        'Cronograma completo, sem escrita.',
                    ),
                    400: error('VALIDATION_ERROR'),
                    404: error('SPACE_NOT_FOUND'),
                },
            },
        },
        '/v2/spaces/{spaceId}/installment-commitments': {
            post: {
                operationId: 'createInstallmentCommitment',
                tags: ['Finances'],
                security: [{ sessionCookie: [] }],
                parameters: write,
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: ref('InstallmentCommitmentRequest'),
                        },
                    },
                },
                responses: {
                    201: response(
                        ref('CreateInstallmentCommitmentResponse'),
                        'Plano confirmado.',
                    ),
                    200: response(
                        ref('CreateInstallmentCommitmentResponse'),
                        'Replay autorizado.',
                    ),
                    400: error('VALIDATION_ERROR'),
                    404: error('SPACE_NOT_FOUND'),
                    409: error(
                        'EXPENSE_OPTIONS_CHANGED',
                        'IDEMPOTENCY_KEY_REUSED',
                    ),
                },
            },
            get: {
                operationId: 'listInstallmentCommitments',
                tags: ['Finances'],
                security: [{ sessionCookie: [] }],
                parameters: [
                    ...read,
                    {
                        name: 'cursor',
                        in: 'query',
                        required: false,
                        schema: { type: 'string' },
                    },
                ],
                responses: {
                    200: response(
                        ref('InstallmentCommitmentList'),
                        'Planos parcelados.',
                    ),
                    400: error('VALIDATION_ERROR'),
                    404: error('SPACE_NOT_FOUND'),
                },
            },
        },
        '/v2/spaces/{spaceId}/installment-commitments/{id}': {
            get: {
                operationId: 'getInstallmentCommitment',
                tags: ['Finances'],
                security: [{ sessionCookie: [] }],
                parameters: [...read, path('id')],
                responses: {
                    200: response(
                        object({ commitment: ref('InstallmentCommitment') }),
                        'Plano e cronograma.',
                    ),
                    404: error('FINANCIAL_COMMITMENT_NOT_FOUND'),
                },
            },
        },
        '/v2/spaces/{spaceId}/installment-commitments/{id}/installments': {
            get: {
                operationId: 'listInstallments',
                tags: ['Finances'],
                security: [{ sessionCookie: [] }],
                parameters: [...read, path('id')],
                responses: {
                    200: response(
                        ref('InstallmentList'),
                        'Todas as parcelas e fatos, sem truncamento.',
                    ),
                    404: error('FINANCIAL_COMMITMENT_NOT_FOUND'),
                },
            },
        },
        '/v2/spaces/{spaceId}/installment-commitments/{id}/installments/{installmentId}/options':
            {
                get: {
                    operationId: 'getInstallmentOptions',
                    tags: ['Finances'],
                    security: [{ sessionCookie: [] }],
                    parameters: [
                        ...read,
                        path('id'),
                        path('installmentId'),
                        {
                            name: 'cursor',
                            in: 'query',
                            required: false,
                            schema: { type: 'string' },
                        },
                    ],
                    responses: {
                        200: response(
                            { type: 'object', additionalProperties: true },
                            'Parcela, versões e opções de acerto.',
                        ),
                        404: error('FINANCIAL_COMMITMENT_NOT_FOUND'),
                    },
                },
            },
        '/v2/spaces/{spaceId}/installment-commitments/{id}/installments/{installmentId}/disbursements':
            {
                post: command(
                    'recordInstallmentDisbursement',
                    'InstallmentDisbursementRequest',
                    [path('id'), path('installmentId')],
                ),
            },
        '/v2/spaces/{spaceId}/installment-commitments/{id}/installments/{installmentId}/external-liabilities':
            {
                post: command(
                    'recordInstallmentExternalLiability',
                    'InstallmentExternalLiabilityRequest',
                    [path('id'), path('installmentId')],
                ),
            },
        '/v2/spaces/{spaceId}/installment-commitments/{id}/installments/{installmentId}/external-liabilities/{liabilityId}/settlements':
            {
                post: command(
                    'settleInstallmentExternalLiability',
                    'InstallmentExternalSettlementRequest',
                    [path('id'), path('installmentId'), path('liabilityId')],
                ),
            },
    },
    components: {
        schemas: {
            InstallmentCommitmentRequest: {
                oneOf: [personal, shared],
                description:
                    'Informe exatamente um modo de datas e um modo de valores. O resíduo de um total fixo fica somente na última parcela. A versão do espaço e a versão da regra são obrigatórias na confirmação compartilhada.',
            },
            InstallmentPreview: {
                ...object({
                    scope: { type: 'string' },
                    description: { type: 'string' },
                    count: version,
                    cadence: { type: 'string' },
                    plannedPaymentMethod: nullable({ type: 'string' }),
                    totalAmountInCents: cents,
                    installments: {
                        type: 'array',
                        items: object({
                            position: version,
                            dueDate: date,
                            amountInCents: cents,
                            economicShares: nullable({
                                type: 'array',
                                items: object({
                                    memberId: uuid,
                                    amountInCents: {
                                        type: 'integer',
                                        minimum: 0,
                                    },
                                }),
                            }),
                        }),
                    },
                    ownerPersonId: uuid,
                    distribution: ref('ResponsibilitySplit'),
                    expectedMemberId: nullable(uuid),
                    settlementRuleSnapshot: nullable({
                        type: 'object',
                        additionalProperties: true,
                    }),
                    settlementRuleSourceVersion: {
                        type: 'integer',
                        minimum: 0,
                    },
                    expectedSpaceVersion: version,
                    expectedRuleVersion: { type: 'integer', minimum: 0 },
                }),
                required: [
                    'scope',
                    'description',
                    'count',
                    'cadence',
                    'plannedPaymentMethod',
                    'totalAmountInCents',
                    'installments',
                ],
            },
            Installment: installment,
            InstallmentPlan: plan,
            InstallmentCommitment: commitment,
            CreateInstallmentCommitmentResponse: object({
                commitment: ref('InstallmentCommitment'),
                replayed: { type: 'boolean' },
            }),
            InstallmentCommandResponse: {
                ...object({
                    commitment: ref('InstallmentCommitment'),
                    installment: ref('Installment'),
                    settlement: object({
                        id: uuid,
                        remainingAmountInCents: { type: 'integer', minimum: 0 },
                    }),
                    replayed: { type: 'boolean' },
                }),
                required: ['commitment', 'installment', 'replayed'],
            },
            InstallmentCommitmentList: object({
                spaceId: uuid,
                items: { type: 'array', items: ref('InstallmentCommitment') },
                totalCount: { type: 'integer', minimum: 0 },
                totalAmountInCents: { type: 'string', pattern: '^\\d+$' },
                nextCursor: nullable({ type: 'string' }),
            }),
            InstallmentList: object({
                commitmentId: uuid,
                planId: uuid,
                totalCount: { type: 'integer', minimum: 0 },
                items: { type: 'array', items: ref('Installment') },
            }),
            InstallmentDisbursementRequest: disbursement,
            InstallmentExternalLiabilityRequest: liability,
            InstallmentExternalSettlementRequest: externalSettlement,
        },
    },
};
