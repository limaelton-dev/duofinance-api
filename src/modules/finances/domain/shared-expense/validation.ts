import { FinancesError } from '../errors/finances.error.js';
export function invalidExpense(): never {
    throw new FinancesError('VALIDATION_ERROR');
}
