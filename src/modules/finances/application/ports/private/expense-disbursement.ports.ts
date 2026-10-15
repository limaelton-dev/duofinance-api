import type {
    RecordExpenseDisbursementCommand,
    ExpenseDisbursementResult,
} from '../../models/expense-disbursement.js';
export const EXPENSE_DISBURSEMENT_RECEIPTS = Symbol(
    'EXPENSE_DISBURSEMENT_RECEIPTS',
);
export interface ExpenseDisbursementReceipts {
    find(
        command: RecordExpenseDisbursementCommand,
    ): Promise<ExpenseDisbursementResult | null>;
    save(
        command: RecordExpenseDisbursementCommand,
        result: ExpenseDisbursementResult,
        registeredAt: string,
    ): Promise<void>;
}
