import type {
    OpenAPIObject,
    OperationObject,
    SchemaObject,
    ReferenceObject,
} from '@nestjs/swagger';
const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const integer: SchemaObject = {
    type: 'integer',
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
};
const ref = (name: string): ReferenceObject => ({
    $ref: `#/components/schemas/${name}`,
});
const nullable = (s: SchemaObject | ReferenceObject): SchemaObject => ({
    oneOf: [s, { type: 'null' }],
});
const object = (
    properties: Record<string, SchemaObject | ReferenceObject>,
    required = Object.keys(properties),
): SchemaObject => ({
    type: 'object',
    additionalProperties: false,
    properties,
    required,
});
export const routineSchemas: Record<string, SchemaObject> = {
    RoutineParticipant: object({ personId: uuid, memberId: nullable(uuid) }),
    RoutineDeadline: object({
        date: { type: 'string', format: 'date' },
        time: nullable({
            type: 'string',
            pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
        }),
    }),
    RoutineUrgency: {
        type: 'string',
        enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'],
    },
    RoutineCreateTask: object(
        {
            description: { type: 'string', minLength: 1, maxLength: 500 },
            assigneeMemberId: nullable(uuid),
            deadline: nullable(ref('RoutineDeadline')),
            urgency: { ...ref('RoutineUrgency'), default: 'NORMAL' },
            shoppingListId: nullable(uuid),
        },
        ['description'],
    ),
    RoutineAssignment: object({
        expectedVersion: integer,
        assigneeMemberId: nullable(uuid),
    }),
    RoutineTask: object({
        id: uuid,
        spaceId: uuid,
        description: { type: 'string' },
        creator: ref('RoutineParticipant'),
        assignee: nullable(ref('RoutineParticipant')),
        deadline: nullable(ref('RoutineDeadline')),
        urgency: ref('RoutineUrgency'),
        status: { type: 'string', enum: ['PENDING', 'COMPLETED', 'CANCELLED'] },
        version: integer,
        createdAt: { type: 'string', format: 'date-time' },
        completion: nullable(
            object({
                executor: ref('RoutineParticipant'),
                completedAt: { type: 'string', format: 'date-time' },
                assignee: nullable(ref('RoutineParticipant')),
            }),
        ),
        shoppingListId: nullable(uuid),
    }),
    RoutineTaskView: {
        allOf: [
            ref('RoutineTask'),
            object({
                kind: { type: 'string', enum: ['ONE_OFF'] },
                allowedActions: { type: 'array', items: { type: 'string' } },
            }),
        ],
    },
    RoutineTaskPage: object({
        items: { type: 'array', items: ref('RoutineTaskView') },
        nextCursor: nullable({ type: 'string' }),
    }),
    RoutineContext: object({
        spaceId: uuid,
        type: { type: 'string', enum: ['PERSONAL', 'SHARED'] },
        status: { type: 'string', enum: ['ACTIVE', 'CLOSING', 'CLOSED'] },
        actorMemberId: nullable(uuid),
        participants: {
            type: 'array',
            items: object({
                personId: uuid,
                memberId: nullable(uuid),
                displayName: { type: 'string' },
            }),
        },
    }),
    RoutineHistoryPage: object({
        items: {
            type: 'array',
            items: object({
                id: uuid,
                spaceId: uuid,
                aggregateId: uuid,
                sequence: integer,
                type: { type: 'string' },
                actorId: uuid,
                registeredAt: { type: 'string', format: 'date-time' },
                data: { type: 'object', additionalProperties: true },
            }),
        },
        nextCursor: nullable({ type: 'string' }),
    }),
};
routineSchemas.RoutineTaskView = object({
    ...routineSchemas.RoutineTask.properties,
    kind: { type: 'string', enum: ['ONE_OFF'] },
    allowedActions: {
        type: 'array',
        items: {
            type: 'string',
            enum: [
                'ASSIGN',
                'COMPLETE',
                'DEADLINE',
                'URGENCY',
                'CANCEL',
                'REOPEN',
                'LINK_SHOPPING_LIST',
                'UNLINK_SHOPPING_LIST',
            ],
        },
    },
});
routineSchemas.RoutineConditions = object({
    today: { type: 'boolean' },
    overdue: { type: 'boolean' },
    urgent: { type: 'boolean' },
    upcoming: { type: 'boolean' },
    noDeadline: { type: 'boolean' },
    group: {
        type: 'string',
        enum: ['OVERDUE', 'TODAY', 'UPCOMING', 'NO_DEADLINE'],
    },
});
routineSchemas.RoutineTaskView = object({
    ...routineSchemas.RoutineTaskView.properties,
    conditions: ref('RoutineConditions'),
});
routineSchemas.RoutineCounts = object(
    Object.fromEntries(
        [
            'totalCount',
            'today',
            'overdue',
            'urgent',
            'upcoming',
            'noDeadline',
        ].map((k) => [k, { type: 'integer', minimum: 0 }]),
    ),
);
routineSchemas.RoutineTaskPage = object({
    ...routineSchemas.RoutineTaskPage.properties,
    referenceDate: { type: 'string', format: 'date' },
    referenceTime: { type: 'string' },
    referenceInstant: { type: 'string', format: 'date-time' },
    counts: ref('RoutineCounts'),
});
routineSchemas.RoutineAttentionSummary = object({
    items: { type: 'array', maxItems: 4, items: ref('RoutineTaskView') },
    counts: ref('RoutineCounts'),
    hasMore: { type: 'boolean' },
    referenceDate: { type: 'string', format: 'date' },
    referenceInstant: { type: 'string', format: 'date-time' },
});
routineSchemas.RoutineTaskDetail = object({
    ...routineSchemas.RoutineTaskView.properties,
    referenceDate: { type: 'string', format: 'date' },
    referenceTime: { type: 'string' },
    referenceInstant: { type: 'string', format: 'date-time' },
    shoppingList: nullable(
        object({
            id: uuid,
            name: nullable({ type: 'string' }),
            status: { type: 'string', enum: ['ACTIVE', 'ARCHIVED'] },
            summary: object({
                activeItemCount: { type: 'integer', minimum: 0 },
                actionableItemCount: { type: 'integer', minimum: 0 },
                isComplete: { type: 'boolean' },
            }),
        }),
    ),
});
export function routineOperation(
    method: 'get' | 'post',
    path: string,
    result: string,
    body?: string,
): OperationObject {
    const parameters: NonNullable<OperationObject['parameters']> = [
        ...path.matchAll(/\{(\w+)\}/g),
    ].map(([, name]) => ({
        name,
        in: 'path',
        required: true,
        schema:
            name === 'scheduledDate'
                ? { type: 'string', format: 'date' }
                : uuid,
    }));
    if (method === 'post')
        parameters.push(
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
            {
                name: 'Origin',
                in: 'header',
                required: true,
                schema: { type: 'string' },
            },
        );
    if (method === 'get' && result.endsWith('Page'))
        parameters.push(
            {
                name: 'limit',
                in: 'query',
                schema: {
                    type: 'integer',
                    default: 20,
                    minimum: 1,
                    maximum: 100,
                },
            },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
        );
    return {
        tags: ['Routine'],
        summary: body ? 'Registrar alteração na rotina' : 'Consultar rotina',
        description:
            'Dados privados do espaço. Escritas exigem espaço ativo, versão vigente e chave estável; replay revalida acesso e preserva resultado. Erros de entrada identificam campos em português.',
        security: [{ sessionCookie: [] }],
        parameters,
        ...(body
            ? {
                  requestBody: {
                      required: true,
                      content: { 'application/json': { schema: ref(body) } },
                  },
              }
            : {}),
        responses: Object.fromEntries(
            [
                [
                    method === 'post' &&
                    (path.endsWith('/tasks') ||
                        path.endsWith('/task-recurrences'))
                        ? '201'
                        : '200',
                    result,
                ],
                ['400', 'ErrorResponse'],
                ['401', 'ErrorResponse'],
                ['403', 'ErrorResponse'],
                ['404', 'ErrorResponse'],
                ['409', 'ErrorResponse'],
                ['500', 'ErrorResponse'],
            ].map(([status, schema]) => [
                status,
                {
                    description:
                        status === '409'
                            ? 'CONCURRENT_MODIFICATION, IDEMPOTENCY_KEY_REUSED ou INVALID_TASK_TRANSITION'
                            : status === '400'
                              ? 'VALIDATION_ERROR ou INVALID_ASSIGNEE'
                              : 'Resultado da operação',
                    headers: {
                        'Cache-Control': {
                            schema: { type: 'string', enum: ['no-store'] },
                        },
                    },
                    content: { 'application/json': { schema: ref(schema) } },
                },
            ]),
        ),
    };
}
const base = '/v2/spaces/{spaceId}';
routineSchemas.RoutineTaskVersion = object({ expectedVersion: integer });
routineSchemas.RoutineTaskShoppingLink = object({
    expectedVersion: integer,
    shoppingListId: uuid,
});
routineSchemas.RoutineDeadlineChange = object({
    expectedVersion: integer,
    deadline: nullable(ref('RoutineDeadline')),
});
routineSchemas.RoutineUrgencyChange = object({
    expectedVersion: integer,
    urgency: ref('RoutineUrgency'),
});
export const routineOpenApi: Pick<
    OpenAPIObject,
    'tags' | 'paths' | 'components'
