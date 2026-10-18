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
    allowedActions: { type: 'array', items: { type: 'string' } },
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
});
export function routineOperation(
    method: 'get' | 'post',
    path: string,
    result: string,
    body?: string,
): OperationObject {
    const parameters: NonNullable<OperationObject['parameters']> = [
        ...path.matchAll(/\{(\w+)\}/g),
    ].map(([, name]) => ({ name, in: 'path', required: true, schema: uuid }));
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
                    method === 'post' && path.endsWith('/tasks')
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
export const routineOpenApi: Pick<
    OpenAPIObject,
    'tags' | 'paths' | 'components'
> = {
    tags: [{ name: 'Routine', description: 'Tarefas e histórico por espaço.' }],
    paths: {
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
const taskListOperation = routineOpenApi.paths[`${base}/tasks`]!.get!;
taskListOperation.parameters!.push(
    ...Object.entries({
        status: ['PENDING', 'COMPLETED', 'CANCELLED', 'ALL'],
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
