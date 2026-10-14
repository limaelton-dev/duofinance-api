import { FinancesError } from '../errors/finances.error.js';
import { Money } from './money.js';
import { civilDate } from './settlement-cycle.js';
import { invalidExpense } from './validation.js';
export type ObligationStatus = 'OPEN' | 'PARTIALLY_SETTLED' | 'SETTLED';
export class InterMemberObligation {
    readonly status: ObligationStatus;
    readonly version: number;
    readonly remainingAmountInCents: number;
    readonly appliedAllocationIds: readonly string[];
    readonly history: Readonly<{
        type: 'CREATED';
        version: 1;
        actorId: string;
        registeredAt: string;
    }>;
    constructor(
        readonly id: string,
        readonly spaceId: string,
        readonly originCommitmentId: string,
        readonly originDisbursementId: string,
        readonly debtorMemberId: string,
        readonly creditorMemberId: string,
        readonly originalAmountInCents: number,
        readonly cycleId: string | null,
        readonly factDate: string,
        readonly registeredAt: string,
        actorId: string,
        remainingAmountInCents = originalAmountInCents,
        version = 1,
        appliedAllocationIds: readonly string[] = [],
        readonly originKind: 'EXPENSE' | 'INCOME' = 'EXPENSE',
    ) {
        if (
            debtorMemberId === creditorMemberId ||
            Money.from(originalAmountInCents).amountInCents === 0 ||
            !Number.isSafeInteger(remainingAmountInCents) ||
            remainingAmountInCents < 0 ||
            remainingAmountInCents > originalAmountInCents ||
            !Number.isSafeInteger(version) ||
            version < 1
        )
            invalidExpense();
        civilDate(factDate);
        this.remainingAmountInCents = remainingAmountInCents;
        this.version = version;
        this.appliedAllocationIds = Object.freeze([...appliedAllocationIds]);
        this.status =
            remainingAmountInCents === 0
                ? 'SETTLED'
                : remainingAmountInCents === originalAmountInCents
                  ? 'OPEN'
                  : 'PARTIALLY_SETTLED';
        this.history = Object.freeze({
            type: 'CREATED',
            version: 1,
            actorId,
            registeredAt,
        });
        Object.freeze(this);
    }
    applySettlement(
        allocationId: string,
        amountInCents: number,
        expectedVersion: number,
    ): InterMemberObligation {
        if (!Number.isSafeInteger(amountInCents) || amountInCents <= 0)
            throw new FinancesError('VALIDATION_ERROR', ['allocations']);
        if (this.appliedAllocationIds.includes(allocationId))
            throw new FinancesError('CONCURRENT_MODIFICATION');
        if (
            this.version !== expectedVersion ||
            amountInCents > this.remainingAmountInCents
        )
            throw new FinancesError('CONCURRENT_MODIFICATION');
        return new InterMemberObligation(
            this.id,
            this.spaceId,
            this.originCommitmentId,
            this.originDisbursementId,
            this.debtorMemberId,
            this.creditorMemberId,
            this.originalAmountInCents,
            this.cycleId,
            this.factDate,
            this.registeredAt,
            this.history.actorId,
            this.remainingAmountInCents - amountInCents,
            this.version + 1,
            [...this.appliedAllocationIds, allocationId],
            this.originKind,
        );
    }
}
