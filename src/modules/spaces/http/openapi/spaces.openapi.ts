import type {
    OpenAPIObject,
    OperationObject,
    ReferenceObject,
    ResponseObject,
    SchemaObject,
} from '@nestjs/swagger';

type Schema = SchemaObject | ReferenceObject;

const ref = (name: string): ReferenceObject => ({
    $ref: `#/components/schemas/${name}`,
});

const parameter = (name: string): ReferenceObject => ({
    $ref: `#/components/parameters/${name}`,
});

const response = (name: string): ReferenceObject => ({
    $ref: `#/components/responses/${name}`,
});

const values = (...items: string[]): SchemaObject => ({
    type: 'string',
    enum: items,
});

const object = (properties: Record<string, Schema>): SchemaObject => ({
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
});

const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const version: SchemaObject = { type: 'integer', minimum: 1 };
const nil: SchemaObject = { type: 'null' };
const noStore = {
    'Cache-Control': {
        description: 'Não armazenar a resposta em cache.',
        schema: values('no-store'),
    },
};

function jsonResponse(schema: Schema, description: string): ResponseObject {
    return {
        description,
        headers: noStore,
        content: { 'application/json': { schema } },
    };
}

function errorResponse(...codes: string[]): ResponseObject {
    return jsonResponse(
        {
            allOf: [
                ref('ErrorResponse'),
                { type: 'object', properties: { code: values(...codes) } },
            ],
        },
        codes.join(', '),
    );
}

const commonResponses = {
    400: errorResponse('VALIDATION_ERROR', 'HTTP_ERROR'),
    401: response('Unauthenticated'),
    500: errorResponse('INTERNAL_ERROR'),
    default: response('UnexpectedError'),
};

function readOperation(
    operationId: string,
    summary: string,
    result: string,
    detail = false,
): OperationObject {
    return {
        operationId,
        summary,
        tags: ['Spaces'],
        security: [{ sessionCookie: [] }],
        ...(detail ? { parameters: [parameter('SpaceId')] } : {}),
        responses: {
            ...commonResponses,
            200: jsonResponse(
                ref(result),
                'Consulta autorizada, sem segredos.',
            ),
            ...(detail ? { 404: errorResponse('SPACE_NOT_FOUND') } : {}),
        },
    };
}

function writeOperation(
    operationId: string,
    summary: string,
    body: string,
    result: string,
    pathParameters: string[],
    conflicts: string[],
): OperationObject {
    return {
        operationId,
        summary,
        tags: ['Spaces'],
        security: [{ sessionCookie: [] }],
        description:
            'Exige sessão, CSRF e chave idempotente. O ator vem da sessão. ' +
            'CSRF pode ser recusado antes da autenticação. ' +
            'Replay consulta o recibo antes de comparar expectedVersion, ' +
            'revalida acesso e retorna os IDs originais com estado atual, ' +
            'sem repetir a escrita nem devolver o segredo. ' +
            'Não repetir automaticamente após falha de rede ou CSRF.',
        parameters: [
            parameter('CsrfHeader'),
            parameter('SpacesIdempotencyKey'),
            ...pathParameters.map(parameter),
        ],
        requestBody: {
            required: true,
            content: { 'application/json': { schema: ref(body) } },
        },
        responses: {
            ...commonResponses,
            201: jsonResponse(ref(result), 'Operação concluída ou replay.'),
            403: errorResponse(
                'INVALID_CSRF_TOKEN',
                ...(pathParameters.length
                    ? ['INVITATION_ISSUER_REQUIRED']
                    : []),
            ),
            404: errorResponse('SPACE_NOT_FOUND'),
            409: errorResponse(...conflicts),
        },
    };
}

function invitationResult(withMembership: boolean): SchemaObject {
    return {
        ...object({
            space: ref('SpacesSharedSummary'),
            invitation: ref('SpacesInvitationSummary'),
            ...(withMembership
                ? { actorMembership: ref('SpacesActorMembership') }
                : {}),
            inviteUrl: {
                type: ['string', 'null'],
                format: 'uri',
                pattern: '/invitations#token=[A-Za-z0-9_-]{43}$',
                description:
                    'Somente na emissão: origem WEB_ORIGIN, caminho /invitations ' +
                    'e fragmento token= seguido de 43 caracteres base64url. ' +
                    'Nunca persistir o link. No replay, null.',
            },
            linkAvailable: { type: 'boolean' },
            replayed: { type: 'boolean' },
        }),
        oneOf: [
            {
                properties: {
                    space: { properties: { status: values('ACTIVE') } },
                    invitation: { properties: { status: values('PENDING') } },
                    inviteUrl: { type: 'string', format: 'uri' },
                    linkAvailable: { enum: [true] },
                    replayed: { enum: [false] },
                },
            },
            {
                properties: {
                    inviteUrl: nil,
                    linkAvailable: { enum: [false] },
                    replayed: { enum: [true] },
                },
            },
        ],
    };
}

const invitationConflicts = [
    'SPACE_NOT_ACTIVE',
    'SPACE_MEMBER_LIMIT_REACHED',
    'CONCURRENT_MODIFICATION',
    'IDEMPOTENCY_KEY_REUSED',
];

export const spacesOpenApi: Pick<
    OpenAPIObject,
    'tags' | 'paths' | 'components'
