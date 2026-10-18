import { financesOpenApi } from '../../modules/finances/http/openapi/finances.openapi.js';
import { routineOpenApi } from '../../modules/routine/http/routine.openapi.js';
import { financialReviewOpenApi } from '../../modules/finances/http/openapi/financial-review.openapi.js';
import { todayOpenApi } from '../today/today.openapi.js';
import type { OpenAPIObject } from '@nestjs/swagger';

import { createAuthOpenApiDocument } from '../../modules/identity/http/openapi/auth.openapi.js';
import { spacesOpenApi } from '../../modules/spaces/http/openapi/spaces.openapi.js';
import { invitationsOpenApi } from '../../modules/spaces/http/openapi/invitations.openapi.js';

export function createApiOpenApiDocument(isProduction: boolean): OpenAPIObject {
    const auth = createAuthOpenApiDocument(isProduction);

    return {
        ...auth,
        info: {
            ...auth.info,
            title: 'Prospera Mais API',
            version: '0.5.0',
        },
        tags: [
            ...(auth.tags ?? []),
            ...(spacesOpenApi.tags ?? []),
            ...(financesOpenApi.tags ?? []),
            ...(todayOpenApi.tags ?? []),
            ...(routineOpenApi.tags ?? []),
        ],
        paths: {
            ...auth.paths,
            ...spacesOpenApi.paths,
            ...invitationsOpenApi.paths,
            ...financesOpenApi.paths,
            ...financialReviewOpenApi.paths,
            ...todayOpenApi.paths,
            ...routineOpenApi.paths,
        },
        components: {
            ...auth.components,
            schemas: {
                ...auth.components?.schemas,
                ...spacesOpenApi.components?.schemas,
                ...invitationsOpenApi.components?.schemas,
                ...financesOpenApi.components?.schemas,
                ...financialReviewOpenApi.components?.schemas,
                ...todayOpenApi.components?.schemas,
                ...routineOpenApi.components?.schemas,
            },
            parameters: {
                ...auth.components?.parameters,
                ...spacesOpenApi.components?.parameters,
            },
            responses: {
                ...auth.components?.responses,
                ...spacesOpenApi.components?.responses,
            },
            securitySchemes: {
                ...auth.components?.securitySchemes,
                ...spacesOpenApi.components?.securitySchemes,
            },
        },
    };
}
