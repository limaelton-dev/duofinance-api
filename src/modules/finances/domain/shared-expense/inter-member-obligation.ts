import { Money } from './money.js';
import { civilDate } from './settlement-cycle.js';
import { invalidExpense } from './validation.js';
export class InterMemberObligation {
    readonly status = 'OPEN';
    readonly version = 1;
    readonly remainingAmountInCents: number;
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
    ) {
        if (
            debtorMemberId === creditorMemberId ||
            Money.from(originalAmountInCents).amountInCents === 0
        )
            invalidExpense();
        civilDate(factDate);
        this.remainingAmountInCents = originalAmountInCents;
        this.history = Object.freeze({
            type: 'CREATED',
            version: 1,
            actorId,
            registeredAt,
        });
        Object.freeze(this);
    }
}
