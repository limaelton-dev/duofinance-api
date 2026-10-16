import type {
    OpenAPIObject,
    SchemaObject,
    ReferenceObject,
    OperationObject,
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
const version: SchemaObject = {
    type: 'integer',
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
};
const nullable = (schema: SchemaObject | ReferenceObject): SchemaObject => ({
    oneOf: [schema, { type: 'null' }],
});
const cycle = object({
    id: uuid,
    targetDate: { type: 'string', format: 'date' },
    status: { type: 'string', enum: ['OPEN', 'FINALIZED'] },
    version,
});
const obligation = object({
    id: uuid,
    version,
    cycleId: nullable(uuid),
    remainingAmountInCents: {
        type: 'integer',
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
    },
});
const effective = object({
    source: { type: 'string', enum: ['SPECIFIC', 'INHERITED'] },
    rule: nullable(ref('SettlementRule')),
    version: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
});
const settlement: SchemaObject = {
    oneOf: [
        object({ mode: { type: 'string', enum: ['NONE'] } }),
        object({
            mode: { type: 'string', enum: ['DATE'] },
            targetDate: { type: 'string', format: 'date' },
        }),
        object({ mode: { type: 'string', enum: ['CYCLE'] }, cycleId: uuid }),
    ],
};
function operation(
    operationId: string,
    entity: 'commitmentId' | 'obligationId',
    response: string,
    request?: string,
): OperationObject {
    return {
        operationId,
        tags: ['Finances'],
        summary:
            operationId === 'configureCommitmentSettlementRule'
                ? 'Configurar regra específica sem alterar o snapshot herdado'
                : operationId === 'moveObligation'
                  ? 'Mover o restante aberto preservando aplicações históricas'
                  : 'Consultar destinos autorizados de uma pendência',
        security: [{ sessionCookie: [] }],
        parameters: [
            { name: 'spaceId', in: 'path', required: true, schema: uuid },
            { name: entity, in: 'path', required: true, schema: uuid },
            ...(request
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
                : [
                      {
                          name: 'cursor',
                          in: 'query' as const,
                          required: false,
                          schema: { type: 'string' as const },
                      },
                  ]),
        ],
        ...(request
            ? {
                  requestBody: {
                      required: true,
                      content: { 'application/json': { schema: ref(request) } },
                  },
              }
            : {}),
        responses: {
            200: {
                description:
                    'Estado confirmado ou replay autorizado. O retry preserva chave e entrada originais.',
                headers: {
                    'Cache-Control': {
                        schema: { type: 'string', enum: ['no-store'] },
                    },
                },
                content: { 'application/json': { schema: ref(response) } },
            },
            ...Object.fromEntries(
                [400, 401, 403, 404, 409, 429, 500].map((status) => [
                    status,
                    {
                        description:
                            status === 409
                                ? 'Atualize versões após CONCURRENT_MODIFICATION; SETTLEMENT_CYCLE_FINALIZED bloqueia origem/destino; IDEMPOTENCY_KEY_REUSED exige chave original e payload original.'
                                : 'Erro padronizado, sem aplicação parcial.',
                        content: {
                            'application/json': {
                                schema: ref('ErrorResponse'),
                            },
                        },
                    },
                ]),
            ),
        },
    };
}
export const settlementAdjustmentOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        '/v2/spaces/{spaceId}/financial-commitments/{commitmentId}/settlement-rule':
            {
                put: operation(
                    'configureCommitmentSettlementRule',
                    'commitmentId',
                    'ConfigureCommitmentSettlementRuleResponse',
                    'ConfigureCommitmentSettlementRuleRequest',
                ),
            },
        '/v2/spaces/{spaceId}/inter-member-obligations/{obligationId}/settlement-options':
            {
                get: operation(
                    'getObligationSettlementOptions',
                    'obligationId',
                    'ObligationSettlementOptionsResponse',
                ),
            },
        '/v2/spaces/{spaceId}/inter-member-obligations/{obligationId}/settlement-assignment':
            {
                post: operation(
                    'moveObligation',
                    'obligationId',
                    'MoveObligationResponse',
                    'MoveObligationRequest',
                ),
            },
    },
    components: {
        schemas: {
            EffectiveSettlementRule: effective,
            ConfigureCommitmentSettlementRuleRequest: object({
                rule: ref('SettlementRule'),
                expectedCommitmentVersion: version,
                expectedSpaceVersion: version,
            }),
            ConfigureCommitmentSettlementRuleResponse: object({
                spaceId: uuid,
                commitmentId: uuid,
                commitmentVersion: version,
                settlementRule: object({
                    ...effective.properties,
                    referenceDate: { type: 'string', format: 'date' },
                    suggestedTargetDate: nullable({
                        type: 'string',
                        format: 'date',
                    }),
                }),
                affectedCycleIds: { type: 'array', items: uuid },
                replayed: { type: 'boolean' },
            }),
            MoveObligationRequest: object({
                settlement,
                expectedObligationVersion: version,
                expectedSpaceVersion: version,
                expectedCycleVersions: {
                    type: 'array',
                    maxItems: 2,
                    items: object({ cycleId: uuid, version }),
                },
            }),
            MoveObligationResponse: object({
                spaceId: uuid,
                obligation,
                settlementCycle: nullable(cycle),
                affectedCycleIds: { type: 'array', items: uuid },
                replayed: { type: 'boolean' },
            }),
            ObligationSettlementOptionsResponse: object({
                spaceId: uuid,
                spaceVersion: version,
                obligation,
                currentCycle: nullable(cycle),
                cycles: { type: 'array', maxItems: 20, items: cycle },
                nextCursor: nullable({ type: 'string' }),
                eligible: { type: 'boolean' },
                blockingReason: nullable({
                    type: 'string',
                    enum: [
                        'SPACE_CLOSED',
                        'SETTLEMENT_CYCLE_FINALIZED',
                        'OBLIGATION_ALREADY_RESOLVED',
                    ],
                }),
                today: { type: 'string', format: 'date' },
            }),
        },
    },
};
