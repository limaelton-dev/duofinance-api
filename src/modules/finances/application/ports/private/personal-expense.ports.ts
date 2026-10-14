import type {
    RecordPersonalExpenseCommand,
    PersonalExpenseResult,
    PersonalExpenseView,
    PersonalExpenseSummary,
} from '../../models/personal-expense.js';
export const PERSONAL_EXPENSE_RECEIPTS = Symbol('PERSONAL_EXPENSE_RECEIPTS');
export interface PersonalExpenseReceipts {
    find(
        command: RecordPersonalExpenseCommand,
    ): Promise<PersonalExpenseResult | null>;
    save(
        command: RecordPersonalExpenseCommand,
        result: PersonalExpenseResult,
        registeredAt: string,
    ): Promise<void>;
}
export const PERSONAL_EXPENSE_READER = Symbol('PERSONAL_EXPENSE_READER');
export interface PersonalExpenseReader {
    detail(
        spaceId: string,
        commitmentId: string,
    ): Promise<PersonalExpenseView | null>;
    list(
        spaceId: string,
        after: { factDate: string; id: string } | null,
    ): Promise<PersonalExpenseSummary[]>;
}
