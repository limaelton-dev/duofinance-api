import { FinancesError } from '../errors/finances.error.js';
import { civilDate } from '../shared-expense/settlement-cycle.js';

export interface SettlementAllocation {
    id: string;
    obligationId: string;
    cycleId: string | null;
    amountInCents: number;
}
export class SettlementTransfer {
    readonly mode = 'MANUAL';
    readonly allocations: readonly SettlementAllocation[];
    constructor(
        readonly id: string,
        readonly spaceId: string,
        readonly payerMemberId: string,
        readonly recipientMemberId: string,
        readonly amountInCents: number,
        readonly factDate: string,
        readonly registeredAt: string,
        readonly createdByPersonId: string,
        allocations: SettlementAllocation[],
    ) {
        if (payerMemberId === recipientMemberId)
            throw new FinancesError('VALIDATION_ERROR', ['recipientMemberId']);
        if (!Number.isSafeInteger(amountInCents) || amountInCents <= 0)
            throw new FinancesError('VALIDATION_ERROR', ['amountInCents']);
        civilDate(factDate);
        if (
            !allocations.length ||
            new Set(allocations.map((a) => a.obligationId)).size !==
                allocations.length ||
            allocations.some(
                (a) =>
                    !Number.isSafeInteger(a.amountInCents) ||
                    a.amountInCents <= 0,
            )
        )
            throw new FinancesError('VALIDATION_ERROR', ['allocations']);
        if (
            allocations.reduce(
                (sum, a) => sum + BigInt(a.amountInCents),
                0n,
            ) !== BigInt(amountInCents)
        )
            throw new FinancesError('VALIDATION_ERROR', ['allocations']);
        this.allocations = Object.freeze(
            allocations.map((a) => Object.freeze({ ...a })),
        );
        Object.freeze(this);
    }
}
