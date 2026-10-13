import type {
    OpenAPIObject,
    SchemaObject,
    ReferenceObject,
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
    factDate: date,
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
const initialProperties = {
    spaceId: uuid,
    commitment,
    disbursement,
    obligation: nullable(object(obligationProperties)),
    settlementCycle: nullable(cycle),
};
const result = object({ ...initialProperties, replayed: { type: 'boolean' } });
const detail = object({
    ...initialProperties,
    obligation: nullable(
        object({
            ...obligationProperties,
            status: {
                type: 'string',
                enum: ['OPEN', 'PARTIALLY_SETTLED', 'SETTLED'],
                description:
                    'Estado atual da pendência; a leitura não reconcilia.',
            },
        }),
    ),
    settlementCycle: nullable(
        object({
            ...cycle.properties,
            status: { type: 'string', enum: ['OPEN', 'FINALIZED'] },
        }),
    ),
    members: financialContextSchema.properties!.members,
});
const input = object({
    expectedSpaceVersion: positive,
    description: { type: 'string', minLength: 1, maxLength: 160 },
    amountInCents: positive,
    factDate: date,
    responsibilitySplit: split,
    expectedPayerMemberId: nullable(uuid),
    disbursement: object({
        payerMemberId: uuid,
        method: { type: 'string', enum: ['PIX', 'DEBIT', 'CASH'] },
    }),
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
        remainingAmountInCents: 20000,
        status: 'OPEN',
        cycleId: null,
    },
    settlementCycle: null,
    replayed: false,
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
                    'Registrar despesa integralmente paga e pendência inicial',
                description:
                    'Autoria pela sessão. Uma transação grava a origem, desembolso, reconciliação, histórico, ciclo opcional e recibo. Retry conserva chave/entrada. Sem pendência, settlement NONE e nenhuma criação de ciclo.',
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
                            'Registro inicial ou replay histórico autorizado; replayed true preserva IDs/datas/valores originais. obligation e settlementCycle podem ser null.',
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
                                    created: { value: originalResult },
                                    replay: {
                                        value: {
                                            ...originalResult,
                                            replayed: true,
                                        },
                                    },
                                    noObligation: {
                                        value: {
                                            ...originalResult,
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
                                        },
                                    },
                                },
                            },
                        },
                    },
                    403: error('INVALID_CSRF_TOKEN'),
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
                summary: 'Consultar despesa e referências financeiras atuais',
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
                        ref('FinancialCommitmentDetail'),
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
            SharedCashExpenseOptions: options,
            FinancialCommitmentDetail: detail,
        },
    },
};