> = {
    tags: [{ name: 'Spaces', description: 'Espaços e emissão de convites' }],
    paths: {
        ...financialEntryContextOpenApi.paths,
        '/v2/spaces': {
            get: {
                ...readOperation(
                    'listAccessibleSpaces',
                    'Listar os espaços acessíveis à pessoa',
                    'SpacesListResponse',
                ),
                description:
                    'Pessoal primeiro; compartilhados por createdAt e id, ' +
                    'em ordem crescente. Sem paginação neste card.',
            },
            post: writeOperation(
                'createSharedSpace',
                'Criar espaço, primeiro membro e convite atomicamente',
                'SpacesCreateRequest',
                'SpacesCreateResponse',
                [],
                ['IDEMPOTENCY_KEY_REUSED'],
            ),
        },
        '/v2/spaces/{spaceId}': {
            get: readOperation(
                'getSpaceDetails',
                'Consultar um espaço acessível',
                'SpacesDetailsResponse',
                true,
            ),
        },
        '/v2/spaces/{spaceId}/invitations': {
            post: writeOperation(
                'issueSpaceInvitation',
                'Emitir convite quando não houver pendente válido',
                'SpacesInvitationRequest',
                'SpacesInvitationCommandResponse',
                ['SpaceId'],
                [...invitationConflicts, 'INVITATION_ALREADY_PENDING'],
            ),
        },
        '/v2/spaces/{spaceId}/invitations/{invitationId}/replace': {
            post: writeOperation(
                'replaceSpaceInvitation',
                'Substituir explicitamente um convite pendente válido',
                'SpacesInvitationRequest',
                'SpacesInvitationCommandResponse',
                ['SpaceId', 'InvitationId'],
                [...invitationConflicts, 'INVITATION_NOT_REPLACEABLE'],
            ),
        },
    },
    components: {
        parameters: {
            SpaceId: {
                name: 'spaceId',
                in: 'path',
                required: true,
                schema: uuid,
            },
            InvitationId: {
                name: 'invitationId',
                in: 'path',
                required: true,
                schema: uuid,
            },
            SpacesIdempotencyKey: {
                name: 'Idempotency-Key',
                in: 'header',
                required: true,
                schema: uuid,
                description:
                    'UUID por intenção. Reusar na tentativa manual da mesma ' +
                    'operação/rota/entrada normalizada. Escopo por ator e operação. ' +
                    'Após rever um conflito, usar nova chave para a nova intenção.',
            },
        },
        schemas: {
            ...financialEntryContextOpenApi.components?.schemas,
            SpacesCreateRequest: object({
                name: {
                    type: 'string',
                    description:
                        'Aplicar trim externo; resultado com String.length ' +
                        'entre 1 e 80 unidades UTF-16, sem controles C0/C1. ' +
                        'Preservar caixa e espaços internos. Nomes podem repetir. ' +
                        'A regra exige validação após normalização; ' +
                        'maxLength do JSON Schema não expressa essa contagem.',
                },
            }),
            SpacesInvitationRequest: object({ expectedVersion: version }),
            SpacesPersonalSummary: object({
                id: uuid,
                type: values('PERSONAL'),
                status: values('ACTIVE'),
                label: values('Meu espaço'),
                version,
            }),
            SpacesSharedSummary: object({
                id: uuid,
                type: values('SHARED'),
                status: values('ACTIVE', 'CLOSING', 'CLOSED'),
                label: { type: 'string' },
                version,
            }),
            SpacesSummary: {
                oneOf: [
                    ref('SpacesPersonalSummary'),
                    ref('SpacesSharedSummary'),
                ],
            },
            SpacesListResponse: object({
                items: { type: 'array', items: ref('SpacesSummary') },
            }),
            SpacesActorMembership: object({
                id: uuid,
                personId: uuid,
                status: values('ACTIVE'),
            }),
            SpacesInvitationSummary: object({
                id: uuid,
                status: values(
                    'PENDING',
                    'ACCEPTED',
                    'REJECTED',
                    'CANCELLED',
                    'EXPIRED',
                ),
                expiresAt: {
                    type: 'string',
                    format: 'date-time',
                    description:
                        'UTC; emissão + 72 horas. Inválido quando now >= expiresAt. ' +
                        'PENDING vencido é apresentado como EXPIRED, sem escrita no GET.',
                },
            }),
            SpacesInvitationDetails: {
                ...object({
                    id: uuid,
                    status: values(
                        'PENDING',
                        'ACCEPTED',
                        'REJECTED',
                        'CANCELLED',
                        'EXPIRED',
                    ),
                    expiresAt: { type: 'string', format: 'date-time' },
                    canIssue: { type: 'boolean' },
                    canReplace: { type: 'boolean' },
                }),
                description:
                    'Último convite, apenas para o criador. Status efetivo pelo relógio. ' +
                    'canIssue: criador ativo, espaço ACTIVE, vaga e convite EXPIRED/REJECTED. ' +
                    'canReplace: mesmas condições, mas convite PENDING válido. ' +
                    'Sem convite anterior, invitation é null; a emissão exige ACTIVE e vaga.',
            },
            SpacesDetailsResponse: {
                oneOf: [
                    object({
                        space: ref('SpacesPersonalSummary'),
                        actorMembership: nil,
                        activeMemberCount: { type: 'integer', enum: [0] },
                        invitation: nil,
                    }),
                    object({
                        space: ref('SpacesSharedSummary'),
                        actorMembership: ref('SpacesActorMembership'),
                        activeMemberCount: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 2,
                        },
                        invitation: {
                            oneOf: [ref('SpacesInvitationDetails'), nil],
                        },
                    }),
                ],
                description:
                    'Titular acessa PERSONAL; membro ativo acessa SHARED. ' +
                    'Ausente ou sem acesso: 404. Para membro não criador, invitation é null.',
            },
            SpacesInvitationCommandResponse: invitationResult(false),
            SpacesCreateResponse: invitationResult(true),
        },
    },
};
import { financialEntryContextOpenApi } from './financial-entry-context.openapi.js';
