import type {
    CreatePlannedExpenseCommand,
    PlannedExpenseResult,
} from '../../models/planned-expense.js';

export const PLANNED_EXPENSE_RECEIPTS = Symbol('PLANNED_EXPENSE_RECEIPTS');

export interface PlannedExpenseReceipts {
    find(
        command: CreatePlannedExpenseCommand,
    ): Promise<PlannedExpenseResult | null>;
    save(
        command: CreatePlannedExpenseCommand,
        result: PlannedExpenseResult,
        registeredAt: string,
    ): Promise<void>;
}
