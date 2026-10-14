import type {
    OpenAPIObject,
    SchemaObject,
    ResponseObject,
    ReferenceObject,
} from '@nestjs/swagger';
import { sharedCashExpenseOpenApi } from './shared-cash-expense.openapi.js';
import { interMemberPositionOpenApi } from './inter-member-position.openapi.js';
import { settlementCycleOpenApi } from './settlement-cycle.openapi.js';
import { settlementTransferOpenApi } from './settlement-transfer.openapi.js';
import { personalExpenseOpenApi } from './personal-expense.openapi.js';
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (
    properties: Record<string, SchemaObject | ReferenceObject>,
): SchemaObject => ({
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
});
const rule = object({
    kind: { type: 'string', enum: ['MONTHLY_DAY'] },
    dayOfMonth: { type: 'integer', minimum: 1, maximum: 31 },
});
const view = object({
    spaceId: { type: 'string', format: 'uuid' },
    rule: { oneOf: [ref('SettlementRule'), { type: 'null' }] },
    version: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    updatedAt: {
        oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
});
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
const parameters = [
    {
        name: 'spaceId',
        in: 'path' as const,
        required: true,
        schema: { type: 'string', format: 'uuid' },
    },
];
const responses = {
    400: error('VALIDATION_ERROR'),
    401: error('UNAUTHENTICATED'),
    404: error('SPACE_NOT_FOUND'),
    409: error('SHARED_SPACE_REQUIRED'),
    429: error('TOO_MANY_REQUESTS'),
    500: error('INTERNAL_ERROR'),
};
export const financesOpenApi: Pick<
    OpenAPIObject,
    'tags' | 'paths' | 'components'
> = {
    tags: [
        {
            name: 'Finances',
            description: 'Regras padrão de acerto, como sugestões futuras.',
        },
    ],
    paths: {
        ...personalExpenseOpenApi.paths,
        ...sharedCashExpenseOpenApi.paths,
        ...interMemberPositionOpenApi.paths,
        ...settlementCycleOpenApi.paths,
        ...settlementTransferOpenApi.paths,
        '/v2/spaces/{spaceId}/default-settlement-rule': {
            get: {
                operationId: 'getDefaultSettlementRule',
                tags: ['Finances'],
                summary: 'Consultar a regra padrão de acerto',
                security: [{ sessionCookie: [] }],
                parameters,
                responses: {
                    ...responses,
                    200: {
                        ...response(
                            ref('DefaultSettlementRuleResponse'),
                            'Ausência autorizada: rule null, version 0, updatedAt null. Leitura não cria configuração.',
                        ),
                        content: {
                            'application/json': {
                                schema: ref('DefaultSettlementRuleResponse'),
                                examples: {
                                    absent: {
                                        value: {
                                            spaceId:
                                                '11111111-1111-4111-8111-111111111111',
                                            rule: null,
                                            version: 0,
                                            updatedAt: null,
                                        },
                                    },
                                    configured: {
                                        value: {
                                            spaceId:
                                                '11111111-1111-4111-8111-111111111111',
                                            rule: {
                                                kind: 'MONTHLY_DAY',
                                                dayOfMonth: 10,
                                            },
                                            version: 1,
                                            updatedAt:
                                                '2026-10-10T12:00:00.000Z',
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            put: {
                operationId: 'configureDefaultSettlementRule',
                tags: ['Finances'],
                summary: 'Configurar ou alterar a regra padrão de acerto',
                description:
                    'Apenas SHARED ACTIVE. Não altera fatos existentes. Replay autorizado retorna o resultado histórico; consulte GET para obter o estado atual. Mesma versão e dia é no-op. Versão obsoleta conflita.',
                security: [{ sessionCookie: [] }],
                parameters: [
                    ...parameters,
                    {
                        name: 'X-CSRF-Token',
                        in: 'header',
                        required: true,
                        schema: { type: 'string' },
                    },
                    {
                        name: 'Idempotency-Key',
                        in: 'header',
                        required: true,
                        schema: { type: 'string', format: 'uuid' },
                        description:
                            'Conserve a mesma chave e entrada no retry de resultado incerto.',
                    },
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: ref(
                                'ConfigureDefaultSettlementRuleRequest',
                            ),
                            example: {
                                expectedVersion: 0,
                                rule: { kind: 'MONTHLY_DAY', dayOfMonth: 10 },
                            },
                        },
                    },
                },
                responses: {
                    ...responses,
                    200: response(
                        ref('ConfigureDefaultSettlementRuleResponse'),
                        'Configuração, alteração, no-op ou replay autorizado.',
                    ),
                    403: error('INVALID_CSRF_TOKEN'),
                    409: error(
                        'SHARED_SPACE_REQUIRED',
                        'SPACE_NOT_ACTIVE',
                        'CONCURRENT_MODIFICATION',
                        'IDEMPOTENCY_KEY_REUSED',
                    ),
                },
            },
        },
    },
    components: {
        schemas: {
            ...personalExpenseOpenApi.components?.schemas,
            ...sharedCashExpenseOpenApi.components?.schemas,
            ...interMemberPositionOpenApi.components?.schemas,
            ...settlementCycleOpenApi.components?.schemas,
            ...settlementTransferOpenApi.components?.schemas,
            SettlementRule: rule,
            DefaultSettlementRuleResponse: view,
            ConfigureDefaultSettlementRuleRequest: object({
                expectedVersion: {
                    type: 'integer',
                    minimum: 0,
                    maximum: Number.MAX_SAFE_INTEGER,
                },
                rule: ref('SettlementRule'),
            }),
            ConfigureDefaultSettlementRuleResponse: object({
                ...view.properties,
                changed: { type: 'boolean' },
                replayed: { type: 'boolean' },
            }),
        },
    },
};
