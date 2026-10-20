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
const boolean: SchemaObject = { type: 'boolean' };
const nullable = (schema: SchemaObject | ReferenceObject): SchemaObject => ({
    oneOf: [schema, { type: 'null' }],
});
const direction: SchemaObject = {
    type: 'string',
    enum: ['INCREASE', 'DECREASE'],
};
const reason: SchemaObject = { type: 'string', minLength: 1, maxLength: 500 };
const shares: SchemaObject = nullable({
    type: 'array',
    minItems: 1,
    maxItems: 2,
    items: object({ memberId: uuid, amountInCents: money }),
});
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
const adjustmentInput = object({
    expectedCommitmentVersion: positive,
    expectedSpaceVersion: positive,
    expectedOccurrenceVersion: positive,
    occurrenceId: uuid,
    referenceDate: date,
    installmentId: uuid,
    direction,
    amountInCents: {
        ...positive,
        description:
            'Valor do acréscimo ou desconto; não é o novo total do alvo.',
    },
    reason,
    factDate: date,
    distribution: {
        allOf: [ref('ResponsibilitySplit')],
        description:
            'Distribuição do valor do ajuste, somado ou subtraído das cotas vigentes. Em AMOUNTS, a soma das cotas deve corresponder ao amountInCents deste ajuste.',
    },
    settlement,
});
adjustmentInput.required = [
    'expectedCommitmentVersion',
    'direction',
    'amountInCents',
    'reason',
    'factDate',
];
adjustmentInput.description =
    'Identifique somente o alvo coerente com a modalidade: sem identificador para avulso, referenceDate/occurrenceId para ocorrência recorrente ou installmentId para parcela. Recorrente e parcelado exigem expectedOccurrenceVersion; avulso não aceita este campo. SHARED exige expectedSpaceVersion. O ajuste altera o valor econômico, sem produzir pagamento, recebimento ou obrigação externa fictícios. Distribuição ausente conserva a participação vigente; seleção de acerto ausente equivale a NONE.';
const cancellationInput = object({
    expectedCommitmentVersion: positive,
    expectedSpaceVersion: positive,
    reason,
    factDate: date,
});
cancellationInput.required = [
    'expectedCommitmentVersion',
    'reason',
    'factDate',
];
cancellationInput.description =
    'Cancela compromisso avulso sem realização nem obrigação externa. SHARED exige expectedSpaceVersion. Fatos anteriores são preservados.';
