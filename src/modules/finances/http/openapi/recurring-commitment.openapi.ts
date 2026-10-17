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
const amount: SchemaObject = {
    type: 'integer',
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
};
const version: SchemaObject = { type: 'integer', minimum: 1 };
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
const path = (name: string, required = true) => ({
    name,
    in: 'path' as const,
    required,
    schema: uuid,
});
const month = {
    name: 'month',
    in: 'query' as const,
    required: true,
    schema: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
};
const write = [
    path('spaceId'),
    {
        name: 'X-CSRF-Token',
        in: 'header' as const,
        required: true,
        schema: { type: 'string' },
    },
    {
        name: 'Idempotency-Key',
        in: 'header' as const,
        required: true,
        schema: uuid,
    },
];
const recurrence: SchemaObject = {
    oneOf: [
        object({
            frequency: { type: 'string', enum: ['MONTHLY'] },
            dayOfMonth: { type: 'integer', minimum: 1, maximum: 31 },
        }),
        object({
            frequency: { type: 'string', enum: ['ANNUAL'] },
            monthOfYear: { type: 'integer', minimum: 1, maximum: 12 },
            dayOfMonth: { type: 'integer', minimum: 1, maximum: 31 },
        }),
    ],
};
const base = {
    kind: { type: 'string', enum: ['EXPENSE', 'INCOME'] } as SchemaObject,
    description: {
        type: 'string',
        minLength: 1,
        maxLength: 160,
    } as SchemaObject,
    recurrence,
    startsOn: date,
    endsOn: { oneOf: [date, { type: 'null' }] } as SchemaObject,
};
const personal = object({
    scope: { type: 'string', enum: ['PERSONAL'] },
    valueMode: { type: 'string', enum: ['FIXED'] },
    amountInCents: amount,
    ...base,
});
personal.required = personal.required!.filter(
    (x) => !['startsOn', 'endsOn', 'valueMode'].includes(x),
);
const shared = object({
    scope: { type: 'string', enum: ['SHARED'] },
    valueMode: { type: 'string', enum: ['FIXED'] },
    amountInCents: amount,
    ...base,
    expectedSpaceVersion: version,
    distribution: ref('ResponsibilitySplit'),
    expectedMemberId: { oneOf: [uuid, { type: 'null' }] },
});
shared.required = shared.required!.filter(
    (x) => !['startsOn', 'endsOn', 'expectedMemberId', 'valueMode'].includes(x),
);
const percentageDistribution: SchemaObject = object({
    mode: { type: 'string', enum: ['PERCENTAGES'] },
    shares: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: object({
            memberId: uuid,
            basisPoints: { type: 'integer', minimum: 0, maximum: 10000 },
        }),
    },
});
const variablePersonal = object({
    scope: { type: 'string', enum: ['PERSONAL'] },
    valueMode: { type: 'string', enum: ['VARIABLE'] },
    expectedAmountInCents: { oneOf: [amount, { type: 'null' }] },
    ...base,
});
variablePersonal.required = variablePersonal.required!.filter(
    (x) => !['startsOn', 'endsOn', 'expectedAmountInCents'].includes(x),
);
const variableShared = object({
    scope: { type: 'string', enum: ['SHARED'] },
    valueMode: { type: 'string', enum: ['VARIABLE'] },
    expectedAmountInCents: { oneOf: [amount, { type: 'null' }] },
    ...base,
    expectedSpaceVersion: version,
    distribution: percentageDistribution,
    expectedMemberId: { oneOf: [uuid, { type: 'null' }] },
});
variableShared.required = variableShared.required!.filter(
    (x) =>
        ![
            'startsOn',
            'endsOn',
            'expectedMemberId',
            'expectedAmountInCents',
        ].includes(x),
);
const factCommon = {
    id: uuid,
    amountInCents: amount,
    factDate: date,
    registeredAt: { type: 'string', format: 'date-time' } as SchemaObject,
    recordedByPersonId: uuid,
};
const fact: SchemaObject = {
    oneOf: [
        object({
            ...factCommon,
            kind: { type: 'string', enum: ['DISBURSEMENT'] },
            payerMemberId: { oneOf: [uuid, { type: 'null' }] },
            payerPersonId: { oneOf: [uuid, { type: 'null' }] },
            method: { type: 'string', enum: ['PIX', 'DEBIT', 'CASH'] },
        }),
        object({
            ...factCommon,
            kind: { type: 'string', enum: ['RECEIPT'] },
            recipientMemberId: { oneOf: [uuid, { type: 'null' }] },
            recipientPersonId: { oneOf: [uuid, { type: 'null' }] },
        }),
        object({
            ...factCommon,
            kind: { type: 'string', enum: ['EXTERNAL_LIABILITY'] },
            holderMemberId: { oneOf: [uuid, { type: 'null' }] },
            holderPersonId: { oneOf: [uuid, { type: 'null' }] },
            remainingAmountInCents: { type: 'integer', minimum: 0 },
        }),
    ],
};
const occurrence = object({
    id: { oneOf: [uuid, { type: 'null' }] },
    commitmentId: uuid,
    referenceDate: date,
    economicVersion: version,
    stateVersion: version,
    amountInCents: { oneOf: [amount, { type: 'null' }] },
    expectedAmountInCents: { oneOf: [amount, { type: 'null' }] },
    valuePending: { type: 'boolean' },
    economicShares: {
        oneOf: [
            {
                type: 'array',
                items: object({
                    memberId: uuid,
                    amountInCents: { type: 'integer', minimum: 0 },
                }),
            },
            { type: 'null' },
        ],
    },
    valueHistory: {
        type: 'array',
        items: object({
            version,
            previousAmountInCents: { oneOf: [amount, { type: 'null' }] },
            amountInCents: amount,
            actorId: uuid,
            registeredAt: { type: 'string', format: 'date-time' },
        }),
    },
    status: {
        type: 'string',
        enum: ['PENDING', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED'],
    },
    fulfilledAmountInCents: { type: 'integer', minimum: 0 },
    remainingAmountInCents: {
        oneOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }],
    },
    materializedAt: {
        oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
    facts: { type: 'array', items: fact },
    externalSettlements: {
        type: 'array',
        items: object({
            id: uuid,
            externalLiabilityId: uuid,
            amountInCents: amount,
            factDate: date,
            registeredAt: { type: 'string', format: 'date-time' },
            recordedByPersonId: uuid,
        }),
    },
    cancellation: {
        oneOf: [
            object({
                actorId: uuid,
                registeredAt: { type: 'string', format: 'date-time' },
            }),
            { type: 'null' },
        ],
    },
});
const result = object({
    commitment: ref('RecurringCommitment'),
    occurrence: ref('FinancialOccurrence'),
    replayed: { type: 'boolean' },
    settlement: object({
        id: uuid,
        remainingAmountInCents: { type: 'integer', minimum: 0 },
    }),
});
result.required = result.required!.filter((name) => name !== 'settlement');
const commonFact = {
    expectedCommitmentVersion: version,
    expectedOccurrenceVersion: version,
    amountInCents: amount,
    factDate: date,
};
const selection: SchemaObject = {
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
const calculatedShares: SchemaObject = {
    type: 'array',
    items: object({
        memberId: uuid,
        amountInCents: { type: 'integer', minimum: 0 },
    }),
};
const distributionView: SchemaObject = {
    oneOf: [
        object({
            mode: { type: 'string', enum: ['AMOUNTS'] },
            shares: {
                type: 'array',
                items: object({
                    memberId: uuid,
                    amountInCents: { type: 'integer', minimum: 0 },
                }),
            },
            calculatedShares,
        }),
        object({
            mode: { type: 'string', enum: ['PERCENTAGES'] },
            shares: {
                type: 'array',
                items: object({
                    memberId: uuid,
                    basisPoints: {
                        type: 'integer',
                        minimum: 0,
                        maximum: 10000,
                    },
                }),
            },
            calculatedShares,
        }),
    ],
};
const body = (
    specific: Record<string, SchemaObject | ReferenceObject>,
): SchemaObject => ({
    oneOf: [
        object({ ...commonFact, ...specific }),
        object({
            ...commonFact,
            ...specific,
            expectedSpaceVersion: version,
            settlement: selection,
            ...(specific.method
                ? { payerMemberId: uuid }
                : { holderMemberId: uuid }),
        }),
    ],
});
const recurringCommitment = object({
    id: uuid,
    spaceId: uuid,
    kind: { type: 'string', enum: ['EXPENSE', 'INCOME'] },
    modality: { type: 'string', enum: ['RECURRING'] },
    description: { type: 'string' },
    valueMode: { type: 'string', enum: ['FIXED', 'VARIABLE'] },
    amountInCents: { oneOf: [amount, { type: 'null' }] },
    expectedAmountInCents: { oneOf: [amount, { type: 'null' }] },
    recurrence,
    startsOn: date,
    endsOn: { oneOf: [date, { type: 'null' }] },
    createdByPersonId: uuid,
    registeredAt: { type: 'string', format: 'date-time' },
    economicVersion: version,
    currentEconomicVersion: { oneOf: [version, { type: 'null' }] },
    effectiveFrom: date,
    terminatedOn: { oneOf: [date, { type: 'null' }] },
    versions: {
        type: 'array',
        items: object({
            version,
            effectiveFrom: date,
            description: { type: 'string' },
            valueMode: { type: 'string', enum: ['FIXED', 'VARIABLE'] },
            amountInCents: { oneOf: [amount, { type: 'null' }] },
            expectedAmountInCents: { oneOf: [amount, { type: 'null' }] },
            recurrence,
            endsOn: { oneOf: [date, { type: 'null' }] },
        }),
    },
    version,
    scope: { type: 'string', enum: ['PERSONAL', 'SHARED'] },
    nextOccurrence: {
        description:
            'Projeção da série a partir de hoje; consulte occurrences para o estado materializado.',
        oneOf: [
            object({
                referenceDate: date,
                economicVersion: version,
                amountInCents: { oneOf: [amount, { type: 'null' }] },
                expectedAmountInCents: { oneOf: [amount, { type: 'null' }] },
            }),
            { type: 'null' },
        ],
    },
    ownerPersonId: uuid,
    distribution: distributionView,
    expectedMemberId: { oneOf: [uuid, { type: 'null' }] },
    settlementRuleSnapshot: {
        oneOf: [ref('SettlementRule'), { type: 'null' }],
    },
    settlementRuleSourceVersion: { type: 'integer', minimum: 0 },
    referenceDate: date,
});
recurringCommitment.required = recurringCommitment.required!.filter(
    (name) =>
        ![
            'ownerPersonId',
            'distribution',
            'expectedMemberId',
            'settlementRuleSnapshot',
            'settlementRuleSourceVersion',
            'referenceDate',
        ].includes(name),
);
const options = object({
    commitment: ref('RecurringCommitment'),
    occurrence: ref('FinancialOccurrence'),
    suggestedSettlement: {
        oneOf: [
            object({
                referenceDate: date,
                expectedRuleVersion: version,
                targetDate: date,
            }),
            { type: 'null' },
        ],
    },
    settlementRule: {
        oneOf: [
            object({
                source: { type: 'string', enum: ['SPECIFIC', 'INHERITED'] },
                rule: { oneOf: [ref('SettlementRule'), { type: 'null' }] },
                version: { type: 'integer', minimum: 0 },
            }),
            { type: 'null' },
        ],
    },
    openCycles: {
        type: 'array',
        maxItems: 20,
        items: object({ id: uuid, targetDate: date, version }),
    },
    nextCursor: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    expectedSpaceVersion: version,
    members: {
        type: 'array',
        items: object({
            memberId: uuid,
            personId: uuid,
            displayName: { type: 'string' },
        }),
    },
});
options.required = options.required!.filter(
    (name) => !['expectedSpaceVersion', 'members'].includes(name),
);
const command = (operationId: string, request: string) => ({
    operationId,
    tags: ['Finances'],
    security: [{ sessionCookie: [] }],
    parameters: [
        ...write,
        path('id'),
        {
            name: 'referenceDate',
            in: 'path' as const,
            required: true,
            schema: date,
        },
    ],
    requestBody: {
        required: true,
        content: { 'application/json': { schema: ref(request) } },
    },
    responses: {
        201: response(
            ref('RecurringFulfillmentResponse'),
            'Ocorrência materializada ou atualizada.',
        ),
        200: response(
            ref('RecurringFulfillmentResponse'),
            'Replay autorizado.',
        ),
        400: error('VALIDATION_ERROR'),
        401: error('UNAUTHENTICATED'),
        404: error('SPACE_NOT_FOUND', 'FINANCIAL_COMMITMENT_NOT_FOUND'),
        409: error(
            'CONCURRENT_MODIFICATION',
            'OCCURRENCE_ALREADY_RESOLVED',
            'SETTLEMENT_CYCLE_FINALIZED',
            'IDEMPOTENCY_KEY_REUSED',
            'EXPENSE_OPTIONS_CHANGED',
            'OCCURRENCE_VALUE_REQUIRED',
        ),
    },
});
const changeSchema = (source: SchemaObject): SchemaObject => {
    const properties: Record<string, SchemaObject | ReferenceObject> = {
        ...source.properties,
        effectiveFrom: date,
        expectedCommitmentVersion: version,
    };
    delete properties.startsOn;
    return {
        ...source,
        properties,
        required: [
            ...new Set([
                ...(source.required ?? []).filter(
                    (field) => field !== 'startsOn',
                ),
                'effectiveFrom',
                'expectedCommitmentVersion',
                'valueMode',
            ]),
        ],
    };
};
const changeRequest: SchemaObject = {
    oneOf: [personal, shared, variablePersonal, variableShared].map(
        changeSchema,
    ),
};
const preserved: SchemaObject = {
    type: 'array',
    items: object({
        referenceDate: date,
        status: {
            type: 'string',
            enum: ['PENDING', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED'],
        },
        economicVersion: version,
    }),
};
const changeImpact = object({
    effectiveFrom: date,
    assessmentThrough: date,
    currentVersion: version,
    proposedVersion: version,
    currentOccurrences: { type: 'array', items: date },
    proposedOccurrences: { type: 'array', items: date },
    impactByMember: {
        type: 'array',
        items: object({
            memberId: uuid,
            currentFixedAmountInCents: { type: 'string' },
            proposedFixedAmountInCents: { type: 'string' },
            fixedDeltaInCents: { type: 'string' },
            currentVariableWeight: { type: 'integer' },
            proposedVariableWeight: { type: 'integer' },
            variableWeightDelta: { type: 'integer' },
            currentOccurrenceCount: { type: 'integer' },
            proposedOccurrenceCount: { type: 'integer' },
            requiresAcceptance: { type: 'boolean' },
        }),
    },
    requiresAcceptance: { type: 'boolean' },
    materializedOccurrencesPreserved: preserved,
});

export const recurringCommitmentOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        '/v2/spaces/{spaceId}/recurring-commitments': {
            post: {
                operationId: 'createRecurringCommitment',
                tags: ['Finances'],
                security: [{ sessionCookie: [] }],
                parameters: write,
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: ref('CreateRecurringCommitmentRequest'),
                        },
                    },
                },
                responses: {
                    201: response(
                        ref('CreateRecurringCommitmentResponse'),
                        'Série recorrente criada.',
                    ),
                    200: response(
                        ref('CreateRecurringCommitmentResponse'),
                        'Replay autorizado.',
                    ),
                    400: error('VALIDATION_ERROR'),
                    401: error('UNAUTHENTICATED'),
                    404: error('SPACE_NOT_FOUND'),
                    409: error(
                        'EXPENSE_OPTIONS_CHANGED',
                        'IDEMPOTENCY_KEY_REUSED',
                    ),
                },
            },
            get: {
                operationId: 'listRecurringCommitments',
                tags: ['Finances'],
                security: [{ sessionCookie: [] }],
                parameters: [
                    path('spaceId'),
                    month,
                    {
                        name: 'cursor',
                        in: 'query',
                        required: false,
                        schema: { type: 'string' },
                    },
                ],
                responses: {
                    200: response(
                        ref('RecurringCommitmentList'),
                        'Séries com vencimento no mês.',
                    ),
                    400: error('VALIDATION_ERROR'),
                    404: error('SPACE_NOT_FOUND'),
                },
            },
        },
        '/v2/spaces/{spaceId}/recurring-commitments/{id}': {
            get: {
                operationId: 'getRecurringCommitment',
                tags: ['Finances'],
                security: [{ sessionCookie: [] }],
                parameters: [path('spaceId'), path('id')],
                responses: {
                    200: response(
                        object({ commitment: ref('RecurringCommitment') }),
                        'Série e próxima previsão.',
                    ),
                    404: error('FINANCIAL_COMMITMENT_NOT_FOUND'),
                },
            },
        },
        '/v2/spaces/{spaceId}/recurring-commitments/{id}/change-preview': {
            post: {
                operationId: 'previewRecurringCommitmentChange',
                tags: ['Finances'],
                security: [{ sessionCookie: [] }],
                parameters: [
                    path('spaceId'),
                    path('id'),
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
                            schema: ref('ChangeRecurringCommitmentRequest'),
                        },
                    },
                },
                responses: {
                    200: response(
                        ref('RecurringChangePreview'),
                        'Prévia sem gravação dos impactos e fatos preservados.',
                    ),
                    400: error('VALIDATION_ERROR'),
                    404: error(
                        'SPACE_NOT_FOUND',
                        'FINANCIAL_COMMITMENT_NOT_FOUND',
                    ),
                    409: error(
                        'CONCURRENT_MODIFICATION',
                        'EXPENSE_OPTIONS_CHANGED',
                        'RECURRENCE_ALREADY_TERMINATED',
                    ),
                },
            },
        },
        '/v2/spaces/{spaceId}/recurring-commitments/{id}/versions': {
            post: {
                operationId: 'changeRecurringCommitment',
                tags: ['Finances'],
                security: [{ sessionCookie: [] }],
                parameters: [...write, path('id')],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: ref('ChangeRecurringCommitmentRequest'),
                        },
                    },
                },
                responses: {
                    201: response(
                        ref('RecurringVersionChangeResponse'),
                        'Versão futura imutável registrada.',
                    ),
                    200: response(
                        ref('RecurringVersionChangeResponse'),
                        'Replay autorizado.',
                    ),
                    400: error('VALIDATION_ERROR'),
                    404: error(
                        'SPACE_NOT_FOUND',
                        'FINANCIAL_COMMITMENT_NOT_FOUND',
                    ),
                    409: error(
                        'CONCURRENT_MODIFICATION',
                        'EXPENSE_OPTIONS_CHANGED',
                        'IDEMPOTENCY_KEY_REUSED',
                        'RECURRENCE_ACCEPTANCE_REQUIRED',
                        'RECURRENCE_ALREADY_TERMINATED',
                    ),
                },
            },
        },
        '/v2/spaces/{spaceId}/recurring-commitments/{id}/termination': {
            post: {
                operationId: 'terminateRecurringCommitment',
                tags: ['Finances'],
                security: [{ sessionCookie: [] }],
                parameters: [...write, path('id')],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: ref('TerminateRecurringCommitmentRequest'),
                        },
                    },
                },
                responses: {
                    201: response(
                        ref('RecurringTerminationResponse'),
                        'Recorrência encerrada com ocorrências anteriores preservadas.',
                    ),
                    200: response(
                        ref('RecurringTerminationResponse'),
                        'Replay autorizado.',
                    ),
                    400: error('VALIDATION_ERROR'),
                    404: error(
                        'SPACE_NOT_FOUND',
                        'FINANCIAL_COMMITMENT_NOT_FOUND',
                    ),
                    409: error(
                        'CONCURRENT_MODIFICATION',
                        'EXPENSE_OPTIONS_CHANGED',
                        'IDEMPOTENCY_KEY_REUSED',
                        'RECURRENCE_ALREADY_TERMINATED',
                    ),
                },
            },
        },
        '/v2/spaces/{spaceId}/recurring-commitments/{id}/termination-preview': {
            post: {
                operationId: 'previewRecurringTermination',
                tags: ['Finances'],
                security: [{ sessionCookie: [] }],
                parameters: [
                    path('spaceId'),
                    path('id'),
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
                            schema: ref('TerminateRecurringCommitmentRequest'),
                        },
                    },
                },
                responses: {
                    200: response(
                        ref('RecurringTerminationPreview'),
                        'Prévia do corte e ocorrências materializadas preservadas.',
                    ),
                    400: error('VALIDATION_ERROR'),
                    404: error(
                        'SPACE_NOT_FOUND',
                        'FINANCIAL_COMMITMENT_NOT_FOUND',
                    ),
                    409: error(
                        'CONCURRENT_MODIFICATION',
                        'EXPENSE_OPTIONS_CHANGED',
                        'RECURRENCE_ALREADY_TERMINATED',
                    ),
                },
            },
        },
        '/v2/spaces/{spaceId}/recurring-commitments/{id}/occurrences/{referenceDate}/cancellation':
            {
                post: {
                    operationId: 'cancelRecurringOccurrence',
                    tags: ['Finances'],
                    security: [{ sessionCookie: [] }],
                    parameters: [
                        ...write,
                        path('id'),
                        {
                            name: 'referenceDate',
                            in: 'path',
                            required: true,
                            schema: date,
                        },
                    ],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: ref('CancelRecurringOccurrenceRequest'),
                            },
                        },
                    },
                    responses: {
                        201: response(
                            ref('RecurringFulfillmentResponse'),
                            'Ocorrência cancelada sem encerrar a série.',
                        ),
                        200: response(
                            ref('RecurringFulfillmentResponse'),
                            'Replay autorizado.',
                        ),
                        400: error('VALIDATION_ERROR'),
                        404: error(
                            'SPACE_NOT_FOUND',
                            'FINANCIAL_COMMITMENT_NOT_FOUND',
                        ),
                        409: error(
                            'CONCURRENT_MODIFICATION',
                            'OCCURRENCE_ALREADY_RESOLVED',
                            'EXPENSE_OPTIONS_CHANGED',
                            'IDEMPOTENCY_KEY_REUSED',
                        ),
                    },
                },
            },
        '/v2/spaces/{spaceId}/recurring-commitments/{id}/occurrences': {
            get: {
                operationId: 'listRecurringOccurrences',
                tags: ['Finances'],
                security: [{ sessionCookie: [] }],
                parameters: [path('spaceId'), path('id'), month],
                responses: {
                    200: response(
                        ref('RecurringOccurrenceList'),
                        'Projeção substituída pela ocorrência materializada quando houver.',
                    ),
                    400: error('VALIDATION_ERROR'),
                    404: error('FINANCIAL_COMMITMENT_NOT_FOUND'),
                },
            },
        },
        '/v2/spaces/{spaceId}/recurring-commitments/{id}/occurrences/{referenceDate}/options':
            {
                get: {
                    operationId: 'getRecurringOccurrenceOptions',
                    tags: ['Finances'],
                    security: [{ sessionCookie: [] }],
                    parameters: [
                        path('spaceId'),
                        path('id'),
                        {
                            name: 'referenceDate',
                            in: 'path',
                            required: true,
                            schema: date,
                        },
                        {
                            name: 'cursor',
                            in: 'query',
                            required: false,
                            schema: { type: 'string' },
                        },
                    ],
                    responses: {
                        200: response(
                            ref('RecurringOccurrenceOptions'),
                            'Versões, participantes e sugestão atual.',
                        ),
                        404: error('FINANCIAL_COMMITMENT_NOT_FOUND'),
                    },
                },
            },
        '/v2/spaces/{spaceId}/recurring-commitments/{id}/occurrences/{referenceDate}/value':
            {
                put: {
                    ...command(
                        'setRecurringOccurrenceValue',
                        'SetRecurringOccurrenceValueRequest',
                    ),
                    responses: {
                        200: response(
                            ref('RecurringFulfillmentResponse'),
                            'Valor efetivo definido ou resposta reproduzida.',
                        ),
                        400: error('VALIDATION_ERROR'),
                        404: error(
                            'SPACE_NOT_FOUND',
                            'FINANCIAL_COMMITMENT_NOT_FOUND',
                        ),
                        409: error(
                            'CONCURRENT_MODIFICATION',
                            'OCCURRENCE_ALREADY_RESOLVED',
                            'IDEMPOTENCY_KEY_REUSED',
                            'EXPENSE_OPTIONS_CHANGED',
                        ),
                    },
                },
            },
        '/v2/spaces/{spaceId}/recurring-commitments/{id}/occurrences/{referenceDate}/disbursements':
            {
                post: command(
                    'recordRecurringDisbursement',
                    'RecurringDisbursementRequest',
                ),
            },
        '/v2/spaces/{spaceId}/recurring-commitments/{id}/occurrences/{referenceDate}/receipts':
            {
                post: command(
                    'recordRecurringReceipt',
                    'RecurringReceiptRequest',
                ),
            },
        '/v2/spaces/{spaceId}/recurring-commitments/{id}/occurrences/{referenceDate}/external-liabilities':
            {
                post: command(
                    'recordRecurringExternalLiability',
                    'RecurringExternalLiabilityRequest',
                ),
            },
        '/v2/spaces/{spaceId}/recurring-commitments/{id}/occurrences/{referenceDate}/external-liabilities/{liabilityId}/settlements':
            {
                post: {
                    ...command(
                        'settleRecurringExternalLiability',
                        'RecurringExternalSettlementRequest',
                    ),
                    parameters: [
                        ...write,
                        path('id'),
                        {
                            name: 'referenceDate',
                            in: 'path',
                            required: true,
                            schema: date,
                        },
                        path('liabilityId'),
                    ],
                },
            },
    },
    components: {
        schemas: {
            CreateRecurringCommitmentRequest: {
                oneOf: [personal, shared, variablePersonal, variableShared],
            },
            ChangeRecurringCommitmentRequest: changeRequest,
            RecurringChangePreview: object({
                commitmentId: uuid,
                ...changeImpact.properties!,
            }),
            RecurringVersionChangeResponse: object({
                commitment: ref('RecurringCommitment'),
                impact: changeImpact,
                replayed: { type: 'boolean' },
            }),
            TerminateRecurringCommitmentRequest: {
                ...object({
                    expectedCommitmentVersion: version,
                    expectedSpaceVersion: version,
                    endsOn: date,
                }),
                required: ['expectedCommitmentVersion', 'endsOn'],
            },
            RecurringTerminationResponse: object({
                commitment: ref('RecurringCommitment'),
                materializedOccurrencesPreserved: preserved,
                replayed: { type: 'boolean' },
            }),
            RecurringTerminationPreview: object({
                commitmentId: uuid,
                currentVersion: version,
                endsOn: date,
                materializedOccurrencesPreserved: preserved,
            }),
            CancelRecurringOccurrenceRequest: {
                ...object({
                    expectedCommitmentVersion: version,
                    expectedOccurrenceVersion: version,
                    expectedSpaceVersion: version,
                }),
                required: [
                    'expectedCommitmentVersion',
                    'expectedOccurrenceVersion',
                ],
            },
            RecurringCommitment: recurringCommitment,
            CreateRecurringCommitmentResponse: object({
                commitment: ref('RecurringCommitment'),
                replayed: { type: 'boolean' },
            }),
            FinancialOccurrence: occurrence,
            RecurringFulfillmentResponse: result,
            RecurringCommitmentList: object({
                spaceId: uuid,
                month: { type: 'string' },
                items: {
                    type: 'array',
                    maxItems: 20,
                    items: ref('RecurringCommitment'),
                },
                totalCount: { type: 'integer', minimum: 0 },
                totalAmountInCents: { type: 'string' },
                unknownAmountCount: { type: 'integer', minimum: 0 },
                nextCursor: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            }),
            RecurringOccurrenceList: object({
                commitmentId: uuid,
                month: { type: 'string' },
                items: { type: 'array', items: ref('FinancialOccurrence') },
                totalCount: { type: 'integer', minimum: 0 },
                totalAmountInCents: { type: 'string' },
                unknownAmountCount: { type: 'integer', minimum: 0 },
            }),
            RecurringOccurrenceOptions: options,
            SetRecurringOccurrenceValueRequest: {
                oneOf: [
                    object({
                        expectedCommitmentVersion: version,
                        expectedOccurrenceVersion: version,
                        amountInCents: amount,
                    }),
                    object({
                        expectedCommitmentVersion: version,
                        expectedOccurrenceVersion: version,
                        expectedSpaceVersion: version,
                        amountInCents: amount,
                    }),
                ],
            },
            RecurringDisbursementRequest: body({
                method: { type: 'string', enum: ['PIX', 'DEBIT', 'CASH'] },
            }),
            RecurringReceiptRequest: {
                oneOf: [
                    object(commonFact),
                    object({
                        ...commonFact,
                        expectedSpaceVersion: version,
                        recipientMemberId: uuid,
                        settlement: selection,
                    }),
                ],
            },
            RecurringExternalLiabilityRequest: {
                oneOf: [
                    object(commonFact),
                    object({
                        ...commonFact,
                        holderMemberId: uuid,
                        expectedSpaceVersion: version,
                        settlement: selection,
                    }),
                ],
            },
            RecurringExternalSettlementRequest: {
                oneOf: [
                    object({
                        expectedOccurrenceVersion: version,
                        amountInCents: amount,
                        factDate: date,
                    }),
                    object({
                        expectedOccurrenceVersion: version,
                        amountInCents: amount,
                        factDate: date,
                        expectedSpaceVersion: version,
                    }),
                ],
            },
        },
    },
};