> = {
    tags: [{ name: 'Routine', description: 'Tarefas e histórico por espaço.' }],
    paths: {
        ...Object.fromEntries(
            Object.entries({
                deadline: 'RoutineDeadlineChange',
                urgency: 'RoutineUrgencyChange',
                cancel: 'RoutineTaskVersion',
            }).map(([action, body]) => {
                const path = `${base}/tasks/{taskId}/${action}`;
                return [
                    path,
                    {
                        post: routineOperation(
                            'post',
                            path,
                            'RoutineTask',
                            body,
                        ),
                    },
                ];
            }),
        ),
        ...Object.fromEntries(
            ['complete', 'reopen'].map((action) => {
                const path = `${base}/tasks/{taskId}/${action}`;
                return [
                    path,
                    {
                        post: routineOperation(
                            'post',
                            path,
                            'RoutineTask',
                            'RoutineTaskVersion',
                        ),
                    },
                ];
            }),
        ),
        [`${base}/routine-context`]: {
            get: routineOperation(
                'get',
                `${base}/routine-context`,
                'RoutineContext',
            ),
        },
        [`${base}/tasks`]: {
            get: routineOperation('get', `${base}/tasks`, 'RoutineTaskPage'),
            post: routineOperation(
                'post',
                `${base}/tasks`,
                'RoutineTask',
                'RoutineCreateTask',
            ),
        },
        [`${base}/tasks/{taskId}`]: {
            get: routineOperation(
                'get',
                `${base}/tasks/{taskId}`,
                'RoutineTaskDetail',
            ),
        },
        [`${base}/tasks/{taskId}/history`]: {
            get: routineOperation(
                'get',
                `${base}/tasks/{taskId}/history`,
                'RoutineHistoryPage',
            ),
        },
        [`${base}/tasks/{taskId}/assignment`]: {
            post: routineOperation(
                'post',
                `${base}/tasks/{taskId}/assignment`,
                'RoutineTask',
                'RoutineAssignment',
            ),
        },
    },
    components: { schemas: routineSchemas },
};
for (const [suffix, body] of Object.entries({
    'shopping-list': 'RoutineTaskShoppingLink',
    'shopping-list/removal': 'RoutineTaskVersion',
})) {
    const path = `${base}/tasks/{taskId}/${suffix}`;
    routineOpenApi.paths[path] = {
        post: routineOperation('post', path, 'RoutineTask', body),
    };
}
const taskListOperation = routineOpenApi.paths[`${base}/tasks`]!.get!;
taskListOperation.parameters!.push(
    ...Object.entries({
        status: ['PENDING', 'COMPLETED', 'CANCELLED', 'SKIPPED', 'ALL'],
        scope: ['MINE', 'ALL'],
        attention: ['TODAY', 'URGENT', 'OVERDUE', 'UPCOMING', 'NO_DEADLINE'],
    }).map(([name, values]) => ({
        name,
        in: 'query' as const,
        schema: { type: 'string' as const, enum: values },
    })),
    ...['from', 'to'].map((name) => ({
        name,
        in: 'query' as const,
        schema: { type: 'string' as const, format: 'date' },
    })),
);
taskListOperation.description +=
    ' Ordenação: atrasadas, hoje, próximas, sem prazo; urgência, prazo e identidade dentro de cada grupo. Cursor conserva referência temporal e filtros; Minhas considera responsável atual. Contagens usam os mesmos filtros. Horário local America/Sao_Paulo; prazo sem horário vale até o fim do dia.';
