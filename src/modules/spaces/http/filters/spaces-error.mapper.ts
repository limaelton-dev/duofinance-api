import type { HttpErrorMapper } from '../../../../shared/technical/http/api-exception.filter.js';

import { ConcurrentModificationError } from '../../application/errors/concurrent-modification.error.js';
import { IdempotencyKeyReusedError } from '../../application/errors/idempotency-key-reused.error.js';
import {
    SpacesDomainError,
    type SpacesDomainErrorCode,
} from '../../domain/errors/spaces-domain.error.js';

const domainStatuses: Record<SpacesDomainErrorCode, number> = {
    CLOSURE_DESTINATION_INVALID: 400,
    CLOSURE_PROCESS_NOT_FOUND: 404,
    CLOSURE_PROCESS_NOT_OPEN: 409,
    CLOSURE_CUTOFF_INVALID: 400,
    CLOSURE_PLAN_UNCHANGED: 409,
    CLOSURE_HISTORY_CURSOR_INVALID: 400,
    SHARED_SPACE_REQUIRED: 409,
    VALIDATION_ERROR: 400,
    SPACE_NOT_FOUND: 404,
    SPACE_NOT_ACTIVE: 409,
    SPACE_MEMBER_LIMIT_REACHED: 409,
    INVITATION_ISSUER_REQUIRED: 403,
    INVITATION_ALREADY_PENDING: 409,
    INVITATION_NOT_REPLACEABLE: 409,
    INVITATION_UNAVAILABLE: 404,
    INVITATION_RESPONSE_NOT_ALLOWED: 403,
};

export const mapSpacesError: HttpErrorMapper = (exception) => {
    if (exception instanceof SpacesDomainError) {
        return {
            status: domainStatuses[exception.code],
            body: {
                code: exception.code,
                message: exception.message,
                details: {},
            },
        };
    }

    if (
        exception instanceof ConcurrentModificationError ||
        exception instanceof IdempotencyKeyReusedError
    ) {
        return {
            status: 409,
            body: {
                code: exception.code,
                message: exception.message,
                details: {},
            },
        };
    }

    return null;
};
