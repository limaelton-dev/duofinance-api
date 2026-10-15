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
const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const date: SchemaObject = { type: 'string', format: 'date' };
const integer: SchemaObject = {
    type: 'integer',
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
};
const total: SchemaObject = {
    type: 'string',
    pattern: '^(0|[1-9][0-9]*)$',
    description:
        'Centavos inteiros exatos. Reconhecido preserva a posição após reconciliação; resolvido é reconhecido menos restante. Dinheiro transferido provém somente das alocações de transferências.',
};
const view: SchemaObject = { type: 'string', enum: ['OPEN', 'UPCOMING'] };
const direction: SchemaObject = {
    type: 'string',
    enum: ['ALL', 'PAYABLE', 'RECEIVABLE'],
};
const nullableCursor: SchemaObject = {
    oneOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 512 }],
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
const errors = {
    400: error('VALIDATION_ERROR'),
    401: error('UNAUTHENTICATED'),
    404: error('SPACE_NOT_FOUND'),
    409: error('SHARED_SPACE_REQUIRED'),
    429: error('TOO_MANY_REQUESTS'),
    500: error('INTERNAL_ERROR'),
};
const spaceParameter = {
    name: 'spaceId',
    in: 'path' as const,
    required: true,
    schema: uuid,
};
const cursorParameter = {
    name: 'cursor',
    in: 'query' as const,
    required: false,
    schema: { type: 'string' as const, minLength: 1, maxLength: 512 },
    description:
        'Cursor opaco canônico versionado vinculado à pessoa, espaço, consulta e filtros. Lista usa data/UUID; detalhe preserva instante UTC de microssegundos/UUID. UPCOMING expira na virada da data civil America/Sao_Paulo, retornando VALIDATION_ERROR para cursor.',
};
const context = {
    spaceId: uuid,
    spaceStatus: {
        type: 'string' as const,
        enum: ['ACTIVE', 'CLOSING', 'CLOSED'],
    },
    actorMemberId: uuid,
    members: {
        type: 'array' as const,
        minItems: 1,
        maxItems: 2,
        items: object({
            memberId: uuid,
            personId: uuid,
            displayName: { type: 'string' },
        }),
    },
    referenceDate: date,
};
const summary = {
    id: uuid,
    version: { ...integer, minimum: 1 },
    targetDate: date,
    status: { type: 'string' as const, enum: ['OPEN'] },
    isOverdue: { type: 'boolean' as const },
    obligationCount: integer,
    openObligationCount: integer,
    totals: object({
        originalAmountInCents: total,
        recognizedAmountInCents: total,
        resolvedAmountInCents: total,
        remainingAmountInCents: total,
        transferredAmountInCents: total,
    }),
    position: object({
        payableAmountInCents: total,
        receivableAmountInCents: total,
        net: {
            oneOf: [
                object({
                    direction: {
                        type: 'string',
                        enum: ['PAYABLE', 'RECEIVABLE'],
                    },
                    amountInCents: { ...total, pattern: '^[1-9][0-9]*$' },
                }),
                object({
                    direction: { type: 'string', enum: ['BALANCED'] },
                    amountInCents: { type: 'string', enum: ['0'] },
                }),
            ],
        },
    }),
};
export const settlementCycleOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        '/v2/spaces/{spaceId}/settlement-cycles': {
            get: {
                operationId: 'getSettlementCycles',
                tags: ['Finances'],
                summary:
                    'Consultar ciclos em aberto e próximos ciclos existentes',
                description:
                    'OPEN inclui ciclos vencidos e zerados. UPCOMING inclui OPEN com data-alvo hoje ou futura, sem projeção de ciclos. Ordem data-alvo/UUID crescente, página de 20. Totais abrangem toda composição do ciclo. Snapshot financeiro único por resposta; não há snapshot entre páginas. Rejeita query desconhecida, duplicada ou inválida. Consulta não escreve nem finaliza ciclos.',
                security: [{ sessionCookie: [] }],
                parameters: [
                    spaceParameter,
                    {
                        name: 'view',
                        in: 'query',
                        required: false,
                        schema: { ...view, default: 'OPEN' },
                    },
                    cursorParameter,
                ],
                responses: {
                    ...errors,
                    200: response(
                        ref('SettlementCyclesResponse'),
                        'Ciclos autorizados, inclusive composição vazia e zero restante.',
                    ),
                },
            },
        },
        '/v2/spaces/{spaceId}/settlement-cycles/{cycleId}': {
            get: {
                operationId: 'getSettlementCycle',
                tags: ['Finances'],
                summary: 'Consultar composição e totais de um ciclo',
                description:
                    'Detalhe OPEN ou FINALIZED existente. Direção filtra apenas linhas; totais, posição e contagens permanecem completos. Inclui restante zero. Ordem registeredAt/UUID decrescente, preservando microssegundos UTC. Posição líquida informativa não resolve pendências; resolvido não comprova transferência. Snapshot financeiro único por resposta. Rejeita query desconhecida ou duplicada. Origem deve ser consultada com autorização própria.',
                security: [{ sessionCookie: [] }],
                parameters: [
                    spaceParameter,
                    {
                        name: 'cycleId',
                        in: 'path',
                        required: true,
                        schema: uuid,
                    },
                    {
                        name: 'direction',
                        in: 'query',
                        required: false,
                        schema: { ...direction, default: 'ALL' },
                    },
                    cursorParameter,
                ],
                responses: {
                    ...errors,
                    404: error('SPACE_NOT_FOUND', 'SETTLEMENT_CYCLE_NOT_FOUND'),
                    200: response(
                        ref('SettlementCycleResponse'),
                        'Composição rastreável e totais brutos exatos; FINALIZED disponível somente leitura.',
                    ),
                },
            },
        },
    },
    components: {
        schemas: {
            SettlementCycleSummary: object(summary),
            SettlementCycleDetail: object({
                ...summary,
                status: { type: 'string', enum: ['OPEN', 'FINALIZED'] },
                finalizedAt: {
                    oneOf: [
                        { type: 'null' },
                        { type: 'string', format: 'date-time' },
                    ],
                },
            }),
            SettlementCycleObligation: object({
                id: uuid,
                version: { ...integer, minimum: 1 },
                status: {
                    type: 'string',
                    enum: [
                        'OPEN',
                        'PARTIALLY_SETTLED',
                        'SETTLED',
                        'RECONCILED',
                    ],
                },
                debtorMemberId: uuid,
                creditorMemberId: uuid,
                originalAmountInCents: { ...integer, minimum: 1 },
                recognizedAmountInCents: integer,
                resolvedAmountInCents: integer,
                remainingAmountInCents: integer,
                factDate: date,
                registeredAt: { type: 'string', format: 'date-time' },
                origin: ref('InterMemberObligationOrigin'),
            }),
            SettlementCyclesResponse: object({
                ...context,
                items: {
                    type: 'array',
                    maxItems: 20,
                    items: ref('SettlementCycleSummary'),
                },
                page: object({
                    view,
                    pageSize: { type: 'integer', enum: [20] },
                    nextCursor: nullableCursor,
                }),
            }),
            SettlementCycleResponse: object({
                ...context,
                cycle: ref('SettlementCycleDetail'),
                items: {
                    type: 'array',
                    maxItems: 20,
                    items: ref('SettlementCycleObligation'),
                },
                page: object({
                    direction,
                    pageSize: { type: 'integer', enum: [20] },
                    nextCursor: nullableCursor,
                }),
            }),
        },
    },
};
