import type {
    OpenAPIObject,
    SchemaObject,
    ReferenceObject,
    ParameterObject,
} from '@nestjs/swagger';
import { financialClosureBlockerTypes } from '../../modules/finances/application/ports/public/financial-closure-diagnostics.port.js';
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
const uuid: SchemaObject = { type: 'string', format: 'uuid' },
    version: SchemaObject = {
        type: 'integer',
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
    },
    date: SchemaObject = { type: 'string', format: 'date' },
    instant: SchemaObject = { type: 'string', format: 'date-time' };
const nullable = (schema: SchemaObject | ReferenceObject): SchemaObject => ({
    oneOf: [schema, { type: 'null' }],
});
const consent = object({
    memberId: uuid,
    planRevision: version,
    recordedAt: instant,
});
const response = (schema: SchemaObject | ReferenceObject) => ({
    description: 'Resultado autorizado; sem cache.',
    headers: {
        'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
    },
    content: { 'application/json': { schema } },
});
const params: ParameterObject[] = [
    { name: 'spaceId', in: 'path', required: true, schema: uuid },
];
const command = (operationId: string, schema: string, status = 200) => ({
    operationId,
    tags: ['SpaceClosure'],
    security: [{ sessionCookie: [] }],
    parameters: [
        ...params,
        { $ref: '#/components/parameters/CsrfHeader' },
        {
            name: 'Idempotency-Key',
            in: 'header' as const,
            required: true,
            schema: uuid,
        },
    ],
    requestBody: {
        required: true,
        content: { 'application/json': { schema: ref(schema) } },
    },
    responses: {
        [status]: response(ref('SpaceClosureView')),
        400: response(ref('ErrorResponse')),
        401: response(ref('ErrorResponse')),
        403: response(ref('ErrorResponse')),
        404: response(ref('ErrorResponse')),
        409: response(ref('ErrorResponse')),
    },
});
const query = (
    operationId: string,
    schema: SchemaObject | ReferenceObject,
    extra: ParameterObject[] = [],
) => ({
    operationId,
    tags: ['SpaceClosure'],
    security: [{ sessionCookie: [] }],
    parameters: [...params, ...extra],
    responses: {
        200: response(schema),
        400: response(ref('ErrorResponse')),
        401: response(ref('ErrorResponse')),
        404: response(ref('ErrorResponse')),
        409: response(ref('ErrorResponse')),
        503: response(ref('ErrorResponse')),
    },
});
export const closureOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components' | 'tags'
> = {
    tags: [
        {
            name: 'SpaceClosure',
            description:
                'Encerramento com consentimento individual na formação elegível ou bilateral, preservando o histórico.',
        },
    ],
    paths: {
        '/v2/spaces/{spaceId}/closure': {
            post: command('startSharedSpaceClosure', 'StartClosure', 201),
            get: query(
                'getSharedSpaceClosure',
                nullable(ref('SpaceClosureView')),
            ),
        },
        '/v2/spaces/{spaceId}/closure/cutoff-date': {
            post: command('proposeClosureCutoff', 'ClosureCutoff'),
        },
        '/v2/spaces/{spaceId}/closure/diagnostic': {
            get: query('getClosureDiagnostic', ref('ClosureDiagnostic'), [
                {
                    name: 'limit',
                    in: 'query',
                    schema: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 100,
                        default: 20,
                    },
                },
                {
                    name: 'offset',
                    in: 'query',
                    schema: { type: 'integer', minimum: 0, default: 0 },
                },
            ]),
        },
        '/v2/spaces/{spaceId}/closure/history': {
            get: query(
                'getClosureHistory',
                object({
                    items: { type: 'array', items: ref('ClosureHistoryEntry') },
                    nextCursor: nullable({ type: 'string' }),
                }),
                [
                    {
                        name: 'limit',
                        in: 'query',
                        schema: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 100,
                            default: 20,
                        },
                    },
                    { name: 'cursor', in: 'query', schema: { type: 'string' } },
                ],
            ),
        },
    },
    components: {
        schemas: {
            ClosureBlocker: {
                type: 'object',
                additionalProperties: false,
                required: ['type', 'originId', 'action'],
                properties: {
                    type: {
                        type: 'string',
                        enum: [...financialClosureBlockerTypes],
                    },
                    originId: uuid,
                    action: { type: 'string' },
                    commitmentId: uuid,
                    occurrenceId: uuid,
                    description: { type: 'string' },
                    version,
                    referenceDate: date,
                    amountInCents: nullable({
                        type: 'string',
                        pattern: '^[0-9]+$',
                    }),
                    debtorMemberId: uuid,
                    creditorMemberId: uuid,
                    responsibleMemberId: uuid,
                },
            },
            StartClosure: object({ expectedSpaceVersion: version }),
            ClosureCutoff: object({
                expectedSpaceVersion: version,
                expectedPlanRevision: version,
                cutoffDate: date,
            }),
            ClosureConsent: consent,
            SpaceClosureView: object({
                spaceId: uuid,
                spaceStatus: {
                    type: 'string',
                    enum: ['ACTIVE', 'CLOSING', 'CLOSED'],
                },
                spaceVersion: version,
                processId: uuid,
                processStatus: {
                    type: 'string',
                    enum: ['OPEN', 'COMPLETED', 'CANCELLED'],
                },
                planRevision: version,
                planStatus: {
                    type: 'string',
                    enum: ['DRAFT', 'PROPOSED', 'APPROVED', 'REJECTED'],
                },
                cutoffDate: date,
                proposedCutoffDate: nullable(date),
                requestedByMemberId: uuid,
                requiredMemberIds: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 2,
                    items: uuid,
                },
                participants: {
                    type: 'array',
                    items: object({
                        memberId: uuid,
                        personId: uuid,
                        displayName: { type: 'string' },
                    }),
                },
                approvals: { type: 'array', items: consent },
                confirmations: { type: 'array', items: consent },
                startedAt: instant,
                completedAt: nullable(instant),
                cancelledAt: nullable(instant),
                invitationStatus: nullable({ type: 'string' }),
            }),
            ClosureHistoryEntry: object({
                id: uuid,
                processId: uuid,
                action: { type: 'string' },
                actorMemberId: uuid,
                planRevision: version,
                recordedAt: instant,
                snapshot: ref('SpaceClosureView'),
            }),
            ClosureDiagnostic: object({
                spaceId: uuid,
                closure: nullable(ref('SpaceClosureView')),
                finance: object({
                    blockers: { type: 'array', items: ref('ClosureBlocker') },
                    totalCount: { type: 'integer', minimum: 0 },
                    counts: {
                        type: 'object',
                        additionalProperties: { type: 'integer', minimum: 0 },
                    },
                    outstandingAmounts: {
                        type: 'array',
                        items: object({
                            debtorMemberId: uuid,
                            creditorMemberId: uuid,
                            amountInCents: {
                                type: 'string',
                                pattern: '^[0-9]+$',
                            },
                        }),
                    },
                    financiallyReady: { type: 'boolean' },
                }),
                informational: object({
                    routine: object({
                        pendingTaskCount: { type: 'integer', minimum: 0 },
                        activeRecurrenceCount: { type: 'integer', minimum: 0 },
                    }),
                    shopping: object({
                        activeListCount: { type: 'integer', minimum: 0 },
                    }),
                    blocksFinancialClosure: { type: 'boolean', enum: [false] },
                }),
            }),
        },
    },
};
