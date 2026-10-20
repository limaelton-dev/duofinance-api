import type {
    HeaderObject,
    OpenAPIObject,
    ReferenceObject,
    ResponseObject,
    SchemaObject,
} from '@nestjs/swagger';

const schemaRef = (name: string): ReferenceObject => ({
    $ref: `#/components/schemas/${name}`,
});

const responseRef = (name: string): ReferenceObject => ({
    $ref: `#/components/responses/${name}`,
});

const noStore: HeaderObject = {
    description: 'A resposta não deve ser armazenada em cache.',
    schema: { type: 'string', enum: ['no-store'] },
};

const email: SchemaObject = {
    type: 'string',
    format: 'email',
    maxLength: 254,
};

const password: SchemaObject = {
    type: 'string',
    format: 'password',
    minLength: 6,
    maxLength: 128,
    writeOnly: true,
};

function successResponse(
    description: string,
    schemaName?: string,
    setsCookie = false,
): ResponseObject {
    const headers: Record<string, HeaderObject> = {
        'Cache-Control': noStore,
    };

    if (setsCookie) {
        headers['Set-Cookie'] = {
            description:
                'Define ou remove cookies HttpOnly, SameSite=Lax, Path=/ e sem Domain. Secure em produção.',
            schema: { type: 'string' },
        };
    }

    return {
        description,
        headers,
        ...(schemaName
            ? {
                  content: {
                      'application/json': { schema: schemaRef(schemaName) },
                  },
              }
            : {}),
    };
}

function errorResponse(
    code: string,
    message: string,
    details: Record<string, unknown> = {},
): ResponseObject {
    return {
        description: message,
        headers: { 'Cache-Control': noStore },
        content: {
            'application/json': {
                schema: schemaRef('ErrorResponse'),
                example: { code, message, details },
            },
        },
    };
}

