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
const instant: SchemaObject = { type: 'string', format: 'date-time' };
const positive: SchemaObject = {
    type: 'integer',
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
};
const money: SchemaObject = { ...positive, minimum: 0 };
const signed: SchemaObject = { type: 'string', pattern: '^-?\\d+$' };
const boolean: SchemaObject = { type: 'boolean' };
const nullable = (schema: SchemaObject | ReferenceObject): SchemaObject => ({
    oneOf: [schema, { type: 'null' }],
});
const kind: SchemaObject = {
    type: 'string',
    enum: [
        'DISBURSEMENT',
        'EXTERNAL_LIABILITY',
        'EXTERNAL_SETTLEMENT',
        'RECEIPT',
    ],
};
const settlement: SchemaObject = {
    oneOf: [
        object({ mode: { type: 'string', enum: ['NONE'] } }),
        object({ mode: { type: 'string', enum: ['DATE'] }, targetDate: date }),
        object({ mode: { type: 'string', enum: ['CYCLE'] }, cycleId: uuid }),
        object({
            mode: { type: 'string', enum: ['SUGGESTED'] },
            referenceDate: date,
            expectedRuleVersion: positive,
        }),
    ],
};
const input = object({
    expectedCommitmentVersion: positive,
    expectedSpaceVersion: positive,
    expectedOccurrenceVersion: positive,
    occurrenceId: uuid,
    referenceDate: date,
    installmentId: uuid,
    originalKind: kind,
    originalId: uuid,
    amountInCents: {
        ...positive,
        description:
            'Valor positivo a compensar; a soma das reversões não pode exceder o valor original. Quitação global indivisível exige reversão integral.',
    },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
    factDate: {
        ...date,
        description:
            'Data civil da compensação, igual ou posterior à data do original e até hoje em America/Sao_Paulo. Não altera a data histórica do original.',
    },
    settlement,
});
input.required = [
    'expectedCommitmentVersion',
    'originalKind',
    'originalId',
    'amountInCents',
    'reason',
    'factDate',
];
input.description =
    'Compensa um fato da mesma origem, preservando seu valor, autor e data. SHARED exige expectedSpaceVersion. Para recorrência informe occurrenceId/referenceDate e expectedOccurrenceVersion; para parcela informe installmentId e expectedOccurrenceVersion. Avulso e desembolso global de quitação não aceitam alvo de outra modalidade. Seleção de acerto ausente equivale a NONE. A liquidação externa preserva a autorização do titular.';
