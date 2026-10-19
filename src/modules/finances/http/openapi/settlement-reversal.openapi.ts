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
const nullable = (schema: SchemaObject | ReferenceObject): SchemaObject => ({
    oneOf: [schema, { type: 'null' }],
});
const kind: SchemaObject = { type: 'string', enum: ['TRANSFER', 'OFFSET'] };
const status: SchemaObject = {
    type: 'string',
    enum: ['OPEN', 'PARTIALLY_SETTLED', 'SETTLED', 'RECONCILED', 'WAIVED'],
};
const original = object({
    kind,
    id: uuid,
    amountInCents: positive,
    factDate: date,
    registeredAt: instant,
    createdByPersonId: uuid,
});
const effect = {
    obligationId: uuid,
    originCommitmentId: uuid,
    remainingAmountInCents: money,
    cycleId: nullable(uuid),
    version: positive,
    status,
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
    403: response('ErrorResponse', 'INVALID_CSRF_TOKEN.'),
    404: response(
        'ErrorResponse',
        'Original, espaço, ciclo ou pendência inexistente ou inacessível.',
    ),
    409: response(
        'ErrorResponse',
        'CONCURRENT_MODIFICATION exige nova prévia; SETTLEMENT_RESOLUTION_ALREADY_REVERSED impede repetir o efeito; REVERSAL_CORRECTION_CYCLE_REQUIRED exige destino aberto explícito; SETTLEMENT_CYCLE_FINALIZED bloqueia destino; IDEMPOTENCY_KEY_REUSED exige chave e entrada originais.',
    ),
    429: response('ErrorResponse', 'TOO_MANY_REQUESTS.'),
    500: response('ErrorResponse', 'INTERNAL_ERROR, sem aplicação parcial.'),
};
function operation(
    resolution: 'Transfer' | 'Offset',
    confirm: boolean,
): OperationObject {
    const identifier = resolution === 'Transfer' ? 'transferId' : 'offsetId';
    return {
        operationId: confirm
            ? `reverseSettlement${resolution}`
            : `getSettlement${resolution}ReversalOptions`,
        tags: ['Finances'],
        summary: confirm
            ? 'Confirmar reversão integral com efeitos compensatórios rastreáveis'
            : 'Consultar original, reversões anteriores e impacto permitido',
        description: confirm
            ? 'Reverte integralmente o efeito ainda válido de todas as aplicações do original. Seleção parcial não é suportada. Não executa PIX nem cria receita, despesa ou dinheiro novo. Conserva o original e fatos posteriores; recalcula somente efeitos correspondentes. Origem em ciclo finalizado exige correctionCycleId aberto explícito e sua versão; composição e histórico encerrados permanecem intactos. Reversão, aplicações corretivas, efeitos, histórico, recibo e auditoria são atômicos. Após resultado incerto, repita chave e entrada originais.'
            : 'Consulta sem escrita. Exibe saldos, versões e ciclos atuais afetados para confirmação explícita. Cada impacto preserva a identidade da origem, ocorrência ou acordo de encerramento; ocorrências distintas só são compensadas por comando explícito. requiresCorrectionCycle indica necessidade de escolher outro ciclo aberto. A correção pode também reduzir uma pendência oposta da mesma origem em outro ciclo aberto, respeitando os fatos posteriores e a confirmação de suas versões. Posição líquida não resolve nem reverte fatos.',
        security: [{ sessionCookie: [] }],
        parameters: [
            {
                name: 'spaceId',
                in: 'path',
                required: true,
                schema: uuid,
            },
            { name: identifier, in: 'path', required: true, schema: uuid },
            ...(confirm
                ? [
                      {
                          name: 'Idempotency-Key',
                          in: 'header' as const,
                          required: true,
                          schema: uuid,
                      },
                      {
                          name: 'X-CSRF-Token',
                          in: 'header' as const,
                          required: true,
                          schema: { type: 'string' as const },
                      },
                  ]
                : []),
        ],
        ...(confirm
            ? {
                  requestBody: {
                      required: true,
                      content: {
                          'application/json': {
                              schema: ref('ReverseSettlementResolutionRequest'),
                          },
                      },
                  },
              }
            : {}),
        responses: {
            ...errors,
            200: response(
                confirm
                    ? 'SettlementReversalResponse'
                    : 'SettlementReversalOptions',
                confirm ? 'Replay autorizado.' : 'Prévia autorizada.',
            ),
            ...(confirm
                ? {
                      201: response(
                          'SettlementReversalResponse',
                          'Reversão integral confirmada.',
                      ),
                  }
                : {}),
        },
    };
}
const request = object({
    expectedSpaceVersion: positive,
    factDate: date,
    expectedObligationVersions: {
        type: 'array',
        minItems: 1,
        items: object({ obligationId: uuid, version: positive }),
    },
    expectedCycleVersions: {
        type: 'array',
        items: object({ cycleId: uuid, version: positive }),
    },
    applications: {
        type: 'array',
        minItems: 1,
        items: object({ allocationId: uuid, amountInCents: positive }),
    },
    correctionCycleId: uuid,
});
request.required = request.required?.filter(
    (name) => name !== 'correctionCycleId',
);
export const settlementReversalOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        '/v2/spaces/{spaceId}/settlement-transfers/{transferId}/reversal-options':
            {
                get: operation('Transfer', false),
            },
        '/v2/spaces/{spaceId}/settlement-transfers/{transferId}/reversals': {
            post: operation('Transfer', true),
        },
        '/v2/spaces/{spaceId}/settlement-offsets/{offsetId}/reversal-options': {
            get: operation('Offset', false),
        },
        '/v2/spaces/{spaceId}/settlement-offsets/{offsetId}/reversals': {
            post: operation('Offset', true),
        },
    },
    components: {
        schemas: {
            SettlementReversalApplication: object({
                id: uuid,
                originalAllocationId: uuid,
                obligationId: uuid,
                originalCycleId: nullable(uuid),
                correctionCycleId: nullable(uuid),
                effectObligationId: nullable(uuid),
                amountInCents: positive,
                debtorMemberId: uuid,
                creditorMemberId: uuid,
            }),
            ReverseSettlementResolutionRequest: request,
            SettlementReversalOptions: object({
                spaceId: uuid,
                spaceStatus: {
                    type: 'string',
                    enum: ['ACTIVE', 'CLOSING', 'CLOSED'],
                },
                spaceVersion: positive,
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
                original,
                allocations: {
                    type: 'array',
                    items: object({
                        id: uuid,
                        obligationId: uuid,
                        originCommitmentId: uuid,
                        debtorMemberId: uuid,
                        creditorMemberId: uuid,
                        amountInCents: positive,
                        cycleId: nullable(uuid),
                    }),
                },
                previousReversals: {
                    type: 'array',
                    maxItems: 1,
                    items: object({
                        id: uuid,
                        amountInCents: positive,
                        factDate: date,
                        registeredAt: instant,
                        createdByPersonId: uuid,
                        applications: {
                            type: 'array',
                            items: ref('SettlementReversalApplication'),
                        },
                    }),
                },
                reversibleAmountInCents: money,
                obligations: {
                    type: 'array',
                    items: object({
                        id: uuid,
                        originCommitmentId: uuid,
                        occurrenceId: nullable(uuid),
                        originClosureAgreementId: nullable(uuid),
                        version: positive,
                        cycleId: nullable(uuid),
                        debtorMemberId: uuid,
                        creditorMemberId: uuid,
                        remainingAmountInCents: money,
                        status,
                    }),
                },
                cycles: {
                    type: 'array',
                    items: object({
                        id: uuid,
                        version: positive,
                        targetDate: date,
                        status: { type: 'string', enum: ['OPEN', 'FINALIZED'] },
                    }),
                },
                requiresCorrectionCycle: { type: 'boolean' },
                canReverse: { type: 'boolean' },
                reversalBlockReason: nullable({
                    type: 'string',
                    enum: [
                        'SPACE_CLOSED',
                        'ALREADY_REVERSED',
                        'CORRECTION_CYCLE_REQUIRED',
                    ],
                }),
                impact: {
                    type: 'array',
                    items: object({
                        originCommitmentId: uuid,
                        occurrenceId: nullable(uuid),
                        originClosureAgreementId: nullable(uuid),
                        debtorMemberId: nullable(uuid),
                        creditorMemberId: nullable(uuid),
                        remainingAmountInCents: money,
                        requiresCorrectionCycle: { type: 'boolean' },
                        affectedCurrentCycleIds: {
                            type: 'array',
                            uniqueItems: true,
                            items: uuid,
                        },
                        newCorrectionObligation: { type: 'boolean' },
                    }),
                },
            }),
            SettlementReversalResponse: object({
                spaceId: uuid,
                reversal: object({
                    id: uuid,
                    originalKind: kind,
                    originalId: uuid,
                    amountInCents: positive,
                    factDate: date,
                    registeredAt: instant,
                    createdByPersonId: uuid,
                }),
                original,
                applications: {
                    type: 'array',
                    items: ref('SettlementReversalApplication'),
                },
                effects: { type: 'array', items: object(effect) },
                affectedCycleIds: {
                    type: 'array',
                    uniqueItems: true,
                    items: uuid,
                },
                replayed: { type: 'boolean' },
            }),
        },
    },
};
