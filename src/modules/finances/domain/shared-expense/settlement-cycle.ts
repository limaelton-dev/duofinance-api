import { FinancesError } from '../errors/finances.error.js';
import { invalidExpense } from './validation.js';
export function civilDate(value: string): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        invalidExpense();
    const [year, month, day] = value.split('-').map(Number);
    if (year < 1 || month < 1 || month > 12) invalidExpense();
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const lastDay = [
        31,
        leap ? 29 : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ][month - 1];
    if (day < 1 || day > lastDay) invalidExpense();
    return value;
}
export class SettlementCycle {
    constructor(
        readonly id: string,
        readonly spaceId: string,
        readonly targetDate: string,
        readonly status: 'OPEN' | 'FINALIZED',
        readonly version: number,
        readonly finalizedAt: string | null = null,
    ) {
        civilDate(targetDate);
        if (!Number.isSafeInteger(version) || version < 1) invalidExpense();
        Object.freeze(this);
    }
    assertOpen(): void {
        if (this.status !== 'OPEN')
            throw new FinancesError('SETTLEMENT_CYCLE_FINALIZED');
    }
    finalize(
        hasOpenObligations: boolean,
        expectedVersion: number,
        finalizedAt: string,
    ): SettlementCycle {
        this.assertOpen();
        if (this.version !== expectedVersion)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        if (hasOpenObligations)
            throw new FinancesError('SETTLEMENT_CYCLE_HAS_OPEN_OBLIGATIONS');
        if (!Number.isFinite(Date.parse(finalizedAt)))
            throw new FinancesError('VALIDATION_ERROR', ['finalizedAt']);
        return new SettlementCycle(
            this.id,
            this.spaceId,
            this.targetDate,
            'FINALIZED',
            this.version + 1,
            finalizedAt,
        );
    }
}