const target = object({
    type: {
        type: 'string',
        enum: ['COMMITMENT', 'OCCURRENCE', 'INSTALLMENT', 'GLOBAL_PAYOFF'],
    },
    id: uuid,
    referenceDate: nullable(date),
    occurrenceId: nullable(uuid),
    installmentId: nullable(uuid),
});
const reversal = object({
    id: uuid,
    spaceId: uuid,
    commitmentId: uuid,
    targetId: uuid,
    commitmentVersion: positive,
    occurrenceId: nullable(uuid),
    installmentId: nullable(uuid),
    originalKind: kind,
    originalId: uuid,
    amountInCents: positive,
    reason: { type: 'string', minLength: 1, maxLength: 500 },
    factDate: date,
    actorId: uuid,
    registeredAt: instant,
});
const previewProperties = {
    commitmentId: uuid,
    target,
    currentVersion: positive,
    expectedOccurrenceVersion: positive,
    original: object({
        id: uuid,
        kind,
        amountInCents: positive,
        factDate: date,
        registeredAt: instant,
        recordedByPersonId: uuid,
        memberId: nullable(uuid),
        personId: nullable(uuid),
        externalLiabilityId: nullable(uuid),
        occurrenceId: nullable(uuid),
        installmentId: nullable(uuid),
        reversedAmountInCents: money,
        reversibleAmountInCents: money,
    }),
    previousReversals: {
        type: 'array',
        items: ref('FinancialFulfillmentReversal'),
    } as SchemaObject,
    amountInCents: positive,
    resultingFulfilledAmountInCents: nullable(money),
    resultingRemainingAmountInCents: nullable(money),
    cashImpactInCents: {
        ...signed,
        description:
            'Impacto compensatório: desembolso e liquidação externa positivos; recebimento negativo; obrigação externa zero.',
    },
    supportedImpactInCents: signed,
    externalOutstandingImpactInCents: signed,
    eligible: boolean,
    blockingReason: nullable({ type: 'string' }),
    requiresFullReversal: boolean,
    blockingGlobalPayoffId: nullable(uuid),
    reconciliation: nullable(
        object({
            currentPendingAmountInCents: signed,
            proposedDifference: nullable(
                object({
                    debtorMemberId: uuid,
                    creditorMemberId: uuid,
                    amountInCents: positive,
                }),
            ),
            requiresOpenCycle: boolean,
            finalizedCycleIds: { type: 'array', items: uuid },
            blockingReason: nullable({ type: 'string' }),
        }),
    ),
};
const preview = object(previewProperties);
preview.required = preview.required!.filter(
    (name) => name !== 'expectedOccurrenceVersion',
);
const commandResponse = object({
    ...previewProperties,
    reversal: ref('FinancialFulfillmentReversal'),
    version: positive,
    replayed: boolean,
});
commandResponse.required = commandResponse.required!.filter(
    (name) => name !== 'expectedOccurrenceVersion',
);
const response = (schema: string, description: string): ResponseObject => ({
    description,
    headers: {
        'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
    },
    content: { 'application/json': { schema: ref(schema) } },
});
const error = (...codes: string[]): ResponseObject => ({
    ...response('ErrorResponse', codes.join(', ')),
    content: {
        'application/json': {
            schema: {
                allOf: [
                    ref('ErrorResponse'),
                    {
                        type: 'object',
                        properties: { code: { type: 'string', enum: codes } },
                    },
                ],
            },
        },
    },
});
const parameters: NonNullable<OperationObject['parameters']> = [
    { name: 'spaceId', in: 'path', required: true, schema: uuid },
    { name: 'commitmentId', in: 'path', required: true, schema: uuid },
];
const errors = {
    400: error('VALIDATION_ERROR'),
    401: error('UNAUTHENTICATED'),
    403: error('INVALID_CSRF_TOKEN', 'EXTERNAL_LIABILITY_HOLDER_REQUIRED'),
    404: error(
        'SPACE_NOT_FOUND',
        'FINANCIAL_COMMITMENT_NOT_FOUND',
        'FINANCIAL_REVERSAL_NOT_FOUND',
        'SETTLEMENT_CYCLE_NOT_FOUND',
    ),
    409: error(
        'CONCURRENT_MODIFICATION',
        'IDEMPOTENCY_KEY_REUSED',
        'EXPENSE_OPTIONS_CHANGED',
        'SPACE_NOT_ACTIVE',
        'FINANCIAL_REVERSAL_EXCEEDS_AVAILABLE',
        'FINANCIAL_REVERSAL_SETTLEMENT_REQUIRED',
        'FINANCIAL_REVERSAL_FULL_REQUIRED',
        'REVERSAL_CORRECTION_CYCLE_REQUIRED',
        'SETTLEMENT_CYCLE_FINALIZED',
    ),
    429: error('TOO_MANY_REQUESTS'),
    500: error('INTERNAL_ERROR'),
};
function command(preview: boolean): OperationObject {
    return {
        operationId: preview
            ? 'previewFinancialFulfillmentReversal'
            : 'reverseFinancialFulfillment',
        tags: ['Finances'],
        summary: preview
            ? 'Simular reversão de realização financeira'
            : 'Reverter realização financeira preservando o original',
        description:
            'Preserva fatos originais e acertos já realizados. Reversão de desembolso/obrigação reduz suporte; reversão de recebimento pode produzir pendência de retorno. Liquidação externa altera somente caixa e saldo externo. Principal externo não pode ficar abaixo das liquidações válidas; reverta primeiro as liquidações necessárias. Quitação global não é repartida entre parcelas. Ciclo finalizado permanece intacto; quando houver novo efeito, selecione ciclo aberto apropriado. ' +
            (preview
                ? 'Não escreve fatos, ocorrências, ciclos ou recibos; bloqueios de domínio são apresentados em eligible/blockingReason.'
                : 'Compensação, reconciliação, recibo e auditoria são atômicos. Replay devolve o resultado persistido após revalidar acesso.'),
        security: [{ sessionCookie: [] }],
        parameters: [
            ...parameters,
            {
                name: 'X-CSRF-Token',
                in: 'header',
                required: true,
                schema: { type: 'string' },
            },
            ...(preview
                ? []
                : [
                      {
                          name: 'Idempotency-Key',
                          in: 'header' as const,
                          required: true,
                          schema: uuid,
                      },
                  ]),
        ],
        requestBody: {
            required: true,
            content: {
                'application/json': {
                    schema: ref('FinancialFulfillmentReversalRequest'),
                },
            },
        },
        responses: {
            200: response(
                preview
                    ? 'FinancialFulfillmentReversalPreview'
                    : 'FinancialFulfillmentReversalResponse',
                preview
                    ? 'Prévia informativa, inclusive bloqueios.'
                    : 'Replay autorizado, sem duplicação.',
            ),
            ...(preview
                ? {}
                : {
                      201: response(
                          'FinancialFulfillmentReversalResponse',
                          'Compensação confirmada e saldos recalculados.',
                      ),
                  }),
            ...errors,
        },
    };
}
const base = '/v2/spaces/{spaceId}/financial-commitments/{commitmentId}';
export const financialReversalOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        [`${base}/reversal-preview`]: { post: command(true) },
        [`${base}/reversals`]: {
            post: command(false),
            get: {
                operationId: 'listFinancialFulfillmentReversals',
                tags: ['Finances'],
                summary:
                    'Consultar compensações vinculadas aos fatos originais',
                description:
                    'Página de até 20 itens com totais coerentes e cursor vinculado ao ator, espaço e compromisso. Mantém datas e vínculos de todas as compensações sem ocultar os originais.',
                security: [{ sessionCookie: [] }],
                parameters: [
                    ...parameters,
                    {
                        name: 'cursor',
                        in: 'query',
                        required: false,
                        schema: { type: 'string', maxLength: 2048 },
                    },
                ],
                responses: {
                    200: response(
                        'FinancialFulfillmentReversalList',
                        'Histórico paginado; vazio retorna coleção vazia.',
                    ),
                    ...errors,
                },
            },
        },
    },
    components: {
        schemas: {
            FinancialFulfillmentReversalRequest: input,
            FinancialFulfillmentReversal: reversal,
            FinancialFulfillmentReversalPreview: preview,
            FinancialFulfillmentReversalResponse: commandResponse,
            FinancialFulfillmentReversalList: object({
                items: {
                    type: 'array',
                    maxItems: 20,
                    items: ref('FinancialFulfillmentReversal'),
                },
                totalCount: money,
                nextCursor: nullable({ type: 'string' }),
            }),
        },
    },
};
