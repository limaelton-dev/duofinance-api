import type { HttpErrorMapper } from '../../../shared/technical/http/api-exception.filter.js';
import { ShoppingError } from '../domain/shopping-error.js';

export const mapShoppingError: HttpErrorMapper = (error) =>
    error instanceof ShoppingError
        ? {
              status: error.code.endsWith('_NOT_FOUND')
                  ? 404
                  : error.code === 'VALIDATION_ERROR'
                    ? 400
                    : 409,
              body: {
                  code: error.code,
                  message: error.message,
                  details: error.field
                      ? {
                            fields: [
                                {
                                    field: error.field,
                                    messages: [error.message],
                                },
                            ],
                        }
                      : {},
              },
          }
        : null;