const recurrenceBase = `${base}/task-recurrences`;
const recurrenceRule: SchemaObject = {
    oneOf: [
        object({ frequency: { type: 'string', enum: ['DAILY'] } }),
        object({
            frequency: { type: 'string', enum: ['WEEKLY'] },
            weekday: {
                type: 'integer',
                minimum: 1,
                maximum: 7,
                description: 'Dia ISO: segunda=1, domingo=7.',
            },
        }),
        object({
            frequency: { type: 'string', enum: ['WEEKDAYS'] },
            weekdays: {
                type: 'array',
                minItems: 1,
                maxItems: 7,
                uniqueItems: true,
                items: { type: 'integer', minimum: 1, maximum: 7 },
            },
        }),
        object({
            frequency: { type: 'string', enum: ['MONTHLY'] },
            day: { type: 'integer', minimum: 1, maximum: 31 },
        }),
        object({
            frequency: { type: 'string', enum: ['ANNUAL'] },
            month: { type: 'integer', minimum: 1, maximum: 12 },
            day: { type: 'integer', minimum: 1, maximum: 31 },
        }),
    ],
};
const recurrenceDeadline = nullable(
    object({
        time: nullable({
            type: 'string',
            pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
        }),
    }),
);
const recurrenceFields = {
    description: { type: 'string' as const, minLength: 1, maxLength: 500 },
    urgency: ref('RoutineUrgency'),
    deadline: recurrenceDeadline,
    rule: recurrenceRule,
    startsOn: { type: 'string' as const, format: 'date' },
    endsOn: nullable({ type: 'string', format: 'date' }),
};
routineSchemas.RoutineCreateRecurrence = object(
    { ...recurrenceFields, assigneeMemberId: nullable(uuid) },
    ['description', 'rule', 'startsOn'],
);
routineSchemas.RoutineRecurrence = object({
    ...recurrenceFields,
    id: uuid,
    spaceId: uuid,
    creator: ref('RoutineParticipant'),
    assignee: nullable(ref('RoutineParticipant')),
    status: { type: 'string', enum: ['ACTIVE', 'CANCELLED'] },
    version: integer,
    createdAt: { type: 'string', format: 'date-time' },
    cancelledAt: nullable({ type: 'string', format: 'date-time' }),
    cancelledOn: nullable({ type: 'string', format: 'date' }),
});
routineSchemas.RoutineRecurrence.properties!.closure = object({
    processId: uuid,
    planRevision: integer,
    recordedAt: { type: 'string', format: 'date-time' },
});
routineSchemas.RoutineRecurrencePage = object({
    items: { type: 'array', items: ref('RoutineRecurrence') },
    nextCursor: nullable({ type: 'string' }),
});
const occurrenceFields = {
    ...Object.fromEntries(
        Object.entries(routineSchemas.RoutineTask.properties!).filter(
            ([key]) => key !== 'shoppingListId',
        ),
    ),
    id: {
        type: 'string' as const,
        description:
            'UUID quando materializada; recurrenceId/scheduledDate quando virtual.',
    },
    version: nullable(integer),
    status: {
        type: 'string' as const,
        enum: ['PENDING', 'COMPLETED', 'SKIPPED', 'CANCELLED'],
    },
    kind: { type: 'string' as const, enum: ['OCCURRENCE'] },
    recurrenceId: uuid,
    scheduledDate: { type: 'string' as const, format: 'date' },
    recurrenceVersion: integer,
    materialized: { type: 'boolean' as const },
};
routineSchemas.RoutineOccurrenceResult = object(occurrenceFields);
routineSchemas.RoutineOccurrenceView = object({
    ...occurrenceFields,
    allowedActions: { type: 'array', items: { type: 'string' } },
    conditions: ref('RoutineConditions'),
});
routineSchemas.RoutineOccurrenceDetail = object({
    ...routineSchemas.RoutineOccurrenceView.properties,
    referenceDate: { type: 'string', format: 'date' },
    referenceTime: { type: 'string' },
    referenceInstant: { type: 'string', format: 'date-time' },
});
routineSchemas.RoutineOccurrencePage = object(
    {
        ...routineSchemas.RoutineTaskPage.properties,
        items: { type: 'array', items: ref('RoutineOccurrenceView') },
        window: object({
            from: { type: 'string', format: 'date' },
            to: { type: 'string', format: 'date' },
        }),
    },
    [
        'items',
        'nextCursor',
        'window',
        'referenceDate',
        'referenceTime',
        'referenceInstant',
    ],
);
routineSchemas.RoutineOccurrenceCommand = object({
    expectedRecurrenceVersion: integer,
    expectedOccurrenceVersion: nullable(integer),
});
const taskItems: SchemaObject = {
    type: 'array',
    items: { oneOf: [ref('RoutineTaskView'), ref('RoutineOccurrenceView')] },
};
routineSchemas.RoutineTaskPage.properties!.items = taskItems;
routineSchemas.RoutineAttentionSummary.properties!.items = {
    ...taskItems,
    maxItems: 4,
};
routineOpenApi.paths[recurrenceBase] = {
    get: routineOperation('get', recurrenceBase, 'RoutineRecurrencePage'),
    post: routineOperation(
        'post',
        recurrenceBase,
        'RoutineRecurrence',
        'RoutineCreateRecurrence',
    ),
};
for (const [suffix, schema] of Object.entries({
    '/{recurrenceId}': 'RoutineRecurrence',
    '/{recurrenceId}/history': 'RoutineHistoryPage',
    '/{recurrenceId}/occurrences': 'RoutineOccurrencePage',
    '/{recurrenceId}/occurrences/{scheduledDate}': 'RoutineOccurrenceDetail',
    '/{recurrenceId}/occurrences/{scheduledDate}/history': 'RoutineHistoryPage',
})) {
    const path = recurrenceBase + suffix;
    routineOpenApi.paths[path] = { get: routineOperation('get', path, schema) };
}
for (const action of ['complete', 'reopen', 'skip']) {
    const path = `${recurrenceBase}/{recurrenceId}/occurrences/{scheduledDate}/${action}`;
    routineOpenApi.paths[path] = {
        post: routineOperation(
            'post',
            path,
            'RoutineOccurrenceResult',
            'RoutineOccurrenceCommand',
        ),
    };
}
const cancelPath = `${recurrenceBase}/{recurrenceId}/cancel`;
routineOpenApi.paths[cancelPath] = {
    post: routineOperation(
        'post',
        cancelPath,
        'RoutineRecurrence',
        'RoutineTaskVersion',
    ),
};
routineOpenApi.paths[
    `${recurrenceBase}/{recurrenceId}/occurrences`
]!.get!.parameters!.push(
    ...['from', 'to'].map((name) => ({
        name,
        in: 'query' as const,
        schema: { type: 'string' as const, format: 'date' },
    })),
);
for (const [path, operations] of Object.entries(routineOpenApi.paths))
    for (const method of ['get', 'post'] as const) {
        const operation = operations?.[method];
        if (operation) {
            operation.operationId =
                method +
                path.replace(/[^a-zA-Z0-9]+(.)/g, (_, next: string) =>
                    next.toUpperCase(),
                );
            operation.description +=
                ' Recorrências: datas inclusivas; mensal preserva dia-base e usa último dia válido; anual 29/02 usa 28/02 em ano comum. Projeção por período: até 366 dias. Sem prazo, datas futuras virtuais exigem período explícito. Consulta operacional conta o histórico por calendário e busca lacunas limitadas à página, sem corte de pendências antigas. Cancelar regra corta novas datas após o dia local, preservando antigas/de hoje e toda materializada futura. expectedOccurrenceVersion null apenas para virtual; manutenção avulsa não edita ocorrências.';
        }
    }
