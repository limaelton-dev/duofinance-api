import type { HttpErrorMapper } from '../../../../shared/technical/http/api-exception.filter.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
export const mapFinancesError: HttpErrorMapper = (error) =>
    error instanceof FinancesError
        ? {
              status:
                  error.code === 'FINANCIAL_CHANGE_RECIPIENT_REQUIRED' ||
                  error.code === 'EXTERNAL_LIABILITY_HOLDER_REQUIRED' ||
                  error.code === 'OBLIGATION_CREDITOR_REQUIRED'
                      ? 403
                      : error.code === 'VALIDATION_ERROR'
                        ? 400
                        : error.code.endsWith('_NOT_FOUND')
                          ? 404
                          : 409,
              body: {
                  code: error.code,
                  message: error.message,
                  details: error.fields.length
                      ? {
                            fields: error.fields.map((field) => ({
                                field,
                                messages: ['Verifique este campo.'],
                            })),
                        }
                      : {},
              },
          }
        : null;
