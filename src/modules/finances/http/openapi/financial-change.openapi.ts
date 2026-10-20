import type {
    OpenAPIObject,
    OperationObject,
    ReferenceObject,
    ResponseObject,
    SchemaObject,
} from '@nestjs/swagger';
import { recurringCommitmentOpenApi } from './recurring-commitment.openapi.js';

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
const kind: SchemaObject = { type: 'string', enum: ['EXPENSE', 'INCOME'] };
const description: SchemaObject = {
    type: 'string',
    minLength: 1,
    maxLength: 160,
};
const status: SchemaObject = {
    type: 'string',
    enum: ['PROPOSED', 'ACCEPTED', 'REJECTED', 'CANCELLED'],
};
const signedMoney: SchemaObject = { type: 'string', pattern: '^-?\\d+$' };
const economicShares: SchemaObject = nullable({
    type: 'array',
    minItems: 1,
    maxItems: 2,
    items: object({ memberId: uuid, amountInCents: money }),
});
const versionProperties = {
    id: uuid,
    spaceId: uuid,
    commitmentId: uuid,
    targetId: uuid,
    installmentId: nullable(uuid),
    version: positive,
    effectiveFrom: date,
    description,
    amountInCents: positive,
    distribution: nullable(ref('ResponsibilitySplit')),
    economicShares,
    expectedMemberId: nullable(uuid),
    actorId: uuid,
    registeredAt: instant,
};
const commonInput = {
    kind,
    description,
    amountInCents: {
        ...positive,
        description:
            'Valor total proposto para o compromisso avulso ou para a soma das parcelas selecionadas. Não representa o valor individual de cada parcela quando há mais de uma na seleção.',
    } as SchemaObject,
    effectiveFrom: {
        ...date,
        description:
            'Vigência futura. A configuração anterior continua válida antes desta data e enquanto a proposta não tiver sido aceita.',
    } as SchemaObject,
    expectedCommitmentVersion: positive,
    installmentIds: {
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: uuid,
        description:
            'Somente para parcelados. Seleciona parcelas futuras elegíveis, sem realização ou resolução. A ausência seleciona as parcelas elegíveis a partir da vigência.',
    } as SchemaObject,
};
const personalInput = object({
    ...commonInput,
    scope: { type: 'string', enum: ['PERSONAL'] },
});
personalInput.required = personalInput.required!.filter(
    (name) => name !== 'installmentIds',
);
const sharedInput = object({
    ...commonInput,
    scope: { type: 'string', enum: ['SHARED'] },
    expectedSpaceVersion: positive,
    distribution: ref('ResponsibilitySplit'),
    expectedMemberId: nullable(uuid),
});
sharedInput.required = sharedInput.required!.filter(
    (name) => !['installmentIds', 'expectedMemberId'].includes(name),
);
const targetProperties = {
    id: uuid,
    dueDate: nullable(date),
    originalAmountInCents: positive,
    amountInCents: positive,
    economicShares,
    fulfilledAmountInCents: money,
    stateVersion: positive,
    resolved: boolean,
};
const nonRecurringImpact = {
    commitmentId: uuid,
    kind,
    modality: {
        type: 'string',
        enum: ['ONE_TIME', 'INSTALLMENT'],
    } as SchemaObject,
    currentVersion: positive,
    proposedVersion: positive,
    effectiveFrom: date,
    currentAmountInCents: signedMoney,
    proposedAmountInCents: signedMoney,
    impactByMember: {
        type: 'array',
        maxItems: 2,
        items: object({
            memberId: uuid,
            currentAmountInCents: signedMoney,
            proposedAmountInCents: signedMoney,
            deltaInCents: signedMoney,
            requiresAcceptance: boolean,
        }),
    } as SchemaObject,
    requiresAcceptance: boolean,
    recipientMemberId: nullable(uuid),
    targets: {
        type: 'array',
        minItems: 1,
        maxItems: 1200,
        items: object({
            ...targetProperties,
            proposed: object({
                targetId: uuid,
                amountInCents: positive,
                economicShares,
            }),
        }),
    } as SchemaObject,
    versions: {
        type: 'array',
        items: ref('FinancialNonRecurringEconomicVersion'),
    } as SchemaObject,
    eligible: { type: 'boolean', enum: [true] } as SchemaObject,
    cashImpactInCents: { type: 'string', enum: ['0'] } as SchemaObject,
    supportedImpactInCents: { type: 'string', enum: ['0'] } as SchemaObject,
    pendingImpactInCents: { type: 'string', enum: ['0'] } as SchemaObject,
};
const nonRecurringResponse = object({
    ...nonRecurringImpact,
    version: positive,
    replayed: boolean,
});
const recurringResponse = recurringCommitmentOpenApi.components!.schemas!
    .RecurringVersionChangeResponse as SchemaObject;
