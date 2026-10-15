import type { IncomeCommitment } from '../../../domain/income/income-commitment.js';
import type {
    IncomeResult,
    IncomeSummary,
    IncomeView,
    RecordIncomeCommand,
    RecordIncomeReceiptCommand,
} from '../../models/income.js';

export const INCOME_REPOSITORY = Symbol('INCOME_REPOSITORY');
export interface IncomeRepository {
    save(income: IncomeCommitment): Promise<void>;
    find(
        spaceId: string,
        commitmentId: string,
        lock?: boolean,
    ): Promise<IncomeCommitment | null>;
    saveReceipt(
        income: IncomeCommitment,
        expectedVersion: number,
    ): Promise<void>;
    detail(spaceId: string, commitmentId: string): Promise<IncomeView | null>;
    list(
        spaceId: string,
        status: 'ALL' | 'PENDING' | 'RECEIVED',
        after: { registeredAt: string; id: string } | null,
    ): Promise<IncomeSummary[]>;
    upcoming(
        spaceId: string,
        referenceDate: string,
    ): Promise<{ items: IncomeSummary[]; totalCount: number }>;
}

export const INCOME_COMMAND_RECEIPTS = Symbol('INCOME_COMMAND_RECEIPTS');
export class IncomeReceiptRaceError extends Error {}
export type IncomeCommand = RecordIncomeCommand | RecordIncomeReceiptCommand;
export interface IncomeCommandReceipts {
    find(command: IncomeCommand): Promise<IncomeResult | null>;
    save(
        command: IncomeCommand,
        result: IncomeResult,
        registeredAt: string,
    ): Promise<void>;
}