export function createAuthOpenApiDocument(
    isProduction: boolean,
): OpenAPIObject {
    const csrfHeader: ReferenceObject = {
        $ref: '#/components/parameters/CsrfHeader',
    };

    const tooManyRequests = errorResponse(
        'TOO_MANY_REQUESTS',
        'Muitas tentativas. Tente novamente em alguns instantes.',
    );

    tooManyRequests.headers = {
        ...tooManyRequests.headers,
        'Retry-After': {
            description: 'Tempo de espera, em segundos.',
            schema: { type: 'integer', minimum: 0 },
        },
    };

    return {
        openapi: '3.1.0',
        info: {
            title: 'DuoFinance API — Identidade e acesso',
            version: '0.1.0',
            description:
                'Cadastro, login, sessão e espaço pessoal. ' +
                'A sessão usa cookie HttpOnly e validade absoluta de 7 dias. ' +
                'Obtenha CSRF antes de POST e novamente após cadastro, login ou logout. ' +
                'O token CSRF depende dos cookies recebidos; envie-os nas requisições. ' +
                'Não repita mutations automaticamente após falha de CSRF.',
        },
        servers: [{ url: '/', description: 'Servidor atual' }],
        tags: [{ name: 'Auth', description: 'Autenticação e sessão' }],
        paths: {
            '/v2/auth/csrf': {
                get: {
                    operationId: 'getCsrfToken',
                    tags: ['Auth'],
                    summary: 'Obter token CSRF',
                    description: 'Limite: 60 requisições por minuto por IP.',
                    security: [],
                    responses: {
                        200: successResponse(
                            'Token CSRF emitido.',
                            'CsrfTokenResponse',
                            true,
                        ),
                        429: responseRef('TooManyRequests'),
                        default: responseRef('UnexpectedError'),
                    },
                },
            },
            '/v2/auth/register': {
                post: {
                    operationId: 'registerAccount',
                    tags: ['Auth'],
                    summary: 'Criar conta, espaço pessoal e sessão',
                    description: 'Limite: 5 requisições por 10 minutos por IP.',
                    security: [],
                    parameters: [csrfHeader],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: schemaRef('RegisterAccountRequest'),
                            },
                        },
                    },
                    responses: {
                        201: successResponse(
                            'Conta criada.',
                            'AuthenticatedContext',
                            true,
                        ),
                        400: responseRef('ValidationError'),
                        403: responseRef('CsrfError'),
                        409: responseRef('EmailAlreadyInUse'),
                        429: responseRef('TooManyRequests'),
                        default: responseRef('UnexpectedError'),
                    },
                },
            },
            '/v2/auth/login': {
                post: {
                    operationId: 'login',
                    tags: ['Auth'],
                    summary: 'Entrar e criar uma sessão',
                    description: 'Limite: 10 requisições por minuto por IP.',
                    security: [],
                    parameters: [csrfHeader],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: schemaRef('LoginRequest'),
                            },
                        },
                    },
                    responses: {
                        200: successResponse(
                            'Sessão criada.',
                            'AuthenticatedContext',
                            true,
                        ),
                        400: responseRef('ValidationError'),
                        401: responseRef('InvalidCredentials'),
                        403: responseRef('CsrfError'),
                        429: responseRef('TooManyRequests'),
                        default: responseRef('UnexpectedError'),
                    },
                },
            },
            '/v2/auth/me': {
                get: {
                    operationId: 'getCurrentAuthenticatedContext',
                    tags: ['Auth'],
                    summary: 'Consultar pessoa e espaço da sessão atual',
                    security: [{ sessionCookie: [] }],
                    responses: {
                        200: successResponse(
                            'Contexto atual.',
                            'AuthenticatedContext',
                        ),
                        401: responseRef('Unauthenticated'),
                        default: responseRef('UnexpectedError'),
                    },
                },
            },
            '/v2/auth/logout': {
                post: {
                    operationId: 'logout',
                    tags: ['Auth'],
                    summary: 'Revogar somente a sessão atual',
                    security: [{ sessionCookie: [] }],
                    parameters: [csrfHeader],
                    responses: {
                        204: successResponse(
                            'Sessão revogada e cookie removido.',
                            undefined,
                            true,
                        ),
                        401: responseRef('Unauthenticated'),
                        403: responseRef('CsrfError'),
                        default: responseRef('UnexpectedError'),
                    },
                },
            },
        },
        components: {
            securitySchemes: {
                sessionCookie: {
                    type: 'apiKey',
                    in: 'cookie',
                    name: isProduction ? '__Host-session' : 'session',
                    description:
                        'Cookie HttpOnly definido pelo cadastro ou login.',
                },
            },
            parameters: {
                CsrfHeader: {
                    name: 'X-CSRF-Token',
                    in: 'header',
                    required: true,
                    description:
                        'Token obtido em GET /v2/auth/csrf, acompanhado dos cookies correspondentes.',
                    schema: { type: 'string', minLength: 1 },
                },
            },
            schemas: {
                CsrfTokenResponse: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['csrfToken'],
                    properties: { csrfToken: { type: 'string' } },
                },
                RegisterAccountRequest: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['displayName', 'email', 'password'],
                    properties: {
                        displayName: {
                            type: 'string',
                            minLength: 2,
                            maxLength: 80,
                        },
                        email,
                        password,
                    },
                },
                LoginRequest: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['email', 'password'],
                    properties: { email, password },
                },
                PersonSummary: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['id', 'displayName', 'email'],
                    properties: {
                        id: { type: 'string', format: 'uuid' },
                        displayName: { type: 'string' },
                        email,
                    },
                },
                PersonalSpaceSummary: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['id', 'type', 'label'],
                    properties: {
                        id: { type: 'string', format: 'uuid' },
                        type: { type: 'string', enum: ['PERSONAL'] },
                        label: { type: 'string', enum: ['Meu espaço'] },
                    },
                },
                AuthenticatedContext: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['person', 'personalSpace'],
                    properties: {
                        person: schemaRef('PersonSummary'),
                        personalSpace: schemaRef('PersonalSpaceSummary'),
                    },
                },
                FieldError: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['field', 'messages'],
                    properties: {
                        field: { type: 'string' },
                        messages: { type: 'array', items: { type: 'string' } },
                    },
                },
                ErrorResponse: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['code', 'message', 'details'],
                    properties: {
                        code: { type: 'string' },
                        message: { type: 'string' },
                        details: {
                            type: 'object',
                            additionalProperties: true,
                            properties: {
                                fields: {
                                    type: 'array',
                                    items: schemaRef('FieldError'),
                                },
                            },
                        },
                    },
                },
            },
            responses: {
                ValidationError: {
                    ...errorResponse(
                        'VALIDATION_ERROR',
                        'Verifique os dados informados.',
                        {
                            fields: [
                                {
                                    field: 'email',
                                    messages: ['email must be an email'],
                                },
                            ],
                        },
                    ),
                    description:
                        'Dados inválidos: VALIDATION_ERROR. JSON malformado: HTTP_ERROR.',
                },
                InvalidCredentials: errorResponse(
                    'INVALID_CREDENTIALS',
                    'E-mail ou senha inválidos.',
                ),
                Unauthenticated: errorResponse(
                    'UNAUTHENTICATED',
                    'Sua sessão não é válida ou expirou.',
                ),
                CsrfError: errorResponse(
                    'INVALID_CSRF_TOKEN',
                    'Não foi possível validar esta solicitação. Atualize a página e tente novamente.',
                ),
                EmailAlreadyInUse: errorResponse(
                    'EMAIL_ALREADY_IN_USE',
                    'Já existe uma conta com este e-mail.',
                ),
                TooManyRequests: tooManyRequests,
                UnexpectedError: {
                    description:
                        'Demais erros: HTTP_ERROR em 4xx; INTERNAL_ERROR em 5xx.',
                    headers: { 'Cache-Control': noStore },
                    content: {
                        'application/json': {
                            schema: schemaRef('ErrorResponse'),
                            examples: {
                                http: {
                                    value: {
                                        code: 'HTTP_ERROR',
                                        message:
                                            'Não foi possível processar esta solicitação.',
                                        details: {},
                                    },
                                },
                                internal: {
                                    value: {
                                        code: 'INTERNAL_ERROR',
                                        message:
                                            'Ocorreu um erro interno. Tente novamente mais tarde.',
                                        details: {},
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    };
}
