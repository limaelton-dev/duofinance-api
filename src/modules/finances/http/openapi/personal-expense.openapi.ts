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
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
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
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
    },
    description: SchemaObject = {
        type: 'string',
        minLength: 1,
        maxLength: 160,
    },
    method: SchemaObject = { type: 'string', enum: ['PIX', 'DEBIT', 'CASH'] };
const legacyView = object({
    spaceId: uuid,
    spaceType: { type: 'string', enum: ['PERSONAL'] },
    commitment: object({
        id: uuid,
        version: { type: 'integer', enum: [1] },
        kind: { type: 'string', enum: ['EXPENSE'] },
        modality: { type: 'string', enum: ['ONE_TIME'] },
        description,
        amountInCents: money,
        factDate: { oneOf: [date, { type: 'null' }] },
        expectedPaymentDate: { oneOf: [date, { type: 'null' }] },
        registeredAt: instant,
        createdByPersonId: uuid,
        ownerPersonId: uuid,
    }),
    disbursement: object({
        id: uuid,
        payerPersonId: uuid,
        method,
        amountInCents: money,
        factDate: date,
        registeredAt: instant,
    }),
});
(legacyView.properties!.commitment as SchemaObject).required = (
    legacyView.properties!.commitment as SchemaObject
).required!.filter((name) => name !== 'expectedPaymentDate');
const payment = object({
    ...(legacyView.properties!.disbursement as SchemaObject).properties,
    sequence: money,
    recordedByPersonId: uuid,
});
payment.required = payment.required!.filter((name) => name !== 'sequence');
const view = object({
    ...legacyView.properties,
    ...expenseSupportProperties,
    commitment: object({
        ...(legacyView.properties!.commitment as SchemaObject).properties,
        version: money,
    }),
    disbursement: { oneOf: [payment, { type: 'null' }] },
    disbursements: { type: 'array', items: payment },
    paidAmountInCents: { ...money, minimum: 0 },
    remainingAmountInCents: { ...money, minimum: 0 },
    status: expenseStatusSchema,
    overdue: { type: 'boolean' },
});
(view.properties!.commitment as SchemaObject).required = (
    view.properties!.commitment as SchemaObject
).required!.filter((name) => name !== 'expectedPaymentDate');
view.required = view.required!.filter(
    (name) => !(name in expenseSupportProperties) && name !== 'overdue',
);
const result = object({
    ...view.properties,
    replayed: { type: 'boolean' },
});
result.required = result.required!.filter(
    (name) => !(name in expenseSupportProperties) && name !== 'overdue',
);
result.properties = {
    ...result.properties,
    externalLiability: ref('ExternalLiability'),
    settlement: ref('ExternalLiabilitySettlement'),
};
for (const schema of [view, result]) {
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
    409: error('PERSONAL_SPACE_REQUIRED'),
    429: {
        ...error('TOO_MANY_REQUESTS'),
        headers: { 'Retry-After': { schema: { type: 'integer', minimum: 1 } } },
    },
    500: error('INTERNAL_ERROR'),
};
const parameters = [
    { name: 'spaceId', in: 'path' as const, required: true, schema: uuid },
];
const security = [{ sessionCookie: [] }];
export const personalExpenseOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        '/v2/spaces/{spaceId}/personal-expense-options': {
            get: {
                operationId: 'getPersonalExpenseOptions',
                tags: ['Finances'],
                summary: 'Consultar opções de despesa pessoal',
                security,
                parameters,
                responses: {
                    ...errors,
                    200: response(
                        ref('PersonalExpenseOptions'),
                        'Data sugerida da API em America/Sao_Paulo e meios disponíveis; leitura sem escrita.',
                    ),
                },
            },
        },
        '/v2/spaces/{spaceId}/personal-expenses': {
            get: {
                operationId: 'listPersonalExpenses',
                tags: ['Finances'],
                summary: 'Consultar histórico de despesas pessoais',
                security,
                parameters: [
                    ...parameters,
                    {
                        name: 'cursor',
                        in: 'query',
                        required: false,
                        schema: { type: 'string', maxLength: 300 },
                        description:
                            'Cursor canônico do mesmo espaço, data do fato e ID; ordenação decrescente.',
                    },
                ],
                responses: {
                    ...errors,
                    200: response(
                        ref('PersonalExpenseList'),
                        'Até 20 compromissos pessoais, com pago acumulado e restante; pagamentos não duplicam linhas.',
                    ),
                },
            },
            post: {
                operationId: 'recordPersonalExpense',
                tags: ['Finances'],
                summary:
                    'Registrar despesa pessoal com primeiro pagamento parcial ou integral',
                description:
                    'Titular, autoria e pagador derivados da sessão autorizada. disbursement.amountInCents omitido preserva o pagamento integral legado; informado deve ser positivo e até o total. Uma transação grava compromisso, versão, desembolso e recibo. Retry usa a mesma chave e entrada; replay revalida acesso e preserva o resultado histórico, inclusive seu formato legado.',
                security,
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
                            schema: ref('RecordPersonalExpenseRequest'),
                            example: {
                                description: 'Consulta',
                                amountInCents: 12000,
                                factDate: '2026-10-14',
                                disbursement: { method: 'PIX' },
                            },
                        },
                    },
                },
                responses: {
                    ...errors,
                    201: {
                        ...response(
                            ref('RecordPersonalExpenseResponse'),
                            'Criação autorizada.',
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
                    },
                    200: response(
                        {
                            oneOf: [
                                ref('RecordPersonalExpenseResponse'),
                                ref('LegacyPersonalExpenseReplay'),
                            ],
                        },
                        'Replay autorizado do resultado histórico original.',
                    ),
                    403: error('INVALID_CSRF_TOKEN'),
                    409: error(
                        'PERSONAL_SPACE_REQUIRED',
                        'SPACE_NOT_ACTIVE',
                        'IDEMPOTENCY_KEY_REUSED',
                    ),
                },
            },
        },
    },
    components: {
        schemas: {
            PersonalExpenseOptions: object({
                spaceId: uuid,
                referenceDate: date,
                disbursementMethods: {
                    type: 'array',
                    minItems: 3,
                    maxItems: 3,
                    items: method,
                },
            }),
            RecordPersonalExpenseRequest: object({
                description,
                amountInCents: money,
                factDate: date,
                disbursement: {
                    ...object({ method, amountInCents: money }),
                    required: ['method'],
                },
            }),
            PersonalExpenseDetail: view,
            RecordPersonalExpenseResponse: result,
            LegacyPersonalExpenseReplay: object({
                ...legacyView.properties,
                replayed: { type: 'boolean', enum: [true] },
            }),
            PersonalExpenseList: object({
                spaceId: uuid,
                items: {
                    type: 'array',
                    maxItems: 20,
                    items: {
                        ...object({
                            id: uuid,
                            description,
                            amountInCents: money,
                            factDate: { oneOf: [date, { type: 'null' }] },
                            expectedPaymentDate: {
                                oneOf: [date, { type: 'null' }],
                            },
                            relevantDate: date,
                            ...expenseSupportProperties,
                            disbursement: {
                                oneOf: [
                                    object({ amountInCents: money, method }),
                                    { type: 'null' },
                                ],
                            },
                            paidAmountInCents: { ...money, minimum: 0 },
                            remainingAmountInCents: { ...money, minimum: 0 },
                            status: expenseStatusSchema,
                            overdue: { type: 'boolean' },
                        }),
                        required: [
                            'id',
                            'description',
                            'amountInCents',
                            'factDate',
                            'relevantDate',
                            'disbursement',
                            'paidAmountInCents',
                            'remainingAmountInCents',
                            'status',
                        ],
                    },
                },
                nextCursor: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            }),
        },
    },
};
