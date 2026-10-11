import type { SettlementCycleTotals } from '../models/settlement-cycle.js';
export function settlementCycleTotals(
    original: string,
    remaining: string,
): SettlementCycleTotals {
    return {
        originalAmountInCents: original,
        resolvedAmountInCents: (
            BigInt(original) - BigInt(remaining)
        ).toString(),
        remainingAmountInCents: remaining,
    };
}
