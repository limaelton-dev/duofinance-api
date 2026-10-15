import { FinancesError } from '../errors/finances.error.js';
import { Money } from './money.js';
import { civilDate } from './settlement-cycle.js';
import { invalidExpense } from './validation.js';
export type ObligationStatus =
    'OPEN' | 'PARTIALLY_SETTLED' | 'SETTLED' | 'RECONCILED';
export interface ObligationReconciliation {
    type: 'RECONCILED';
    actorId: string;
    causeFulfillmentId: string;
    registeredAt: string;
    previousRecognizedAmountInCents: number;
    recognizedAmountInCents: number;
    previousRemainingAmountInCents: number;
    remainingAmountInCents: number;
}
export class InterMemberObligation {
    readonly status: ObligationStatus;
    readonly version: number;
    readonly remainingAmountInCents: number;
    readonly appliedAllocationIds: readonly string[];
    readonly reconciliation: Readonly<ObligationReconciliation> | null;
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
        readonly recognizedAmountInCents = originalAmountInCents,
        readonly reconciled = false,
        reconciliation: ObligationReconciliation | null = null,
        readonly originExternalLiabilityId: string | null = null,
    ) {
        if (
            debtorMemberId === creditorMemberId ||
            Money.from(originalAmountInCents).amountInCents === 0 ||
            !Number.isSafeInteger(remainingAmountInCents) ||
            remainingAmountInCents < 0 ||
            remainingAmountInCents >
                Money.from(recognizedAmountInCents).amountInCents ||
            !Number.isSafeInteger(version) ||
            version < 1
        )
            invalidExpense();
        civilDate(factDate);
        this.remainingAmountInCents = remainingAmountInCents;
        this.version = version;
        this.appliedAllocationIds = Object.freeze([...appliedAllocationIds]);
        this.reconciliation = reconciliation
            ? Object.freeze({ ...reconciliation })
            : null;
        this.status =
            remainingAmountInCents === 0
                ? reconciled
                    ? 'RECONCILED'
                    : 'SETTLED'
                : remainingAmountInCents === recognizedAmountInCents
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
            this.recognizedAmountInCents,
            this.reconciled,
            null,
            this.originExternalLiabilityId,
        );
    }
    reconcile(
        remainingAmountInCents: number,
        actorId: string,
        causeFulfillmentId: string,
        registeredAt: string,
    ): InterMemberObligation {
        Money.from(remainingAmountInCents);
        const settled =
            this.recognizedAmountInCents - this.remainingAmountInCents;
        const recognized = Money.from(settled).add(
            Money.from(remainingAmountInCents),
        ).amountInCents;
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
            remainingAmountInCents,
            this.version + 1,
            this.appliedAllocationIds,
            this.originKind,
            recognized,
            remainingAmountInCents === 0,
            {
                type: 'RECONCILED',
                actorId,
                causeFulfillmentId,
                registeredAt,
                previousRecognizedAmountInCents: this.recognizedAmountInCents,
                recognizedAmountInCents: recognized,
                previousRemainingAmountInCents: this.remainingAmountInCents,
                remainingAmountInCents,
            },
            this.originExternalLiabilityId,
        );
    }
}
