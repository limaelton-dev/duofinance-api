import type {
    OpenAPIObject,
    OperationObject,
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
const nullable = (schema: SchemaObject | ReferenceObject): SchemaObject => ({
    oneOf: [schema, { type: 'null' }],
});
const status: SchemaObject = {
    type: 'string',
    enum: ['OPEN', 'PARTIALLY_SETTLED', 'SETTLED', 'RECONCILED', 'WAIVED'],
};
const obligation = {
    id: uuid,
    version: amount,
    status,
    cycleId: nullable(uuid),
    remainingAmountInCents: { ...amount, minimum: 0 },
};
const waiverObligation = object({ ...obligation, closureAgreementId: uuid });
waiverObligation.required = waiverObligation.required?.filter(
    (name) => name !== 'closureAgreementId',
);
const waiverOptionsObligation = object({
    ...obligation,
    closureAgreementId: uuid,
    debtorMemberId: uuid,
    creditorMemberId: uuid,
});
waiverOptionsObligation.required = waiverOptionsObligation.required?.filter(
    (name) => name !== 'closureAgreementId',
);
const fact = {
    spaceId: uuid,
    waiver: object({
        id: uuid,
        obligationId: uuid,
        creditorMemberId: uuid,
        amountInCents: amount,
        factDate: date,
        registeredAt: { type: 'string', format: 'date-time' },
        createdByPersonId: uuid,
        reason: nullable({ type: 'string', maxLength: 500 }),
    }),
    obligation: waiverObligation,
    affectedCycleIds: {
        type: 'array' as const,
        uniqueItems: true,
        items: uuid,
    },
    replayed: { type: 'boolean' as const },
};
const response = (schema: string, description: string): ResponseObject => ({
    description,
    headers: {
        'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
    },
    content: { 'application/json': { schema: ref(schema) } },
});
const errors = {
    400: response(
        'ErrorResponse',
        'VALIDATION_ERROR: revise o campo informado.',
    ),
    401: response('ErrorResponse', 'UNAUTHENTICATED.'),
    403: response(
        'ErrorResponse',
        'OBLIGATION_CREDITOR_REQUIRED: somente o credor autenticado dispensa. INVALID_CSRF_TOKEN: atualize a sessão.',
    ),
    404: response(
        'ErrorResponse',
        'Espaço ou pendência inexistente ou inacessível.',
    ),
    409: response(
        'ErrorResponse',
        'CONCURRENT_MODIFICATION exige releitura; SETTLEMENT_CYCLE_FINALIZED impede alteração; IDEMPOTENCY_KEY_REUSED exige a chave e entrada originais. Espaço fechado bloqueia nova dispensa.',
    ),
    429: response('ErrorResponse', 'TOO_MANY_REQUESTS.'),
    500: response('ErrorResponse', 'INTERNAL_ERROR, sem alteração parcial.'),
};
const parameters = ['spaceId', 'obligationId'].map((name) => ({
    name,
    in: 'path' as const,
    required: true,
    schema: uuid,
}));
const operation = (
    operationId: string,
    summary: string,
    schema: string,
): OperationObject => ({
    operationId,
    tags: ['Finances'],
    summary,
    security: [{ sessionCookie: [] }],
    parameters: [...parameters],
    responses: { ...errors, 200: response(schema, 'Consulta autorizada.') },
});
const options = operation(
    'getObligationWaiverOptions',
    'Consultar saldo e elegibilidade para dispensa pelo credor',
    'ObligationWaiverOptions',
);
const history = operation(
    'listObligationWaivers',
    'Consultar histórico de dispensas de uma pendência',
    'ObligationWaiverHistory',
);
history.parameters?.push({
    name: 'cursor',
    in: 'query',
    required: false,
    schema: { type: 'string', minLength: 1, maxLength: 512 },
    description: 'Cursor opaco vinculado ao ator, espaço e pendência.',
});
const record = operation(
    'waiveInterMemberObligation',
    'Dispensar parte ou todo o restante por decisão do credor',
    'RecordObligationWaiverResponse',
);
record.description =
    'Somente o credor autenticado confirma valor positivo até o restante. Dispensa parcial preserva condição parcial; dispensar todo o restante resulta em WAIVED, inclusive após transferência ou compensação. A origem econômica, os pagamentos anteriores e as datas dos fatos permanecem preservados. Dispensa não representa dinheiro transferido nem receita. Motivo opcional, com espaços externos removidos, vazio tratado como ausência e limite de 500 caracteres. Dispensa, alteração, histórico, auditoria e recibo são atômicos. Repita a chave e entrada originais após resultado incerto.';
record.parameters?.push(
    {
        name: 'X-CSRF-Token',
        in: 'header',
        required: true,
        schema: { type: 'string' },
    },
    { name: 'Idempotency-Key', in: 'header', required: true, schema: uuid },
);
record.requestBody = {
    required: true,
    content: {
        'application/json': { schema: ref('RecordObligationWaiverRequest') },
    },
};
record.responses = {
    ...errors,
    200: response('RecordObligationWaiverResponse', 'Replay autorizado.'),
    201: response('RecordObligationWaiverResponse', 'Dispensa confirmada.'),
};
const request = object({
    expectedSpaceVersion: amount,
    expectedObligationVersion: amount,
    amountInCents: amount,
    factDate: date,
    reason: { type: 'string', maxLength: 500 },
});
request.required = request.required?.filter((name) => name !== 'reason');

export const obligationWaiverOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        '/v2/spaces/{spaceId}/inter-member-obligations/{obligationId}/waiver-options':
            {
                get: options,
            },
        '/v2/spaces/{spaceId}/inter-member-obligations/{obligationId}/waivers':
            {
                post: record,
                get: history,
            },
    },
    components: {
        schemas: {
            RecordObligationWaiverRequest: request,
            RecordObligationWaiverResponse: object(fact),
            ObligationWaiverHistoryItem: object(fact),
            ObligationWaiverOptions: object({
                spaceId: uuid,
                spaceStatus: {
                    type: 'string',
                    enum: ['ACTIVE', 'CLOSING', 'CLOSED'],
                },
                spaceVersion: amount,
                actorMemberId: uuid,
                members: {
                    type: 'array',
                    items: object({
                        memberId: uuid,
                        personId: uuid,
                        displayName: { type: 'string' },
                    }),
                },
                referenceDate: date,
                obligation: waiverOptionsObligation,
                settlementCycle: nullable(
                    object({
                        id: uuid,
                        version: amount,
                        targetDate: date,
                        status: { type: 'string', enum: ['OPEN', 'FINALIZED'] },
                    }),
                ),
                canWaive: { type: 'boolean' },
                waiverBlockReason: nullable({
                    type: 'string',
                    enum: [
                        'CREDITOR_REQUIRED',
                        'SPACE_CLOSED',
                        'SETTLEMENT_CYCLE_FINALIZED',
                        'OBLIGATION_ALREADY_RESOLVED',
                    ],
                }),
            }),
            ObligationWaiverHistory: object({
                spaceId: uuid,
                obligationId: uuid,
                items: {
                    type: 'array',
                    maxItems: 20,
                    items: ref('ObligationWaiverHistoryItem'),
                },
                page: object({
                    pageSize: { type: 'integer', enum: [20] },
                    nextCursor: nullable({ type: 'string' }),
                }),
            }),
        },
    },
};
