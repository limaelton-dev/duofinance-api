import { FinancesError } from '../errors/finances.error.js';
import { civilDate } from '../shared-expense/settlement-cycle.js';

export interface SettlementOffsetAllocation {
    id: string;
    obligationId: string;
    cycleId: string | null;
    debtorMemberId: string;
    creditorMemberId: string;
    amountInCents: number;
}

export class SettlementOffset {
    readonly amountInCents: number;
    readonly allocations: readonly Readonly<SettlementOffsetAllocation>[];

    constructor(
        readonly id: string,
        readonly spaceId: string,
        readonly factDate: string,
        readonly registeredAt: string,
        readonly createdByPersonId: string,
        allocations: SettlementOffsetAllocation[],
    ) {
        civilDate(factDate);
        if (!Number.isFinite(Date.parse(registeredAt)))
            throw new FinancesError('VALIDATION_ERROR', ['registeredAt']);
        if (
            allocations.length < 2 ||
            new Set(allocations.map((a) => a.id)).size !== allocations.length ||
            new Set(allocations.map((a) => a.obligationId)).size !==
                allocations.length
        )
            throw new FinancesError('VALIDATION_ERROR', ['allocations']);
        const first = allocations[0];
        const [debtor, creditor] = [
            first.debtorMemberId,
            first.creditorMemberId,
        ];
        let forward = 0n;
        let backward = 0n;
        for (const allocation of allocations) {
            if (
                debtor === creditor ||
                !Number.isSafeInteger(allocation.amountInCents) ||
                allocation.amountInCents <= 0
            )
                throw new FinancesError('VALIDATION_ERROR', ['allocations']);
            if (
                allocation.debtorMemberId === debtor &&
                allocation.creditorMemberId === creditor
            )
                forward += BigInt(allocation.amountInCents);
            else if (
                allocation.debtorMemberId === creditor &&
                allocation.creditorMemberId === debtor
            )
                backward += BigInt(allocation.amountInCents);
            else throw new FinancesError('VALIDATION_ERROR', ['allocations']);
        }
        if (forward !== backward || forward > BigInt(Number.MAX_SAFE_INTEGER))
            throw new FinancesError('VALIDATION_ERROR', ['allocations']);
        this.amountInCents = Number(forward);
        this.allocations = Object.freeze(
            allocations.map((a) => Object.freeze({ ...a })),
        );
        Object.freeze(this);
    }
}
