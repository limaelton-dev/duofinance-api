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
    required: Object.keys(properties).filter(
        (name) =>
            !['compensatedAmountInCents', 'waivedAmountInCents'].includes(name),
    ),
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
const view: SchemaObject = {
    type: 'string',
    enum: ['OPEN', 'UPCOMING', 'OVERDUE', 'FINALIZED'],
};
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
        'Cursor opaco canônico vinculado à pessoa, espaço, consulta e filtros. UPCOMING e OVERDUE expiram na virada da data civil America/Sao_Paulo. Detalhe preserva microssegundos UTC/UUID.',
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
    status: { type: 'string' as const, enum: ['OPEN', 'FINALIZED'] },
    isOverdue: { type: 'boolean' as const },
    obligationCount: integer,
    openObligationCount: integer,
    totals: object({
        originalAmountInCents: total,
        recognizedAmountInCents: total,
        resolvedAmountInCents: total,
        remainingAmountInCents: total,
        transferredAmountInCents: total,
        compensatedAmountInCents: {
            ...total,
            description:
                'Soma das aplicações de compensação no ciclo ou recorte. Pode incluir ambas as direções: compensação de 8000 aplica 16000 no conjunto. Não é transferência de caixa.',
        },
        waivedAmountInCents: {
            ...total,
            description:
                'Valor dispensado pelo credor nas pendências do ciclo ou recorte, separado de transferência de caixa e compensação.',
        },
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
                    'Consultar ciclos abertos, próximos, vencidos e finalizados',
                description:
                    'OPEN inclui ciclos vencidos e zerados. UPCOMING inclui OPEN com data-alvo hoje ou futura. OVERDUE exige OPEN, data-alvo anterior a hoje e restante positivo. FINALIZED recupera ciclos encerrados somente leitura. Ordem data-alvo/UUID crescente, página de 20. Totais da composição inteira e snapshot financeiro único por resposta. Rejeita query desconhecida, duplicada ou inválida. Consulta não escreve nem finaliza ciclos.',
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
                    'Detalhe OPEN ou FINALIZED existente. Expõe elegibilidade e motivo de bloqueio para finalização. Direção filtra apenas linhas; totais, posição e contagens permanecem completos. Inclui restante zero. Ordem registeredAt/UUID decrescente, preservando microssegundos UTC. Posição líquida informativa não resolve pendências nem permite finalizar enquanto existir valor aberto. Snapshot financeiro único por resposta. Rejeita query desconhecida ou duplicada. Origem deve ser consultada com autorização própria.',
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
        '/v2/spaces/{spaceId}/settlement-cycles/{cycleId}/finalize': {
            post: {
                operationId: 'finalizeSettlementCycle',
                tags: ['Finances'],
                summary:
                    'Finalizar explicitamente um ciclo sem valores abertos',
                description:
                    'Exige ausência de restante em todas as pendências. Posição líquida zero com dívidas recíprocas abertas não permite finalizar. Conserva data-alvo, composição e fatos históricos; não reabre automaticamente. Finalização, histórico, auditoria e recibo são atômicos. Repita a chave e entrada originais após resultado incerto.',
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
                        name: 'Idempotency-Key',
                        in: 'header',
                        required: true,
                        schema: uuid,
                    },
                    {
                        name: 'X-CSRF-Token',
                        in: 'header',
                        required: true,
                        schema: { type: 'string' },
                    },
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: ref('FinalizeSettlementCycleRequest'),
                        },
                    },
                },
                responses: {
                    ...errors,
                    200: response(
                        ref('FinalizeSettlementCycleResponse'),
                        'Ciclo finalizado ou replay autorizado da confirmação original.',
                    ),
                    403: error('INVALID_CSRF_TOKEN'),
                    404: error('SPACE_NOT_FOUND', 'SETTLEMENT_CYCLE_NOT_FOUND'),
                    409: error(
                        'SPACE_NOT_ACTIVE',
                        'SHARED_SPACE_REQUIRED',
                        'CONCURRENT_MODIFICATION',
                        'SETTLEMENT_CYCLE_FINALIZED',
                        'SETTLEMENT_CYCLE_HAS_OPEN_OBLIGATIONS',
                        'IDEMPOTENCY_KEY_REUSED',
                    ),
                },
            },
        },
        '/v2/spaces/{spaceId}/settlement-cycles/summary': {
            get: {
                operationId: 'getSelectedSettlementCyclesSummary',
                tags: ['Finances'],
                summary: 'Consultar o recorte temporário de ciclos escolhidos',
                description:
                    'Seleciona de dois a cinquenta ciclos distintos do mesmo espaço, incluindo históricos FINALIZED somente leitura. Valida a seleção inteira e não persiste recorte. Totais consideram todos os ciclos; direction filtra apenas os itens. transferredAmountInCents soma aplicações no recorte; transferTotalAmountInCents soma cada transferência envolvida uma única vez. Posição líquida é informativa. A consulta usa snapshot único e revalida acesso fora dele.',
                security: [{ sessionCookie: [] }],
                parameters: [
                    spaceParameter,
                    {
                        name: 'cycleIds',
                        in: 'query',
                        required: true,
                        schema: {
                            type: 'array',
                            minItems: 2,
                            maxItems: 50,
                            uniqueItems: true,
                            items: uuid,
                        },
                        style: 'form',
                        explode: false,
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
                        ref('SelectedSettlementCyclesResponse'),
                        'Recorte autorizado, sem dupla contagem de transferências ou criação de fatos.',
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
                canFinalize: { type: 'boolean' },
                finalizationBlockReason: {
                    oneOf: [
                        { type: 'null' },
                        {
                            type: 'string',
                            enum: [
                                'SPACE_CLOSED',
                                'SETTLEMENT_CYCLE_FINALIZED',
                                'OPEN_OBLIGATIONS',
                            ],
                        },
                    ],
                },
            }),
            FinalizeSettlementCycleRequest: object({
                expectedSpaceVersion: { ...integer, minimum: 1 },
                expectedCycleVersion: { ...integer, minimum: 1 },
            }),
            FinalizeSettlementCycleResponse: object({
                spaceId: uuid,
                cycle: object({
                    id: uuid,
                    targetDate: date,
                    status: { type: 'string', enum: ['FINALIZED'] },
                    version: { ...integer, minimum: 1 },
                    finalizedAt: { type: 'string', format: 'date-time' },
                    finalizedByPersonId: uuid,
                }),
                affectedCycleIds: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 1,
                    items: uuid,
                },
                replayed: { type: 'boolean' },
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
                        'WAIVED',
                    ],
                },
                debtorMemberId: uuid,
                creditorMemberId: uuid,
                originalAmountInCents: { ...integer, minimum: 1 },
                recognizedAmountInCents: integer,
                resolvedAmountInCents: integer,
                remainingAmountInCents: integer,
                compensatedAmountInCents: integer,
                waivedAmountInCents: integer,
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
            SelectedSettlementCycleOrigin: {
                type: 'object',
                additionalProperties: false,
                description:
                    'Compromisso originador e distribuição econômica original. Estes valores não são novos totais do recorte e não devem ser somados por linha; uma origem pode gerar várias pendências.',
                required: [
                    'kind',
                    'commitmentId',
                    'description',
                    'amountInCents',
                    'distribution',
                ],
                properties: {
                    commitmentId: uuid,
                    description: { type: 'string' },
                    disbursementId: uuid,
                    receiptId: uuid,
                    externalLiabilityId: uuid,
                    kind: { type: 'string', enum: ['EXPENSE', 'INCOME'] },
                    amountInCents: { ...integer, minimum: 1 },
                    distribution: object({
                        kind: {
                            type: 'string',
                            enum: ['RESPONSIBILITY', 'PARTICIPATION'],
                        },
                        shares: {
                            type: 'array',
                            items: object({
                                memberId: uuid,
                                amountInCents: integer,
                            }),
                        },
                        actorAmountInCents: integer,
                    }),
                },
            },
            SelectedSettlementCyclesResponse: object({
                ...context,
                selectedCycles: {
                    type: 'array',
                    minItems: 2,
                    maxItems: 50,
                    items: object({
                        ...summary,
                        status: { type: 'string', enum: ['OPEN', 'FINALIZED'] },
                        finalizedAt: {
                            oneOf: [
                                { type: 'null' },
                                { type: 'string', format: 'date-time' },
                            ],
                        },
                        readOnly: { type: 'boolean' },
                    }),
                },
                totals: object({
                    ...summary.totals.properties,
                    transferTotalAmountInCents: total,
                    transferCount: integer,
                    grossPayableAmountInCents: total,
                    grossReceivableAmountInCents: total,
                }),
                position: summary.position,
                items: {
                    type: 'array',
                    maxItems: 20,
                    items: object({
                        id: uuid,
                        version: { ...integer, minimum: 1 },
                        status: {
                            type: 'string',
                            enum: [
                                'OPEN',
                                'PARTIALLY_SETTLED',
                                'SETTLED',
                                'RECONCILED',
                                'WAIVED',
                            ],
                        },
                        debtorMemberId: uuid,
                        creditorMemberId: uuid,
                        originalAmountInCents: { ...integer, minimum: 1 },
                        recognizedAmountInCents: integer,
                        resolvedAmountInCents: integer,
                        remainingAmountInCents: integer,
                        compensatedAmountInCents: integer,
                        waivedAmountInCents: integer,
                        factDate: date,
                        registeredAt: { type: 'string', format: 'date-time' },
                        cycleId: uuid,
                        origin: ref('SelectedSettlementCycleOrigin'),
                    }),
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