const proposal = object({
    id: uuid,
    spaceId: uuid,
    commitmentId: uuid,
    version: positive,
    baseVersion: positive,
    originFingerprint: {
        type: 'string',
        pattern: '^[a-f0-9]{32}$',
        description: 'Identifica o estado materializado da origem ao propor.',
    },
    proposedByMemberId: uuid,
    recipientMemberId: uuid,
    actorId: uuid,
    effectiveFrom: date,
    configuration: {
        oneOf: [
            ref('FinancialCommitmentChangeRequest'),
            ref('FinancialCommitmentAdjustmentProposalConfiguration'),
        ],
    },
    impact: {
        oneOf: [
            ref('FinancialCommitmentChangePreview'),
            ref('FinancialCommitmentAdjustmentPreview'),
        ],
    },
    status,
    registeredAt: instant,
    decidedAt: nullable(instant),
    decidedByPersonId: nullable(uuid),
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
const errors = {
    400: error('VALIDATION_ERROR'),
    401: error('UNAUTHENTICATED'),
    404: error(
        'SPACE_NOT_FOUND',
        'FINANCIAL_COMMITMENT_NOT_FOUND',
        'FINANCIAL_CHANGE_PROPOSAL_NOT_FOUND',
    ),
    409: error(
        'CONCURRENT_MODIFICATION',
        'IDEMPOTENCY_KEY_REUSED',
        'EXPENSE_OPTIONS_CHANGED',
        'SPACE_NOT_ACTIVE',
        'SHARED_SPACE_REQUIRED',
        'PERSONAL_SPACE_REQUIRED',
        'RECURRENCE_ACCEPTANCE_REQUIRED',
        'RECURRENCE_ALREADY_TERMINATED',
        'OCCURRENCE_ALREADY_RESOLVED',
        'FINANCIAL_CHANGE_PROPOSAL_RESOLVED',
        'FINANCIAL_CHANGE_PROPOSAL_OBSOLETE',
    ),
    429: error('TOO_MANY_REQUESTS'),
    500: error('INTERNAL_ERROR'),
};
const path = (name: string) => ({
    name,
    in: 'path' as const,
    required: true,
    schema: uuid,
});
const listQuery = [
    {
        name: 'status',
        in: 'query' as const,
        required: false,
        schema: status,
    },
    {
        name: 'recipient',
        in: 'query' as const,
        required: false,
        schema: { type: 'string' as const, enum: ['ME'] },
        description: 'Filtra propostas destinadas ao membro autenticado.',
    },
    {
        name: 'cursor',
        in: 'query' as const,
        required: false,
        schema: { type: 'string' as const, maxLength: 2048 },
        description:
            'Cursor opaco vinculado ao usuário, espaço, compromisso e filtros. Cada página contém até 20 propostas.',
    },
];
function read(
    operationId: string,
    summary: string,
    schema: string,
    names: string[],
    list = false,
): OperationObject {
    return {
        operationId,
        tags: ['Finances'],
        summary,
        description:
            'Consulta autorizada sem escrita. Histórico preservado; consultar não altera versões ou fatos financeiros.',
        security: [{ sessionCookie: [] }],
        parameters: [
            path('spaceId'),
            ...names.map(path),
            ...(list ? listQuery : []),
        ],
        responses: {
            ...errors,
            200: response(schema, 'Consulta autorizada.'),
        },
    };
}
function command(
    operationId: string,
    summary: string,
    request: string,
    result: string,
    proposalId = false,
    preview = false,
): OperationObject {
    return {
        operationId,
        tags: ['Finances'],
        summary,
        description: preview
            ? 'Prévia sem escrita. Compara responsabilidade individual, vigência e seleção futura; preserva fatos materializados. Aumento de despesa ou redução de receita de outro membro exige proposta. Alterar apenas a estimativa de recorrência variável não exige aceite.'
            : 'Comando atômico com controle das versões esperadas e recibo idempotente. Repita a mesma chave e entrada após resultado incerto. Apenas o destinatário onerado decide; o aceite aplica uma versão futura e conserva os fatos anteriores. Proposta obsoleta por nova versão, realização interveniente ou vigência passada conflita. Rejeitar conserva a configuração anterior. A alteração direta atende configurações pessoais ou sem oneração de outro membro.',
        security: [{ sessionCookie: [] }],
        parameters: [
            path('spaceId'),
            path('commitmentId'),
            ...(proposalId ? [path('proposalId')] : []),
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
                              'Conserve a chave e o corpo originais no retry.',
                      },
                  ]),
        ],
        requestBody: {
            required: true,
            content: { 'application/json': { schema: ref(request) } },
        },
        responses: {
            ...errors,
            403: error(
                'INVALID_CSRF_TOKEN',
                'FINANCIAL_CHANGE_RECIPIENT_REQUIRED',
            ),
            200: response(
                result,
                preview
                    ? 'Prévia calculada sem escrita.'
                    : 'Replay autorizado.',
            ),
            ...(preview
                ? {}
                : {
                      201: response(
                          result,
                          'Comando confirmado integralmente.',
                      ),
                  }),
        },
    };
}

const base = '/v2/spaces/{spaceId}/financial-commitments/{commitmentId}';
const proposals = `${base}/change-proposals`;