const target = object({
    type: { type: 'string', enum: ['COMMITMENT', 'OCCURRENCE', 'INSTALLMENT'] },
    id: nullable(uuid),
    referenceDate: nullable(date),
    occurrenceId: nullable(uuid),
    installmentId: nullable(uuid),
});
const adjustment = object({
    id: uuid,
    spaceId: uuid,
    commitmentId: uuid,
    targetId: uuid,
    occurrenceId: nullable(uuid),
    installmentId: nullable(uuid),
    commitmentVersion: positive,
    direction,
    amountInCents: positive,
    reason,
    factDate: date,
    actorId: uuid,
    registeredAt: instant,
    previousAmountInCents: money,
    resultingAmountInCents: money,
    economicShares: shares,
    shareChanges: nullable({
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: object({
            memberId: uuid,
            amountInCents: {
                type: 'integer',
                minimum: -Number.MAX_SAFE_INTEGER,
                maximum: Number.MAX_SAFE_INTEGER,
            },
        }),
    }),
    proposalId: nullable(uuid),
});
const previewProperties = {
    commitmentId: uuid,
    kind: { type: 'string', enum: ['EXPENSE', 'INCOME'] } as SchemaObject,
    modality: {
        type: 'string',
        enum: ['ONE_TIME', 'RECURRING', 'INSTALLMENT'],
    } as SchemaObject,
    target,
    currentVersion: positive,
    expectedOccurrenceVersion: positive,
    originalAmountInCents: nullable(money),
    previousAdjustments: {
        type: 'array',
        items: ref('FinancialCommitmentAdjustment'),
    } as SchemaObject,
    amountInCents: money,
    fulfilledAmountInCents: money,
    remainingAmountInCents: nullable(money),
    proposedAmountInCents: money,
    proposedRemainingAmountInCents: money,
    economicShares: shares,
    impactByMember: {
        type: 'array',
        maxItems: 2,
        items: object({
            memberId: uuid,
            currentAmountInCents: { type: 'string', pattern: '^\\d+$' },
            proposedAmountInCents: { type: 'string', pattern: '^\\d+$' },
            deltaInCents: { type: 'string', pattern: '^-?\\d+$' },
            requiresAcceptance: boolean,
        }),
    } as SchemaObject,
    requiresAcceptance: boolean,
    recipientMemberId: nullable(uuid),
    cashImpactInCents: { type: 'string', enum: ['0'] } as SchemaObject,
    supportedImpactInCents: { type: 'string', enum: ['0'] } as SchemaObject,
    eligible: { type: 'boolean', enum: [true] } as SchemaObject,
};
const adjustmentView = (
    extra: Record<string, SchemaObject | ReferenceObject> = {},
) => {
    const schema = object({ ...previewProperties, ...extra });
    schema.required = schema.required!.filter(
        (name) => name !== 'expectedOccurrenceVersion',
    );
    return schema;
};
const cancellation = object({
    id: uuid,
    spaceId: uuid,
    commitmentId: uuid,
    commitmentVersion: positive,
    reason,
    factDate: date,
    actorId: uuid,
    registeredAt: instant,
});
const cancellationPreview = object({
    commitmentId: uuid,
    currentVersion: positive,
    kind: { type: 'string', enum: ['EXPENSE', 'INCOME'] },
    modality: { type: 'string', enum: ['ONE_TIME'] },
    amountInCents: money,
    fulfilledAmountInCents: { type: 'integer', enum: [0] },
    remainingAmountInCents: money,
    adjustments: { type: 'array', items: ref('FinancialCommitmentAdjustment') },
    facts: { type: 'array', maxItems: 0, items: { type: 'object' } },
    eligible: { type: 'boolean', enum: [true] },
});
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
function operation(
    action: 'Adjustment' | 'Cancellation',
    preview: boolean,
): OperationObject {
    const adjustment = action === 'Adjustment';
    return {
        operationId: `${preview ? 'preview' : 'record'}FinancialCommitment${action}`,
        tags: ['Finances'],
        summary: adjustment
            ? preview
                ? 'Simular acréscimo ou desconto explícito'
                : 'Registrar acréscimo ou desconto explícito'
            : preview
              ? 'Simular cancelamento de compromisso sem realização'
              : 'Cancelar compromisso avulso sem realização',
        description: adjustment
            ? 'Preserva valor original e trilha dos ajustes. Altera somente o compromisso avulso, ocorrência ou parcela indicada; não reescreve as demais ocorrências ou parcelas. Redução abaixo do valor realizado conflita. Ônus a outro membro cria proposta pendente e mantém a economia anterior até aceite pela rota de propostas de alteração do compromisso. A decisão e a aplicação são atômicas.'
            : 'Requer ausência de pagamento, recebimento e obrigação externa. Conserva o histórico e bloqueia novas realizações. A disputa com uma realização é serializada para impedir efeitos parciais.',
        security: [{ sessionCookie: [] }],
        parameters: [
            { name: 'spaceId', in: 'path', required: true, schema: uuid },
            { name: 'commitmentId', in: 'path', required: true, schema: uuid },
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
                          description:
                              'Repita a chave e entrada originais após resultado incerto.',
                      },
                  ]),
        ],
        requestBody: {
            required: true,
            content: {
                'application/json': {
                    schema: ref(`FinancialCommitment${action}Request`),
                },
            },
        },
        responses: {
            200: response(
                `FinancialCommitment${action}${preview ? 'Preview' : 'Response'}`,
                preview ? 'Prévia sem escrita.' : 'Replay autorizado.',
            ),
            ...(preview
                ? {}
                : {
                      201: response(
                          `FinancialCommitment${action}Response`,
                          adjustment
                              ? 'Ajuste aplicado ou proposta pendente criada, sem duplicação.'
                              : 'Cancelamento confirmado.',
                      ),
                  }),
            400: error('VALIDATION_ERROR'),
            401: error('UNAUTHENTICATED'),
            403: error(
                'INVALID_CSRF_TOKEN',
                'FINANCIAL_CHANGE_RECIPIENT_REQUIRED',
            ),
            404: error('SPACE_NOT_FOUND', 'FINANCIAL_COMMITMENT_NOT_FOUND'),
            409: error(
                'CONCURRENT_MODIFICATION',
                'IDEMPOTENCY_KEY_REUSED',
                'EXPENSE_OPTIONS_CHANGED',
                'SPACE_NOT_ACTIVE',
                'OCCURRENCE_ALREADY_RESOLVED',
                'FINANCIAL_CHANGE_PROPOSAL_OBSOLETE',
                'FINANCIAL_ADJUSTMENT_BELOW_FULFILLED',
                'FINANCIAL_COMMITMENT_CANCELLED',
                'FINANCIAL_CANCELLATION_NOT_ALLOWED',
            ),
            429: error('TOO_MANY_REQUESTS'),
            500: error('INTERNAL_ERROR'),
        },
    };
}
const base = '/v2/spaces/{spaceId}/financial-commitments/{commitmentId}';

export const financialCorrectionOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        [`${base}/adjustment-preview`]: { post: operation('Adjustment', true) },
        [`${base}/adjustments`]: { post: operation('Adjustment', false) },
        [`${base}/cancellation-preview`]: {
            post: operation('Cancellation', true),
        },
        [`${base}/cancellations`]: { post: operation('Cancellation', false) },
    },
    components: {
        schemas: {
            FinancialCommitmentAdjustmentRequest: adjustmentInput,
            FinancialCommitmentCancellationRequest: cancellationInput,
            FinancialCommitmentAdjustment: adjustment,
            FinancialCommitmentCancellation: cancellation,
            FinancialCommitmentAdjustmentPreview: adjustmentView(),
            FinancialCommitmentCancellationPreview: cancellationPreview,
            FinancialCommitmentAdjustmentResponse: {
                oneOf: [
                    adjustmentView({
                        adjustment: ref('FinancialCommitmentAdjustment'),
                        version: positive,
                        replayed: boolean,
                    }),
                    ref('FinancialCommitmentProposalCommandResponse'),
                ],
            },
            FinancialCommitmentCancellationResponse: {
                ...object({
                    ...cancellationPreview.properties,
                    cancellation: ref('FinancialCommitmentCancellation'),
                    version: positive,
                    status: { type: 'string', enum: ['CANCELLED'] },
                    replayed: boolean,
                }),
            },
            FinancialCommitmentAdjustmentProposalConfiguration: object({
                changeType: { type: 'string', enum: ['ADJUSTMENT'] },
                adjustment: ref('FinancialCommitmentAdjustmentRequest'),
            }),
            FinancialCommitmentAdjustmentAcceptanceResponse: {
                ...adjustmentView({
                    adjustment: ref('FinancialCommitmentAdjustment'),
                    version: positive,
                    replayed: boolean,
                    proposal: ref('FinancialCommitmentChangeProposal'),
                }),
            },
        },
    },
};
