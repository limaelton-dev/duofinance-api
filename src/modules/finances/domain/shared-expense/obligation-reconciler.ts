import { Money } from './money.js';
import { ResponsibilitySplit } from './responsibility-split.js';
import { invalidExpense } from './validation.js';
export type InitialDifference = {
    debtorMemberId: string;
    creditorMemberId: string;
    amountInCents: number;
};
export interface OriginSettlement {
    payerMemberId: string;
    recipientMemberId: string;
    amountInCents: number;
}
export function expenseDifference(
    split: ResponsibilitySplit,
    payments: readonly { payerMemberId: string; amountInCents: number }[],
    settlements: readonly OriginSettlement[] = [],
): InitialDifference | null {
    for (const share of split.shares) {
        let excess =
            payments.reduce(
                (sum, fact) =>
                    sum +
                    (fact.payerMemberId === share.memberId
                        ? BigInt(fact.amountInCents)
                        : 0n),
                0n,
            ) - BigInt(share.amountInCents);
        for (const settlement of settlements)
            excess +=
                settlement.payerMemberId === share.memberId
                    ? BigInt(settlement.amountInCents)
                    : settlement.recipientMemberId === share.memberId
                      ? -BigInt(settlement.amountInCents)
                      : 0n;
        if (excess > 0n) {
            const debtor = split.shares.find(
                (other) => other.memberId !== share.memberId,
            );
            if (!debtor) return null;
            const amountInCents = Money.from(Number(excess)).amountInCents;
            return {
                debtorMemberId: debtor.memberId,
                creditorMemberId: share.memberId,
                amountInCents,
            };
        }
    }
    return null;
}
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