export const financialChangeOpenApi: Pick<
    OpenAPIObject,
    'paths' | 'components'
> = {
    paths: {
        [`${base}/change-preview`]: {
            post: command(
                'previewFinancialCommitmentChange',
                'Simular alteração futura de compromisso',
                'FinancialCommitmentChangeRequest',
                'FinancialCommitmentChangePreview',
                false,
                true,
            ),
        },
        [`${base}/versions`]: {
            get: read(
                'getFinancialCommitmentVersionHistory',
                'Consultar versões vigentes, futuras e histórico do compromisso',
                'FinancialCommitmentVersionHistory',
                ['commitmentId'],
            ),
            post: command(
                'changeFinancialCommitmentVersion',
                'Confirmar alteração futura sem aceite pendente',
                'FinancialCommitmentChangeRequest',
                'FinancialCommitmentVersionChangeResponse',
            ),
        },
        [proposals]: {
            post: command(
                'proposeFinancialCommitmentChange',
                'Propor alteração que exige aceite de outro membro',
                'FinancialCommitmentChangeRequest',
                'FinancialCommitmentProposalCommandResponse',
            ),
        },
        '/v2/spaces/{spaceId}/financial-change-proposals': {
            get: read(
                'listSpaceFinancialChangeProposals',
                'Consultar propostas do espaço e pendências do destinatário',
                'FinancialCommitmentChangeProposalList',
                [],
                true,
            ),
        },
        [`${proposals}/{proposalId}/acceptance`]: {
            post: command(
                'acceptFinancialCommitmentChangeProposal',
                'Aceitar proposta como destinatário onerado',
                'DecideFinancialCommitmentChangeRequest',
                'FinancialCommitmentChangeAcceptanceResponse',
                true,
            ),
        },
        [`${proposals}/{proposalId}/rejection`]: {
            post: command(
                'rejectFinancialCommitmentChangeProposal',
                'Rejeitar proposta como destinatário onerado',
                'DecideFinancialCommitmentChangeRequest',
                'FinancialCommitmentProposalCommandResponse',
                true,
            ),
        },
    },
    components: {
        schemas: {
            FinancialCommitmentChangeRequest: {
                oneOf: [
                    ref('ChangeRecurringCommitmentRequest'),
                    ref('NonRecurringCommitmentChangeRequest'),
                ],
            },
            NonRecurringCommitmentChangeRequest: {
                oneOf: [personalInput, sharedInput],
            },
            DecideFinancialCommitmentChangeRequest: object({
                expectedCommitmentVersion: positive,
                expectedProposalVersion: positive,
                expectedSpaceVersion: positive,
            }),
            FinancialNonRecurringEconomicVersion: object(versionProperties),
            FinancialNonRecurringVersionHistory: object({
                commitmentId: uuid,
                version: positive,
                targets: {
                    type: 'array',
                    items: object(targetProperties),
                },
                versions: {
                    type: 'array',
                    items: ref('FinancialNonRecurringEconomicVersion'),
                },
                currentVersions: {
                    type: 'array',
                    items: object({
                        targetId: uuid,
                        version: nullable(
                            ref('FinancialNonRecurringEconomicVersion'),
                        ),
                    }),
                },
                nextVersions: {
                    type: 'array',
                    items: ref('FinancialNonRecurringEconomicVersion'),
                },
            }),
            FinancialCommitmentVersionHistory: {
                oneOf: [
                    object({ commitment: ref('RecurringCommitment') }),
                    ref('FinancialNonRecurringVersionHistory'),
                ],
            },
            NonRecurringCommitmentChangePreview: object(nonRecurringImpact),
            FinancialCommitmentChangePreview: {
                oneOf: [
                    ref('RecurringChangePreview'),
                    ref('NonRecurringCommitmentChangePreview'),
                ],
            },
            NonRecurringCommitmentVersionChangeResponse: nonRecurringResponse,
            FinancialCommitmentVersionChangeResponse: {
                oneOf: [
                    ref('RecurringVersionChangeResponse'),
                    ref('NonRecurringCommitmentVersionChangeResponse'),
                ],
            },
            FinancialCommitmentChangeProposal: proposal,
            FinancialCommitmentProposalCommandResponse: object({
                proposal: ref('FinancialCommitmentChangeProposal'),
                replayed: boolean,
            }),
            FinancialCommitmentChangeAcceptanceResponse: {
                oneOf: [
                    ref('FinancialCommitmentAdjustmentAcceptanceResponse'),
                    object({
                        ...recurringResponse.properties,
                        proposal: ref('FinancialCommitmentChangeProposal'),
                    }),
                    object({
                        ...nonRecurringResponse.properties,
                        proposal: ref('FinancialCommitmentChangeProposal'),
                    }),
                ],
            },
            FinancialCommitmentChangeProposalList: object({
                items: {
                    type: 'array',
                    maxItems: 20,
                    items: ref('FinancialCommitmentChangeProposal'),
                },
                totalCount: { type: 'integer', minimum: 0 },
                nextCursor: nullable({ type: 'string' }),
            }),
        },
    },
};
