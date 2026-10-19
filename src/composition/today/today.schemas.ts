import type { SchemaObject, ReferenceObject } from '@nestjs/swagger';

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
const nullable = (schema: SchemaObject | ReferenceObject): SchemaObject => ({
    oneOf: [schema, { type: 'null' }],
});
const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const date: SchemaObject = { type: 'string', format: 'date' };
const instant: SchemaObject = { type: 'string', format: 'date-time' };
const count: SchemaObject = { type: 'integer', minimum: 0 };
const money: SchemaObject = {
    type: 'integer',
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
};
const quantity: SchemaObject = {
    type: 'string',
    pattern: '^(0|[1-9]\\d{0,11})(\\.\\d{1,3})?$',
};
const modality: SchemaObject = {
    type: 'string',
    enum: ['ONE_TIME', 'RECURRING', 'INSTALLMENT'],
};
const item = (
    type: string,
    reference: Record<string, SchemaObject | ReferenceObject>,
    details: SchemaObject | ReferenceObject,
) =>
    object({
        type: { type: 'string', enum: [type] },
        reference: object({
            type: { type: 'string', enum: [type] },
            ...reference,
        }),
        label: { type: 'string' },
        date: nullable(date),
        details,
    });

export const todayCompositionSchemas: Record<string, SchemaObject> = {
    TodayFinancialItem: object({
        commitmentId: uuid,
        occurrenceId: nullable(uuid),
        modality,
        kind: { type: 'string', enum: ['EXPENSE', 'INCOME'] },
        description: { type: 'string' },
        expectedDate: date,
        amountInCents: nullable(money),
        expectedAmountInCents: nullable(money),
        valuePending: { type: 'boolean' },
        fulfilledAmountInCents: money,
        remainingAmountInCents: nullable(money),
    }),
    TodayShoppingItem: object({
        id: uuid,
        description: { type: 'string' },
        unit: nullable({ type: 'string' }),
        desiredQuantity: quantity,
        purchasedQuantity: quantity,
        remainingQuantity: quantity,
        status: { type: 'string', enum: ['PENDING', 'PARTIALLY_PURCHASED'] },
    }),
    TodayShoppingList: object({
        id: uuid,
        name: nullable({ type: 'string' }),
        status: { type: 'string', enum: ['ACTIVE'] },
        summary: object({
            activeItemCount: count,
            actionableItemCount: count,
            isComplete: { type: 'boolean' },
        }),
        pendingItems: object({
            items: {
                type: 'array',
                maxItems: 4,
                items: ref('TodayShoppingItem'),
            },
            totalCount: count,
            hasMore: { type: 'boolean' },
        }),
    }),
    TodayShoppingRead: object({
        spaceId: uuid,
        actorMemberId: nullable(uuid),
        referenceDate: date,
        referenceInstant: instant,
        items: { type: 'array', maxItems: 4, items: ref('TodayShoppingList') },
        totalCount: {
            ...count,
            description:
                'Quantidade real de listas ativas com itens pendentes ou parcialmente comprados.',
        },
        activeListCount: {
            ...count,
            description:
                'Inclui listas ativas vazias ou completas; distingue ausência de listas de ausência de pendências.',
        },
    }),
    TodayShoppingSource: {
        oneOf: [
            object({
                status: { type: 'string', enum: ['AVAILABLE'] },
                data: ref('TodayShoppingRead'),
            }),
            object({
                status: { type: 'string', enum: ['UNAVAILABLE'] },
                error: object({
                    code: {
                        type: 'string',
                        enum: ['SHOPPING_TODAY_UNAVAILABLE'],
                    },
                    message: { type: 'string' },
                }),
            }),
        ],
    },
    TodayFinancialPreview: item(
        'FINANCIAL_COMMITMENT',
        {
            commitmentId: uuid,
            occurrenceId: nullable(uuid),
            modality,
            expectedDate: date,
        },
        ref('TodayFinancialItem'),
    ),
    TodayTaskPreview: item(
        'TASK',
        {
            taskId: { type: 'string' },
            kind: { type: 'string', enum: ['ONE_OFF', 'OCCURRENCE'] },
            recurrenceId: nullable(uuid),
            scheduledDate: nullable(date),
        },
        { oneOf: [ref('RoutineTaskView'), ref('RoutineOccurrenceView')] },
    ),
    TodayShoppingPreview: item(
        'SHOPPING_LIST',
        { listId: uuid },
        ref('TodayShoppingList'),
    ),
    TodayProposalPreview: item(
        'CHANGE_PROPOSAL',
        { proposalId: uuid, commitmentId: uuid },
        object({
            proposalId: uuid,
            commitmentId: uuid,
            registeredAt: instant,
            effectiveFrom: date,
        }),
    ),
    TodayCyclePreview: item(
        'SETTLEMENT_CYCLE',
        { cycleId: uuid },
        ref('SettlementCycleSummary'),
    ),
    TodayClosurePreview: item(
        'SPACE_CLOSURE',
        { processId: uuid },
        ref('SpaceClosureView'),
    ),
    TodayPreviewItem: {
        oneOf: [
            'TodayFinancialPreview',
            'TodayTaskPreview',
            'TodayShoppingPreview',
            'TodayProposalPreview',
            'TodayCyclePreview',
            'TodayClosurePreview',
        ].map(ref),
        discriminator: {
            propertyName: 'type',
            mapping: {
                FINANCIAL_COMMITMENT:
                    '#/components/schemas/TodayFinancialPreview',
                TASK: '#/components/schemas/TodayTaskPreview',
                SHOPPING_LIST: '#/components/schemas/TodayShoppingPreview',
                CHANGE_PROPOSAL: '#/components/schemas/TodayProposalPreview',
                SETTLEMENT_CYCLE: '#/components/schemas/TodayCyclePreview',
                SPACE_CLOSURE: '#/components/schemas/TodayClosurePreview',
            },
        },
    },
    TodayBlock: {
        ...object({
            kind: {
                type: 'string',
                enum: [
                    'ATTENTION',
                    'TODAY',
                    'NEXT_SETTLEMENT',
                    'UPCOMING',
                    'TASKS',
                    'SHOPPING',
                ],
            },
            status: {
                type: 'string',
                enum: ['AVAILABLE', 'PARTIAL', 'UNAVAILABLE', 'NOT_APPLICABLE'],
            },
            items: {
                type: 'array',
                maxItems: 4,
                items: ref('TodayPreviewItem'),
            },
            totalCount: {
                ...nullable(count),
                description:
                    'Total real das fontes do bloco. Null quando pelo menos uma fonte necessária está indisponível. Finanças conta compromissos por categoria, com a primeira ocorrência elegível de cada compromisso.',
            },
            knownTotalCount: {
                ...count,
                description:
                    'Total confirmado apenas pelas fontes disponíveis; não substitui um total desconhecido.',
            },
            hasMore: {
                ...nullable({ type: 'boolean' }),
                description: 'Null quando o total não pode ser determinado.',
            },
        }),
        description:
            'Ordem estável dos seis blocos; ATTENTION tem no máximo três itens e os demais no máximo quatro. NEXT_SETTLEMENT pessoal é NOT_APPLICABLE e pode ser omitido na apresentação. PARTIAL preserva itens das fontes disponíveis. Referências identificam o detalhe navegável no espaço atual.',
        oneOf: [
            {
                properties: {
                    kind: { type: 'string', enum: ['ATTENTION'] },
                    items: { type: 'array', maxItems: 3 },
                },
            },
            {
                properties: {
                    kind: {
                        type: 'string',
                        enum: [
                            'TODAY',
                            'NEXT_SETTLEMENT',
                            'UPCOMING',
                            'TASKS',
                            'SHOPPING',
                        ],
                    },
                },
            },
        ],
    },
};
