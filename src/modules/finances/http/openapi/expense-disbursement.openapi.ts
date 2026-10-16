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
const instant: SchemaObject = { type: 'string', format: 'date-time' };
const money: SchemaObject = {
    type: 'integer',
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
};
const positive: SchemaObject = { ...money, minimum: 1 };
const method: SchemaObject = { type: 'string', enum: ['PIX', 'DEBIT', 'CASH'] };
const nullable = (schema: SchemaObject | ReferenceObject): SchemaObject => ({
    oneOf: [schema, { type: 'null' }],
});
const commonInput = {
    amountInCents: positive,
    factDate: date,
    method,
    expectedCommitmentVersion: positive,
};
const commonOptions = {
    spaceId: uuid,
    commitmentId: uuid,
    expectedCommitmentVersion: positive,
    amountInCents: positive,
    paidAmountInCents: money,
    remainingAmountInCents: money,
    referenceDate: date,
    canDisburse: { type: 'boolean' as const },
    disbursementMethods: {
        type: 'array' as const,
        items: method,
        minItems: 3,
        maxItems: 3,
    },
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
const parameters = ['spaceId', 'commitmentId'].map((name) => ({
    name,
    in: 'path' as const,
    required: true,
    schema: uuid,
}));
const result: SchemaObject = {
    oneOf: [
        ref('RecordPersonalExpenseResponse'),
        ref('RecordSharedCashExpenseResponse'),
    ],
};
const obligation = object({
    id: uuid,
    originCommitmentId: uuid,
    debtorMemberId: uuid,
    creditorMemberId: uuid,
    originalAmountInCents: positive,
    recognizedAmountInCents: money,
    remainingAmountInCents: money,
    transferredAmountInCents: money,
    status: {
        type: 'string',
        enum: ['OPEN', 'PARTIALLY_SETTLED', 'SETTLED', 'RECONCILED'],
    },
    cycleId: nullable(uuid),
    history: {
        type: 'array',
        items: object({
            version: positive,
            type: {
                type: 'string',
                enum: [
                    'CREATED',
                    'SETTLEMENT_APPLIED',
                    'RECONCILED',
                    'ASSIGNMENT_CHANGED',
                ],
            },
            actorId: uuid,
            registeredAt: instant,
            snapshot: { type: 'object', additionalProperties: true },
        }),
    },
});

export const expenseDisbursementOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        '/v2/spaces/{spaceId}/financial-commitments/{commitmentId}/disbursement-options':
            {
                get: {
                    operationId: 'getExpenseDisbursementOptions',
                    tags: ['Finances'],
                    summary: 'Consultar opções de novo pagamento da despesa',
                    description:
                        'Expõe valor original, acumulado pago, restante e versão atual sem escrever. Pessoal deriva titular; compartilhado inclui membros da origem e snapshot da regra. ACTIVE/CLOSING permitem realização compartilhada existente; CLOSED é somente leitura. Cursor pagina ciclos abertos apenas no compartilhado.',
                    security: [{ sessionCookie: [] }],
                    parameters: [
                        ...parameters,
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
                            ref('ExpenseDisbursementOptions'),
                            'Opções autorizadas; canDisburse exige restante e permissão atual.',
                        ),
                    },
                },
            },
        '/v2/spaces/{spaceId}/financial-commitments/{commitmentId}/disbursements':
            {
                post: {
                    operationId: 'recordExpenseDisbursement',
                    tags: ['Finances'],
                    summary:
                        'Acrescentar pagamento parcial ou integral à despesa existente',
                    description:
                        'Valor positivo até o restante, com data já ocorrida, inclusive retroativa em relação ao cadastro anterior. Preserva compromisso, distribuição, fatos e autoria. Versão capturada não é atualizada automaticamente. Transação única para fato, versão, reconciliação, ciclo eventual e recibo. Replay autorizado devolve o resultado histórico da mesma tentativa. A escolha de acerto vale somente para nova pendência; ciclo da pendência existente é preservado.',
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
                                schema: ref('RecordExpenseDisbursementRequest'),
                            },
                        },
                    },
                    responses: {
                        ...failures,
                        201: {
                            ...response(
                                result,
                                'Pagamento registrado e origem reconciliada.',
                            ),
                            headers: {
                                'Cache-Control': {
                                    schema: {
                                        type: 'string',
                                        enum: ['no-store'],
                                    },
                                },
                                Location: { schema: { type: 'string' } },
                            },
                        },
                        200: response(
                            result,
                            'Replay da mesma tentativa, sem gerar outro fato.',
                        ),
                        403: error('INVALID_CSRF_TOKEN'),
                    },
                },
            },
    },
    components: {
        schemas: {
            FinancialFulfillmentObligation: {
                ...obligation,
                properties: {
                    ...obligation.properties,
                    originDisbursementId: uuid,
                    originReceiptId: uuid,
                    originExternalLiabilityId: uuid,
                },
                oneOf: [
                    { required: ['originDisbursementId'] },
                    { required: ['originReceiptId'] },
                    { required: ['originExternalLiabilityId'] },
                ],
            },
            RecordExpenseDisbursementRequest: {
                oneOf: [
                    object(commonInput),
                    object({
                        ...commonInput,
                        payerMemberId: uuid,
                        expectedSpaceVersion: positive,
                        settlement: ref('ExpenseSettlementSelection'),
                    }),
                ],
            },
            ExpenseDisbursementOptions: {
                oneOf: [
                    object({
                        ...commonOptions,
                        spaceType: { type: 'string', enum: ['PERSONAL'] },
                    }),
                    object({
                        ...commonOptions,
                        spaceType: { type: 'string', enum: ['SHARED'] },
                        expectedSpaceVersion: positive,
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
                        responsibilitySplit: { type: 'object' },
                        expectedPayerMemberId: nullable(uuid),
                        settlementRule: ref('EffectiveSettlementRule'),
                        defaultSettlementRule: object({
                            rule: nullable(ref('SettlementRule')),
                            version: money,
                        }),
                        suggestedTargetDate: nullable(date),
                        openCycles: {
                            type: 'array',
                            maxItems: 20,
                            items: object({
                                id: uuid,
                                targetDate: date,
                                version: positive,
                            }),
                        },
                        nextCursor: nullable({ type: 'string' }),
                    }),
                ],
            },
        },
    },
};
