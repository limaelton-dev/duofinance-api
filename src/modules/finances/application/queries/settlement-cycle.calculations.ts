import type { SettlementCycleTotals } from '../models/settlement-cycle.js';
export function settlementCycleTotals(
    original: string,
    remaining: string,
    transferred = '0',
    recognized = original,
    compensated = '0',
    waived = '0',
): SettlementCycleTotals {
    return {
        originalAmountInCents: original,
        recognizedAmountInCents: recognized,
        resolvedAmountInCents: (
            BigInt(recognized) - BigInt(remaining)
        ).toString(),
        remainingAmountInCents: remaining,
        transferredAmountInCents: transferred,
        compensatedAmountInCents: compensated,
        waivedAmountInCents: waived,
    };
}
