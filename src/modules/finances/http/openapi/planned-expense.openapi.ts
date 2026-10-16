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
const shared = object({
    scope: { type: 'string', enum: ['SHARED'] },
    description: { type: 'string', minLength: 1, maxLength: 160 },
    amountInCents: amount,
    expectedPaymentDate: date,
    expectedSpaceVersion: { type: 'integer', minimum: 1 },
    responsibilitySplit: ref('ResponsibilitySplit'),
    expectedPayerMemberId: { oneOf: [uuid, { type: 'null' }] },
});
shared.required = shared.required!.filter(
    (name) => name !== 'expectedPayerMemberId',
);
const personal = object({
    scope: { type: 'string', enum: ['PERSONAL'] },
    description: { type: 'string', minLength: 1, maxLength: 160 },
    amountInCents: amount,
    expectedPaymentDate: date,
});
const item = object({
    id: uuid,
    description: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    registeredAt: { type: 'string', format: 'date-time' },
    createdByPersonId: uuid,
    ownerPersonId: { oneOf: [uuid, { type: 'null' }] },
    amountInCents: amount,
    expectedPaymentDate: date,
    paidAmountInCents: { ...amount, minimum: 0 },
    assumedAmountInCents: { ...amount, minimum: 0 },
    remainingAmountInCents: { ...amount, minimum: 0 },
    status: {
        type: 'string',
        enum: ['PENDING', 'PARTIALLY_FULFILLED', 'FULFILLED'],
    },
    overdue: { type: 'boolean' },
});

export const plannedExpenseOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        '/v2/spaces/{spaceId}/planned-expenses': {
            get: {
                operationId: 'listPlannedExpenses',
                tags: ['Finances'],
                summary: 'Consultar despesas avulsas com data prevista',
                security: [{ sessionCookie: [] }],
                parameters: [
                    {
                        name: 'spaceId',
                        in: 'path',
                        required: true,
                        schema: uuid,
                    },
                    {
                        name: 'month',
                        in: 'query',
                        required: true,
                        schema: {
                            type: 'string',
                            pattern: '^\\d{4}-(0[1-9]|1[0-2])$',
                        },
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
                        ref('PlannedExpenseList'),
                        'Previsão e restante do mês inteiro.',
                    ),
                    400: error('VALIDATION_ERROR'),
                    401: error('UNAUTHENTICATED'),
                    404: error('SPACE_NOT_FOUND'),
                },
            },
            post: {
                operationId: 'createPlannedExpense',
                tags: ['Finances'],
                summary: 'Cadastrar despesa avulsa ainda não paga',
                security: [{ sessionCookie: [] }],
                parameters: [
                    {
                        name: 'spaceId',
                        in: 'path',
                        required: true,
                        schema: uuid,
                    },
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
                            schema: ref('CreatePlannedExpenseRequest'),
                        },
                    },
                },
                responses: {
                    201: response(
                        ref('CreatePlannedExpenseResponse'),
                        'Compromisso pendente criado.',
                    ),
                    200: response(
                        ref('CreatePlannedExpenseResponse'),
                        'Replay autorizado.',
                    ),
                    400: error('VALIDATION_ERROR'),
                    401: error('UNAUTHENTICATED'),
                    403: error('INVALID_CSRF_TOKEN'),
                    404: error('SPACE_NOT_FOUND'),
                    409: error(
                        'PERSONAL_SPACE_REQUIRED',
                        'SHARED_SPACE_REQUIRED',
                        'SPACE_NOT_ACTIVE',
                        'EXPENSE_OPTIONS_CHANGED',
                        'IDEMPOTENCY_KEY_REUSED',
                    ),
                },
            },
        },
    },
    components: {
        schemas: {
            CreatePlannedExpenseRequest: {
                oneOf: [personal, shared],
                discriminator: { propertyName: 'scope' },
            },
            CreatePlannedExpenseResponse: {
                oneOf: [
                    ref('RecordPersonalExpenseResponse'),
                    ref('RecordSharedCashExpenseResponse'),
                ],
            },
            PlannedExpenseList: object({
                spaceId: uuid,
                month: { type: 'string' },
                items: { type: 'array', maxItems: 20, items: item },
                totals: object({
                    expectedExpenseAmountInCents: {
                        type: 'string',
                        pattern: '^\\d+$',
                    },
                    remainingExpenseAmountInCents: {
                        type: 'string',
                        pattern: '^\\d+$',
                    },
                }),
                nextCursor: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            }),
        },
    },
};
