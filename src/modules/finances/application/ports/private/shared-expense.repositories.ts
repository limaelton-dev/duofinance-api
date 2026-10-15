import type {
    FinancialCommitment,
    ExpenseVersion,
    InterMemberObligation,
    SettlementCycle,
} from '../../../domain/shared-expense/shared-expense.js';
import type {
    RecordSharedCashExpenseCommand,
    SharedCashExpenseResult,
    SharedCashExpenseView,
} from '../../models/shared-cash-expense.js';
import type { OriginSettlement } from '../../../domain/shared-expense/obligation-reconciler.js';
import type { FulfillmentObligationView } from '../../models/fulfillment-obligation.js';
export const FINANCIAL_COMMITMENT_REPOSITORY = Symbol(
    'FINANCIAL_COMMITMENT_REPOSITORY',
);
export interface FinancialCommitmentRepository {
    save(commitment: FinancialCommitment<ExpenseVersion>): Promise<void>;
    find(
        spaceId: string,
        commitmentId: string,
        lock?: boolean,
    ): Promise<FinancialCommitment<ExpenseVersion> | null>;
    saveDisbursement(
        commitment: FinancialCommitment<ExpenseVersion>,
        expectedVersion: number,
    ): Promise<void>;
    detail(
        spaceId: string,
        commitmentId: string,
    ): Promise<SharedCashExpenseView | null>;
}
export const INTER_MEMBER_OBLIGATION_REPOSITORY = Symbol(
    'INTER_MEMBER_OBLIGATION_REPOSITORY',
);
export interface InterMemberObligationRepository {
    save(obligation: InterMemberObligation): Promise<void>;
    lockOrigin(
        spaceId: string,
        commitmentId: string,
    ): Promise<{
        obligations: InterMemberObligation[];
        settlements: OriginSettlement[];
    }>;
    originState(
        spaceId: string,
        commitmentId: string,
    ): Promise<{
        obligations: InterMemberObligation[];
        settlements: OriginSettlement[];
    }>;
    saveReconciliation(
        before: InterMemberObligation,
        after: InterMemberObligation,
    ): Promise<void>;
    history(
        spaceId: string,
        commitmentId: string,
    ): Promise<FulfillmentObligationView[]>;
}
export const SETTLEMENT_CYCLE_REPOSITORY = Symbol(
    'SETTLEMENT_CYCLE_REPOSITORY',
);
export interface SettlementCycleRepository {
    lockExisting(
        spaceId: string,
        cycleId: string,
    ): Promise<SettlementCycle | null>;
    lockForDate(spaceId: string, targetDate: string): Promise<SettlementCycle>;
    listOpen(
        spaceId: string,
        after: { targetDate: string; id: string } | null,
    ): Promise<SettlementCycle[]>;
}
export const EXPENSE_COMMAND_RECEIPTS = Symbol('EXPENSE_COMMAND_RECEIPTS');
export class ExpenseReceiptRaceError extends Error {}
export interface ExpenseCommandReceipts {
    find(
        command: RecordSharedCashExpenseCommand,
    ): Promise<SharedCashExpenseResult | null>;
    save(
        command: RecordSharedCashExpenseCommand,
        result: SharedCashExpenseResult,
        registeredAt: string,
    ): Promise<void>;
}
export const FINANCES_CLOCK = Symbol('FINANCES_CLOCK');
export interface FinancesClock {
    now(): Date;
    today(): string;
}
