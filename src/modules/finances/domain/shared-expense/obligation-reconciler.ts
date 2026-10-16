import { Money } from './money.js';
import { ResponsibilitySplit } from './responsibility-split.js';
import { invalidExpense } from './validation.js';
import type { InterMemberObligation } from './inter-member-obligation.js';
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
export interface ObligationReconciliationPlan {
    reusedObligation: InterMemberObligation | null;
    changes: {
        obligation: InterMemberObligation;
        remainingAmountInCents: number;
    }[];
    newDifference: InitialDifference | null;
}
export function planObligationReconciliation(
    chronologicalObligations: readonly InterMemberObligation[],
    difference: InitialDifference | null,
    finalizedCycleIds: readonly string[] = [],
): ObligationReconciliationPlan {
    const first = chronologicalObligations[0];
    const open = chronologicalObligations.filter(
        (o) => o.remainingAmountInCents > 0,
    );
    if (
        open.length > 1 ||
        chronologicalObligations.some(
            (o) =>
                o.spaceId !== first.spaceId ||
                o.originCommitmentId !== first.originCommitmentId,
        )
    )
        invalidExpense();
    const latest = chronologicalObligations.at(-1);
    const matches = (o: InterMemberObligation) =>
        difference !== null &&
        o.debtorMemberId === difference.debtorMemberId &&
        o.creditorMemberId === difference.creditorMemberId;
    const reusedObligation = difference
        ? (open.find(matches) ??
          (latest?.status === 'SETTLED' &&
          matches(latest) &&
          (!latest.cycleId || !finalizedCycleIds.includes(latest.cycleId))
              ? latest
              : null))
        : null;
    const changes = chronologicalObligations.flatMap((obligation) => {
        if (
            obligation.remainingAmountInCents === 0 &&
            obligation !== reusedObligation
        )
            return [];
        const remainingAmountInCents =
            obligation === reusedObligation ? difference!.amountInCents : 0;
        return remainingAmountInCents === obligation.remainingAmountInCents
            ? []
            : [{ obligation, remainingAmountInCents }];
    });
    return {
        reusedObligation,
        changes,
        newDifference: reusedObligation ? null : difference,
    };
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
