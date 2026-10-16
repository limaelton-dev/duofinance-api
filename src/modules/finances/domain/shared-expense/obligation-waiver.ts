import { FinancesError } from '../errors/finances.error.js';
import { civilDate } from './settlement-cycle.js';

export class ObligationWaiver {
    readonly reason: string | null;
    constructor(
        readonly id: string,
        readonly obligationId: string,
        readonly creditorMemberId: string,
        readonly amountInCents: number,
        readonly factDate: string,
        readonly registeredAt: string,
        readonly createdByPersonId: string,
        reason: string | null = null,
    ) {
        if (!Number.isSafeInteger(amountInCents) || amountInCents <= 0)
            throw new FinancesError('VALIDATION_ERROR', ['amountInCents']);
        civilDate(factDate);
        if (!Number.isFinite(Date.parse(registeredAt)))
            throw new FinancesError('VALIDATION_ERROR', ['registeredAt']);
        if (
            reason !== null &&
            (typeof reason !== 'string' || reason.trim().length > 500)
        )
            throw new FinancesError('VALIDATION_ERROR', ['reason']);
        this.reason = reason?.trim() || null;
        Object.freeze(this);
    }
}
