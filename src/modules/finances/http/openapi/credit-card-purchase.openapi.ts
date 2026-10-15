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
const money: SchemaObject = {
    type: 'integer',
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
};
const positive: SchemaObject = { ...money, minimum: 1 };
const nullable = (schema: SchemaObject | ReferenceObject): SchemaObject => ({
    oneOf: [schema, { type: 'null' }],
});
export const expenseStatusSchema: SchemaObject = {
    type: 'string',
    enum: ['PARTIALLY_PAID', 'PAID', 'PARTIALLY_FULFILLED', 'FULFILLED'],
};
export const expenseSupportProperties: Record<
    string,
    SchemaObject | ReferenceObject
> = {
    externalLiabilities: { type: 'array', items: ref('ExternalLiability') },
    assumedAmountInCents: money,
    externalOutstandingAmountInCents: money,
    supportedAmountInCents: money,
    fulfillmentStatus: {
        type: 'string',
        enum: ['PARTIALLY_FULFILLED', 'FULFILLED'],
    },
};
const fact = {
    id: uuid,
    sequence: positive,
    amountInCents: positive,
    remainingAmountInCents: positive,
    factDate: date,
    registeredAt: { type: 'string' as const, format: 'date-time' },
    recordedByPersonId: uuid,
};
const description: SchemaObject = {
    type: 'string',
    minLength: 1,
    maxLength: 160,
};
const initial = {
    description,
    amountInCents: positive,
    factDate: date,
};
const sharedInput = {
    expectedSpaceVersion: positive,
    responsibilitySplit: ref('ResponsibilitySplit'),
    expectedPayerMemberId: nullable(uuid),
    settlement: ref('ExpenseSettlementSelection'),
};
const purchaseInput = (shared: boolean): SchemaObject => {
    const input = object({
        ...initial,
        ...(shared ? sharedInput : {}),
        externalLiability: {
            ...object({
                ...(shared ? { holderMemberId: uuid } : {}),
                amountInCents: positive,
            }),
            required: shared ? ['holderMemberId'] : [],
        },
    });
    input.required = input.required!.filter(
        (name) => name !== 'expectedPayerMemberId',
    );
    return input;
};
const members: SchemaObject = {
    type: 'array',
    minItems: 1,
    maxItems: 2,
    items: object({
        memberId: uuid,
        personId: uuid,
        displayName: { type: 'string' },
    }),
};
const settlementOptions = {
    members,
    defaultSettlementRule: object({
        rule: nullable(ref('SettlementRule')),
        version: money,
    }),
    suggestedTargetDate: nullable(date),
    openCycles: {
        type: 'array' as const,
        maxItems: 20,
        items: object({ id: uuid, targetDate: date, version: positive }),
    },
    nextCursor: nullable({ type: 'string' }),
};
const additionalInput = {
    amountInCents: positive,
    factDate: date,
    expectedCommitmentVersion: positive,
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
        'PERSONAL_SPACE_REQUIRED',
        'SHARED_SPACE_REQUIRED',
        'EXPENSE_ALREADY_PAID',
        'EXPENSE_OPTIONS_CHANGED',
        'CONCURRENT_MODIFICATION',
        'IDEMPOTENCY_KEY_REUSED',
        'SETTLEMENT_CYCLE_FINALIZED',
    ),
    429: error('TOO_MANY_REQUESTS'),
    500: error('INTERNAL_ERROR'),
};
const parameters = (existing: boolean) =>
    (existing ? ['spaceId', 'commitmentId'] : ['spaceId']).map((name) => ({
        name,
        in: 'path' as const,
        required: true,
        schema: uuid,
    }));
