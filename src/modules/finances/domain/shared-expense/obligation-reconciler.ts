import { Money } from './money.js';
import { ResponsibilitySplit } from './responsibility-split.js';
import { invalidExpense } from './validation.js';
export type InitialDifference = {
    debtorMemberId: string;
    creditorMemberId: string;
    amountInCents: number;
};
export function reconcileInitialObligation(
    split: ResponsibilitySplit,
    payerMemberId: string,
): InitialDifference | null {
    const payer = split.shares.find((s) => s.memberId === payerMemberId);
    if (!payer) invalidExpense();
    const excess = split.total.subtract(
        Money.from(payer.amountInCents),
    ).amountInCents;
    if (excess === 0) return null;
    const debtor = split.shares.find((s) => s.memberId !== payerMemberId);
    if (!debtor || debtor.amountInCents !== excess) invalidExpense();
    return {
        debtorMemberId: debtor.memberId,
        creditorMemberId: payerMemberId,
        amountInCents: excess,
    };
}
