import { FinancesError } from '../errors/finances.error.js';
import { SettlementRule } from '../settlement-rule/settlement-rule.js';
import { invalidExpense } from './validation.js';
export function civilDate(value: string): string {
    SettlementRule.from({
        kind: 'MONTHLY_DAY',
        dayOfMonth: 1,
    }).suggestTargetDate(value);
    return value;
}
export class SettlementCycle {
    constructor(
        readonly id: string,
        readonly spaceId: string,
        readonly targetDate: string,
        readonly status: 'OPEN' | 'FINALIZED',
        readonly version: number,
    ) {
        civilDate(targetDate);
        if (!Number.isSafeInteger(version) || version < 1) invalidExpense();
        Object.freeze(this);
    }
    assertOpen(): void {
        if (this.status !== 'OPEN')
            throw new FinancesError('SETTLEMENT_CYCLE_FINALIZED');
    }
}
