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
    optional: string[] = [],
): SchemaObject => ({
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties).filter((key) => !optional.includes(key)),
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
const count: SchemaObject = { type: 'integer', minimum: 0 };
const routineSummary = object({
    pendingTaskCount: count,
    activeRecurrenceCount: count,
});
const shoppingSummary = object({ activeListCount: count });
const outstandingAmounts: SchemaObject = {
    type: 'array',
    items: object({
        debtorMemberId: uuid,
        creditorMemberId: uuid,
        amountInCents: { type: 'string', pattern: '^[0-9]+$' },
    }),
};
const financialDiagnostic = object({
    blockers: { type: 'array', items: ref('ClosureBlocker') },
    totalCount: count,
    counts: { type: 'object', additionalProperties: count },
    outstandingAmounts,
    financiallyReady: { type: 'boolean' },
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
        '/v2/spaces/{spaceId}/closure/plan-review': {
            get: query('reviewClosurePlan', ref('ClosurePlanReview')),
        },
        '/v2/spaces/{spaceId}/closure/proposal': {
            post: command('proposeClosurePlan', 'ClosurePlanConsent'),
        },
        '/v2/spaces/{spaceId}/closure/approval': {
            post: command('approveClosurePlan', 'ClosurePlanConsent'),
        },
        '/v2/spaces/{spaceId}/closure/rejection': {
            post: command('rejectClosurePlan', 'ClosurePlanDecision'),
        },
        '/v2/spaces/{spaceId}/closure/future-destinations': {
            post: command(
                'planClosureFutureDestination',
                'ClosureFutureDestinationInput',
            ),
        },
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
            ClosureFutureDestinationInput: {
                oneOf: [
                    'TERMINATE',
                    'PERSONAL_SUCCESSOR',
                    'SETTLE_BEFORE_CLOSURE',
                ].map((destination) =>
                    object({
                        expectedSpaceVersion: version,
                        expectedPlanRevision: version,
                        originType: {
                            type: 'string',
                            enum: ['RECURRING', 'INSTALLMENT'],
                        },
                        originId: uuid,
                        expectedOriginVersion: version,
                        destination: { type: 'string', enum: [destination] },
                        ...(destination === 'TERMINATE'
                            ? {}
                            : { assigneeMemberId: uuid }),
                        ...(destination === 'SETTLE_BEFORE_CLOSURE'
                            ? {
                                  amountInCents: {
                                      type: 'integer' as const,
                                      minimum: 1,
                                      maximum: Number.MAX_SAFE_INTEGER,
                                  },
                              }
                            : {}),
                    }),
                ),
            },
            ClosureFutureDestination: object(
                {
                    originType: {
                        type: 'string',
                        enum: ['RECURRING', 'INSTALLMENT'],
                    },
                    originId: uuid,
                    expectedOriginVersion: version,
                    destination: {
                        type: 'string',
                        enum: [
                            'TERMINATE',
                            'PERSONAL_SUCCESSOR',
                            'SETTLE_BEFORE_CLOSURE',
                        ],
                    },
                    assigneeMemberId: nullable(uuid),
                    amountInCents: nullable({
                        type: 'integer',
                        minimum: 1,
                        maximum: Number.MAX_SAFE_INTEGER,
                    }),
                    cutoffDate: date,
                    impactByMember: {
                        type: 'array',
                        items: object({
                            memberId: uuid,
                            beforeInCents: nullable({ type: 'string' }),
                            afterInCents: nullable({ type: 'string' }),
                            requiresAcceptance: { type: 'boolean' },
                        }),
                    },
                    originSnapshot: object(
                        {
                            version,
                            fingerprint: { type: 'string' },
                            kind: {
                                type: 'string',
                                enum: ['EXPENSE', 'INCOME'],
                            },
                            description: { type: 'string' },
                            eligibleRemainingInCents: nullable({
                                type: 'string',
                            }),
                            futureItems: {
                                type: 'array',
                                items: object({
                                    originItemId: nullable(uuid),
                                    referenceDate: date,
                                    remainingInCents: nullable({
                                        type: 'integer',
                                        minimum: 0,
                                        maximum: Number.MAX_SAFE_INTEGER,
                                    }),
                                    version: nullable(version),
                                }),
                            },
                            recurringImpacts: {
                                type: 'array',
                                items: object({
                                    basis: {
                                        type: 'string',
                                        enum: ['PER_OCCURRENCE'],
                                    },
                                    economicVersion: version,
                                    effectiveFrom: date,
                                    valueMode: {
                                        type: 'string',
                                        enum: ['FIXED', 'VARIABLE'],
                                    },
                                    amountInCents: nullable({
                                        type: 'integer',
                                        minimum: 1,
                                        maximum: Number.MAX_SAFE_INTEGER,
                                    }),
                                    distribution: {
                                        oneOf: [
                                            object({
                                                mode: {
                                                    type: 'string',
                                                    enum: ['AMOUNTS'],
                                                },
                                                shares: {
                                                    type: 'array',
                                                    items: object({
                                                        memberId: uuid,
                                                        amountInCents: {
                                                            type: 'integer',
                                                            minimum: 0,
                                                            maximum:
                                                                Number.MAX_SAFE_INTEGER,
                                                        },
                                                    }),
                                                },
                                            }),
                                            object({
                                                mode: {
                                                    type: 'string',
                                                    enum: ['PERCENTAGES'],
                                                },
                                                shares: {
                                                    type: 'array',
                                                    items: object({
                                                        memberId: uuid,
                                                        basisPoints: {
                                                            type: 'integer',
                                                            minimum: 0,
                                                            maximum: 10000,
                                                        },
                                                    }),
                                                },
                                            }),
                                        ],
                                    },
                                    impactByMember: {
                                        type: 'array',
                                        items: object({
                                            memberId: uuid,
                                            beforeInCents: nullable({
                                                type: 'string',
                                                pattern: '^[0-9]+$',
                                            }),
                                            afterInCents: nullable({
                                                type: 'string',
                                                pattern: '^[0-9]+$',
                                            }),
                                            beforeBasisPoints: nullable({
                                                type: 'integer',
                                                minimum: 0,
                                                maximum: 10000,
                                            }),
                                            afterBasisPoints: {
                                                type: 'integer',
                                                minimum: 0,
                                                maximum: 10000,
                                            },
                                        }),
                                    },
                                }),
                            },
                        },
                        ['recurringImpacts'],
                    ),
                    agreement: object({
                        debtorMemberId: uuid,
                        creditorMemberId: uuid,
                        amountInCents: {
                            type: 'integer',
                            minimum: 1,
                            maximum: Number.MAX_SAFE_INTEGER,
                        },
                    }),
                },
                ['agreement'],
            ),
            ClosureBlocker: {
                type: 'object',
                additionalProperties: false,
                required: ['type', 'originId', 'action'],
                properties: {
                    type: {
                        type: 'string',
                        enum: [...financialClosureBlockerTypes],
                    },
                    originId: { type: 'string', minLength: 1 },
                    action: { type: 'string' },
                    closureAgreementId: uuid,
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
            ClosurePlanDecision: object({
                expectedSpaceVersion: version,
                expectedPlanRevision: version,
            }),
            ClosurePlanConsent: object({
                expectedSpaceVersion: version,
                expectedPlanRevision: version,
                expectedFinancialFingerprint: {
                    type: 'string',
                    pattern: '^[a-f0-9]{64}$',
                },
            }),
            ClosureProposalSnapshot: object({
                financialFingerprint: { type: 'string' },
                financialBlockerCount: count,
                outstandingAmounts,
                routine: routineSummary,
                shopping: shoppingSummary,
            }),
            ClosurePlanReview: object({
                spaceId: uuid,
                closure: ref('SpaceClosureView'),
                finance: object({
                    fingerprint: { type: 'string' },
                    diagnostic: financialDiagnostic,
                    missingDestinationOriginIds: { type: 'array', items: uuid },
                }),
                informational: object({
                    routine: routineSummary,
                    shopping: shoppingSummary,
                }),
            }),
            SpaceClosureView: object(
                {
                    proposalSnapshot: nullable(ref('ClosureProposalSnapshot')),
                    hasBilateralApproval: { type: 'boolean' },
                    actorNextAction: {
                        type: 'string',
                        enum: [
                            'PROPOSE_PLAN',
                            'REVIEW_PLAN',
                            'WAIT_APPROVAL',
                            'RESOLVE_FINANCES',
                            'READ_ONLY',
                        ],
                    },
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
                    futureDestinations: {
                        type: 'array',
                        items: ref('ClosureFutureDestination'),
                    },
                    startedAt: instant,
                    completedAt: nullable(instant),
                    cancelledAt: nullable(instant),
                    invitationStatus: nullable({ type: 'string' }),
                },
                [
                    'futureDestinations',
                    'proposalSnapshot',
                    'hasBilateralApproval',
                    'actorNextAction',
                ],
            ),
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
