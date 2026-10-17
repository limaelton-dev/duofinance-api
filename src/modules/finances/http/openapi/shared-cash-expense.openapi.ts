import type {
    OpenAPIObject,
    SchemaObject,
    ReferenceObject,
    ResponseObject,
} from '@nestjs/swagger';
import {
    expenseStatusSchema,
    expenseSupportProperties,
} from './credit-card-purchase.openapi.js';
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
    instant: SchemaObject = { type: 'string', format: 'date-time' },
    money: SchemaObject = {
        type: 'integer',
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
    },
    positive: SchemaObject = { ...money, minimum: 1 },
    nil: SchemaObject = { type: 'null' };
const financialContextSchema = object({
    spaceId: uuid,
    type: { type: 'string', enum: ['SHARED'] },
    status: { type: 'string', enum: ['ACTIVE', 'CLOSING', 'CLOSED'] },
    version: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
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
});
const nullable = (schema: SchemaObject | ReferenceObject): SchemaObject => ({
    oneOf: [schema, nil],
});
const mode = (value: string): SchemaObject => ({
    type: 'string',
    enum: [value],
});
const calculatedShares: SchemaObject = {
    type: 'array',
    minItems: 1,
    maxItems: 2,
    items: object({ memberId: uuid, amountInCents: money }),
};
const amounts = object({
    mode: mode('AMOUNTS'),
    shares: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: object({ memberId: uuid, amountInCents: money }),
    },
});
const percentages = object({
    mode: mode('PERCENTAGES'),
    shares: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: object({
            memberId: uuid,
            basisPoints: { ...money, maximum: 10000 },
        }),
    },
});
const split: SchemaObject = {
    oneOf: [amounts, percentages],
    discriminator: { propertyName: 'mode' },
};
const selection: SchemaObject = {
    oneOf: [
        object({ mode: mode('NONE') }),
        object({ mode: mode('DATE'), targetDate: date }),
        object({ mode: mode('CYCLE'), cycleId: uuid }),
        object({
            mode: mode('SUGGESTED'),
            referenceDate: date,
            expectedRuleVersion: money,
        }),
    ],
    discriminator: { propertyName: 'mode' },
};
const disbursement = object({
    id: uuid,
    payerMemberId: uuid,
    method: { type: 'string', enum: ['PIX', 'DEBIT', 'CASH'] },
    amountInCents: positive,
    factDate: date,
    registeredAt: instant,
});
const obligationProperties = {
    id: uuid,
    originCommitmentId: uuid,
    originDisbursementId: uuid,
    debtorMemberId: uuid,
    creditorMemberId: uuid,
    originalAmountInCents: positive,
    remainingAmountInCents: money,
    status: mode('OPEN'),
    cycleId: nullable(uuid),
};
const cycle = object({ id: uuid, targetDate: date, status: mode('OPEN') });
const commitment = object({
    id: uuid,
    version: positive,
    kind: mode('EXPENSE'),
    modality: mode('ONE_TIME'),
    description: { type: 'string', minLength: 1, maxLength: 160 },
    amountInCents: positive,
    factDate: nullable(date),
    expectedPaymentDate: nullable(date),
    registeredAt: instant,
    createdByPersonId: uuid,
    expectedPayerMemberId: nullable(uuid),
    responsibilitySplit: {
        oneOf: [
            object({ ...amounts.properties, calculatedShares }),
            object({ ...percentages.properties, calculatedShares }),
        ],
        discriminator: { propertyName: 'mode' },
    },
    settlementRuleSnapshot: nullable(ref('SettlementRule')),
    settlementRuleSourceVersion: money,
    suggestedTargetDate: nullable(date),
});
commitment.required = commitment.required!.filter(
    (name) => name !== 'expectedPaymentDate',
);
commitment.properties!.settlementRule = ref('EffectiveSettlementRule');
const legacyInitialProperties = {
    spaceId: uuid,
    commitment,
    disbursement,
    obligation: nullable(object(obligationProperties)),
    settlementCycle: nullable(cycle),
};
const legacyResult = object({
    ...legacyInitialProperties,
    replayed: { type: 'boolean', enum: [true] },
});
const payment = object({
    ...disbursement.properties,
    sequence: positive,
    recordedByPersonId: uuid,
});
payment.required = payment.required!.filter((name) => name !== 'sequence');
const initialProperties = {
    ...legacyInitialProperties,
    ...expenseSupportProperties,
    disbursement: nullable(payment),
    disbursements: { type: 'array' as const, items: payment },
    paidAmountInCents: money,
    remainingAmountInCents: money,
    status: expenseStatusSchema,
    overdue: { type: 'boolean' },
    obligation: nullable(ref('FinancialFulfillmentObligation')),
    obligations: {
        type: 'array' as const,
        items: ref('FinancialFulfillmentObligation'),
    },
    settlementCycle: nullable(
        object({
            ...cycle.properties,
            status: { type: 'string', enum: ['OPEN', 'FINALIZED'] },
        }),
    ),
};
const result = object({ ...initialProperties, replayed: { type: 'boolean' } });
result.required = result.required!.filter(
    (name) => !(name in expenseSupportProperties) && name !== 'overdue',
);
result.properties = {
    ...result.properties,
    members: financialContextSchema.properties!.members,
    externalLiability: ref('ExternalLiability'),
    settlement: ref('ExternalLiabilitySettlement'),
};
const detail = object({
    ...initialProperties,
    obligation: nullable(ref('FinancialFulfillmentObligation')),
    settlementCycle: nullable(
        object({
            ...cycle.properties,
            status: { type: 'string', enum: ['OPEN', 'FINALIZED'] },
        }),
    ),
    members: financialContextSchema.properties!.members,
});
detail.required = detail.required!.filter(
    (name) => !(name in expenseSupportProperties) && name !== 'overdue',
);
for (const schema of [detail, result]) {
    schema.properties = {
        ...schema.properties,
        reversals: {
            type: 'array',
            items: ref('FinancialFulfillmentReversal'),
        },
        validDisbursements: { type: 'array', items: payment },
        validExternalLiabilities: {
            type: 'array',
            items: ref('ExternalLiability'),
        },
    };
}
const input = object({
    expectedSpaceVersion: positive,
    description: { type: 'string', minLength: 1, maxLength: 160 },
    amountInCents: positive,
    factDate: date,
    responsibilitySplit: split,
    expectedPayerMemberId: nullable(uuid),
    disbursement: {
        ...object({
            payerMemberId: uuid,
            method: { type: 'string', enum: ['PIX', 'DEBIT', 'CASH'] },
            amountInCents: positive,
        }),
        required: ['payerMemberId', 'method'],
    },
    settlement: selection,
});
input.required = input.required!.filter(
    (field) => field !== 'expectedPayerMemberId',
);
const options = object({
    ...financialContextSchema.properties,
    referenceDate: date,
    defaultSettlementRule: object({
        rule: nullable(ref('SettlementRule')),
        version: money,
    }),
    suggestedTargetDate: nullable(date),
    openCycles: {
        type: 'array',
        maxItems: 20,
        items: object({ id: uuid, targetDate: date, version: positive }),
    },
    nextCursor: nullable({ type: 'string' }),
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
const errors = {
    400: error('VALIDATION_ERROR'),
    401: error('UNAUTHENTICATED'),
    404: error('SPACE_NOT_FOUND'),
    409: error('SHARED_SPACE_REQUIRED'),
    429: {
        ...error('TOO_MANY_REQUESTS'),
        headers: { 'Retry-After': { schema: { type: 'integer', minimum: 1 } } },
    },
    500: error('INTERNAL_ERROR'),
};
const parameters = [
    { name: 'spaceId', in: 'path' as const, required: true, schema: uuid },
];
const a = '00000000-0000-4000-8000-000000000001',
    b = '00000000-0000-4000-8000-000000000002',
    space = '00000000-0000-4000-8000-000000000003';
const sample = {
    expectedSpaceVersion: 2,
    description: 'Mercado',
    amountInCents: 50000,
    factDate: '2026-10-10',
    responsibilitySplit: {
        mode: 'PERCENTAGES',
        shares: [
            { memberId: a, basisPoints: 4000 },
            { memberId: b, basisPoints: 6000 },
        ],
    },
    expectedPayerMemberId: a,
    disbursement: { payerMemberId: b, method: 'DEBIT' },
    settlement: { mode: 'NONE' },
};
const originalResult = {
    spaceId: space,
    commitment: {
        id: '00000000-0000-4000-8000-000000000004',
        version: 1,
        kind: 'EXPENSE',
        modality: 'ONE_TIME',
        description: 'Mercado',
        amountInCents: 50000,
        factDate: '2026-10-10',
        registeredAt: '2026-10-10T15:00:00.000Z',
        createdByPersonId: '00000000-0000-4000-8000-000000000009',
        expectedPayerMemberId: a,
        responsibilitySplit: {
            ...sample.responsibilitySplit,
            calculatedShares: [
                { memberId: a, amountInCents: 20000 },
                { memberId: b, amountInCents: 30000 },
            ],
        },
        settlementRuleSnapshot: null,
        settlementRuleSourceVersion: 0,
        suggestedTargetDate: null,
    },
    disbursement: {
        id: '00000000-0000-4000-8000-000000000005',
        recordedByPersonId: '00000000-0000-4000-8000-000000000009',
        payerMemberId: b,
        method: 'DEBIT',
        amountInCents: 50000,
        factDate: '2026-10-10',
        registeredAt: '2026-10-10T15:00:00.000Z',
    },
    obligation: {
        id: '00000000-0000-4000-8000-000000000006',
        originCommitmentId: '00000000-0000-4000-8000-000000000004',
        originDisbursementId: '00000000-0000-4000-8000-000000000005',
        debtorMemberId: a,
        creditorMemberId: b,
        originalAmountInCents: 20000,
        recognizedAmountInCents: 20000,
        transferredAmountInCents: 0,
        remainingAmountInCents: 20000,
        status: 'OPEN',
        cycleId: null,
        history: [
            {
                version: 1,
                type: 'CREATED',
                actorId: '00000000-0000-4000-8000-000000000009',
                registeredAt: '2026-10-10T15:00:00.000Z',
                snapshot: {},
            },
        ],
    },
    settlementCycle: null,
    replayed: false,
};
const currentResult = {
    ...originalResult,
    disbursement: { ...originalResult.disbursement, sequence: 1 },
    disbursements: [{ ...originalResult.disbursement, sequence: 1 }],
    externalLiabilities: [],
    assumedAmountInCents: 0,
    externalOutstandingAmountInCents: 0,
    supportedAmountInCents: 50000,
    fulfillmentStatus: 'FULFILLED',
    obligations: [originalResult.obligation],
    paidAmountInCents: 50000,
    remainingAmountInCents: 0,
    status: 'PAID',
};
export const sharedCashExpenseOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        '/v2/spaces/{spaceId}/shared-cash-expense-options': {
            get: {
                operationId: 'getSharedCashExpenseOptions',
                tags: ['Finances'],
                summary: 'Consultar opções para despesa compartilhada',
                description:
                    'Sem writes. Regra ausente: rule null/version 0/sugestão null. Ciclos OPEN em páginas de 20 por data/id, incluindo vencidos. Contexto acessível CLOSING/CLOSED sinaliza escrita indisponível.',
                security: [{ sessionCookie: [] }],
                parameters: [
                    ...parameters,
                    {
                        name: 'cursor',
                        in: 'query',
                        required: false,
                        schema: { type: 'string' },
                        description:
                            'Cursor opaco vinculado ao espaço e à ordem data/id.',
                    },
                ],
                responses: {
                    ...errors,
                    200: {
                        ...response(
                            ref('SharedCashExpenseOptions'),
                            'Opções autorizadas.',
                        ),
                        content: {
                            'application/json': {
                                schema: ref('SharedCashExpenseOptions'),
                                example: {
                                    spaceId: space,
                                    type: 'SHARED',
                                    status: 'ACTIVE',
                                    version: 1,
                                    actorMemberId: a,
                                    members: [
                                        {
                                            memberId: a,
                                            personId: b,
                                            displayName: 'A',
                                        },
                                    ],
                                    referenceDate: '2026-10-10',
                                    defaultSettlementRule: {
                                        rule: null,
                                        version: 0,
                                    },
                                    suggestedTargetDate: null,
                                    openCycles: [],
                                    nextCursor: null,
                                },
                            },
                        },
                    },
                },
            },
        },
        '/v2/spaces/{spaceId}/shared-cash-expenses': {
            post: {
                operationId: 'recordSharedCashExpense',
                tags: ['Finances'],
                summary:
                    'Registrar despesa compartilhada com pagamento parcial ou integral',
                description:
                    'Autoria pela sessão. disbursement.amountInCents omitido significa integral no contrato legado; explícito deve ser positivo e até o valor original. Uma transação grava origem, desembolso, reconciliação, histórico, ciclo eventual e recibo. Responsabilidade original permanece; suporte acumulado determina a pendência. Retry conserva chave/entrada. Sem nova pendência, não cria ciclo.',
                security: [{ sessionCookie: [] }],
                parameters: [
                    ...parameters,
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
                            schema: ref('RecordSharedCashExpenseRequest'),
                            examples: {
                                none: { value: sample },
                                suggested: {
                                    value: {
                                        ...sample,
                                        settlement: {
                                            mode: 'SUGGESTED',
                                            referenceDate: '2026-10-10',
                                            expectedRuleVersion: 1,
                                        },
                                    },
                                },
                                amounts: {
                                    value: {
                                        ...sample,
                                        responsibilitySplit: {
                                            mode: 'AMOUNTS',
                                            shares: [
                                                {
                                                    memberId: a,
                                                    amountInCents: 20000,
                                                },
                                                {
                                                    memberId: b,
                                                    amountInCents: 30000,
                                                },
                                            ],
                                        },
                                        settlement: {
                                            mode: 'DATE',
                                            targetDate: '2026-10-31',
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                responses: {
                    ...errors,
                    201: {
                        ...response(
                            ref('RecordSharedCashExpenseResponse'),
                            'Registro inicial autorizado. obligation e settlementCycle podem ser null.',
                        ),
                        headers: {
                            'Cache-Control': {
                                schema: { type: 'string', enum: ['no-store'] },
                            },
                            Location: {
                                schema: { type: 'string' },
                                description:
                                    'GET /v2/spaces/:spaceId/financial-commitments/:commitmentId',
                            },
                        },
                        content: {
                            'application/json': {
                                schema: ref('RecordSharedCashExpenseResponse'),
                                examples: {
                                    created: { value: currentResult },
                                    noObligation: {
                                        value: {
                                            ...currentResult,
                                            commitment: {
                                                ...originalResult.commitment,
                                                responsibilitySplit: {
                                                    mode: 'AMOUNTS',
                                                    shares: [
                                                        {
                                                            memberId: a,
                                                            amountInCents: 0,
                                                        },
                                                        {
                                                            memberId: b,
                                                            amountInCents: 50000,
                                                        },
                                                    ],
                                                    calculatedShares: [
                                                        {
                                                            memberId: a,
                                                            amountInCents: 0,
                                                        },
                                                        {
                                                            memberId: b,
                                                            amountInCents: 50000,
                                                        },
                                                    ],
                                                },
                                            },
                                            obligation: null,
                                            obligations: [],
                                        },
                                    },
                                },
                            },
                        },
                    },
                    403: error('INVALID_CSRF_TOKEN'),
                    200: response(
                        {
                            oneOf: [
                                ref('RecordSharedCashExpenseResponse'),
                                ref('LegacySharedCashExpenseReplay'),
                            ],
                        },
                        'Replay autorizado preservando o resultado histórico original, inclusive formato legado.',
                    ),
                    404: error('SPACE_NOT_FOUND', 'SETTLEMENT_CYCLE_NOT_FOUND'),
                    409: error(
                        'SHARED_SPACE_REQUIRED',
                        'SPACE_NOT_ACTIVE',
                        'EXPENSE_OPTIONS_CHANGED',
                        'SETTLEMENT_CYCLE_FINALIZED',
                        'IDEMPOTENCY_KEY_REUSED',
                        'CONCURRENT_MODIFICATION',
                    ),
                },
            },
        },
        '/v2/spaces/{spaceId}/financial-commitments/{commitmentId}': {
            get: {
                operationId: 'getFinancialCommitment',
                tags: ['Finances'],
                summary:
                    'Consultar compromisso financeiro e referências atuais',
                description:
                    'Leitura mínima autorizada, sem reconciliação e sem reparo de pendências. Snapshot do compromisso permanece histórico; pendência/ciclo podem refletir estado atual. Não contém replayed.',
                security: [{ sessionCookie: [] }],
                parameters: [
                    ...parameters,
                    {
                        name: 'commitmentId',
                        in: 'path',
                        required: true,
                        schema: uuid,
                    },
                ],
                responses: {
                    ...errors,
                    200: response(
                        {
                            oneOf: [
                                ref('FinancialCommitmentDetail'),
                                ref('PersonalExpenseDetail'),
                                ref('IncomeDetail'),
                            ],
                        },
                        'Despesa rastreável com labels autorizados dos membros.',
                    ),
                    404: error(
                        'SPACE_NOT_FOUND',
                        'FINANCIAL_COMMITMENT_NOT_FOUND',
                    ),
                },
            },
        },
    },
    components: {
        schemas: {
            ResponsibilitySplit: split,
            ExpenseSettlementSelection: selection,
            RecordSharedCashExpenseRequest: input,
            RecordSharedCashExpenseResponse: result,
            LegacySharedCashExpenseReplay: legacyResult,
            SharedCashExpenseOptions: options,
            FinancialCommitmentDetail: detail,
        },
    },
};