const security = [{ sessionCookie: [] }];
const read = (existing: boolean) => ({
    operationId: existing
        ? 'getExternalLiabilityOptions'
        : 'getCreditCardPurchaseOptions',
    tags: ['Finances'],
    summary: existing
        ? 'Consultar opções de suporte adicional no cartão'
        : 'Consultar opções de compra no cartão',
    description:
        'Leitura autorizada sem criar fatos, pendências ou ciclos. Não há cadastro de cartão ou fatura. Cursor pagina somente os ciclos abertos do compartilhado.',
    security,
    parameters: [
        ...parameters(existing),
        {
            name: 'cursor',
            in: 'query' as const,
            required: false,
            schema: { type: 'string' as const },
        },
    ],
    responses: {
        ...failures,
        200: response(
            ref(
                existing
                    ? 'ExternalLiabilityOptions'
                    : 'CreditCardPurchaseOptions',
            ),
            'Titular pessoal é derivado da sessão; membros e regra pertencem ao espaço autorizado.',
        ),
    },
});
const write = (existing: boolean) => ({
    operationId: existing
        ? 'recordExternalLiability'
        : 'recordCreditCardPurchase',
    tags: ['Finances'],
    summary: existing
        ? 'Acrescentar obrigação externa à despesa existente'
        : 'Registrar compra no cartão como obrigação externa',
    description:
        'Registra suporte financeiro sem criar desembolso. Valor positivo até o restante a realizar, com data já ocorrida. Titular independe do autor, previsto e responsabilidade. Transação única para fato, versão, reconciliação da mesma origem, eventual ciclo e recibo. Compra nova exige ACTIVE; realização existente segue a política de fulfillment. Replay autorizado preserva resposta histórica. Não liquida obrigação externa nem gerencia fatura.',
    security,
    parameters: [
        ...parameters(existing),
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
    ],
    requestBody: {
        required: true,
        content: {
            'application/json': {
                schema: ref(
                    existing
                        ? 'RecordExternalLiabilityRequest'
                        : 'RecordCreditCardPurchaseRequest',
                ),
            },
        },
    },
    responses: {
        ...failures,
        201: {
            ...response(
                ref('CreditCardPurchaseResponse'),
                'Suporte registrado.',
            ),
            headers: {
                'Cache-Control': {
                    schema: { type: 'string' as const, enum: ['no-store'] },
                },
                Location: { schema: { type: 'string' as const } },
            },
        },
        200: response(
            ref('CreditCardPurchaseResponse'),
            'Replay da mesma tentativa, sem novo fato.',
        ),
        403: error('INVALID_CSRF_TOKEN'),
    },
});
export const creditCardPurchaseOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        '/v2/spaces/{spaceId}/credit-card-purchase-options': {
            get: read(false),
        },
        '/v2/spaces/{spaceId}/credit-card-purchases': { post: write(false) },
        '/v2/spaces/{spaceId}/financial-commitments/{commitmentId}/external-liability-options':
            { get: read(true) },
        '/v2/spaces/{spaceId}/financial-commitments/{commitmentId}/external-liabilities':
            { post: write(true) },
    },
    components: {
        schemas: {
            ExternalLiability: {
                oneOf: [
                    object({ ...fact, holderMemberId: uuid }),
                    object({ ...fact, holderPersonId: uuid }),
                ],
            },
            RecordCreditCardPurchaseRequest: {
                oneOf: [purchaseInput(false), purchaseInput(true)],
            },
            RecordExternalLiabilityRequest: {
                oneOf: [
                    object(additionalInput),
                    object({
                        ...additionalInput,
                        holderMemberId: uuid,
                        expectedSpaceVersion: positive,
                        settlement: ref('ExpenseSettlementSelection'),
                    }),
                ],
            },
            CreditCardPurchaseResponse: {
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
                            'externalLiability',
                            ...Object.keys(expenseSupportProperties),
                        ],
                    },
                ],
            },
            CreditCardPurchaseOptions: {
                oneOf: [
                    object({
                        spaceId: uuid,
                        spaceType: { type: 'string', enum: ['PERSONAL'] },
                        referenceDate: date,
                    }),
                    object({
                        ...settlementOptions,
                        spaceId: uuid,
                        spaceType: { type: 'string', enum: ['SHARED'] },
                        type: { type: 'string', enum: ['SHARED'] },
                        status: {
                            type: 'string',
                            enum: ['ACTIVE', 'CLOSING', 'CLOSED'],
                        },
                        version: positive,
                        actorMemberId: uuid,
                        referenceDate: date,
                    }),
                ],
            },
            ExternalLiabilityOptions: {
                oneOf: [
                    object({
                        spaceId: uuid,
                        spaceType: { type: 'string', enum: ['PERSONAL'] },
                        commitmentId: uuid,
                        expectedCommitmentVersion: positive,
                        amountInCents: positive,
                        paidAmountInCents: money,
                        remainingAmountInCents: money,
                        referenceDate: date,
                        canAssume: { type: 'boolean' },
                    }),
                    object({
                        ...settlementOptions,
                        spaceId: uuid,
                        spaceType: { type: 'string', enum: ['SHARED'] },
                        commitmentId: uuid,
                        expectedCommitmentVersion: positive,
                        expectedSpaceVersion: positive,
                        amountInCents: positive,
                        paidAmountInCents: money,
                        remainingAmountInCents: money,
                        referenceDate: date,
                        canAssume: { type: 'boolean' },
                        responsibilitySplit: { type: 'object' },
                        expectedPayerMemberId: nullable(uuid),
                    }),
                ],
            },
        },
    },
};
