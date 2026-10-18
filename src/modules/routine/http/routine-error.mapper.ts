import type { HttpErrorMapper } from '../../../shared/technical/http/api-exception.filter.js';
import { RoutineError } from '../domain/routine-error.js';
export const mapRoutineError: HttpErrorMapper = (e) =>
    e instanceof RoutineError
        ? {
              status: e.code.endsWith('_NOT_FOUND')
                  ? 404
                  : e.code === 'VALIDATION_ERROR' ||
                      e.code === 'INVALID_ASSIGNEE'
                    ? 400
                    : 409,
              body: {
                  code: e.code,
                  message: e.message,
                  details: e.field
                      ? { fields: [{ field: e.field, messages: [e.message] }] }
                      : {},
              },
          }
        : null;
