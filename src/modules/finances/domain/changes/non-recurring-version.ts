import { FinancesError } from '../errors/finances.error.js';
import {
    ResponsibilitySplit,
    type EconomicShare,
    type SplitInput,
} from '../shared-expense/responsibility-split.js';

export interface NonRecurringEconomicVersion {
    id: string;
    spaceId: string;
    commitmentId: string;
    targetId: string;
    installmentId: string | null;
    version: number;
    effectiveFrom: string;
    description: string;
    amountInCents: number;
    distribution: SplitInput | null;
    economicShares: readonly EconomicShare[] | null;
    expectedMemberId: string | null;
    actorId: string;
    registeredAt: string;
}

export interface NonRecurringChangeTarget {
    id: string;
    dueDate: string | null;
    originalAmountInCents: number;
    amountInCents: number;
    economicShares: readonly EconomicShare[] | null;
    originalEconomicShares?: readonly EconomicShare[] | null;
    economicVersion?: number;
    fulfilledAmountInCents: number;
    stateVersion: number;
    resolved: boolean;
}

export function assessNonRecurringChange(
    kind: 'EXPENSE' | 'INCOME',
    targets: readonly NonRecurringChangeTarget[],
    totalAmountInCents: number,
    memberIds: readonly string[] | null,
    distribution: SplitInput | null,
    actorMemberId: string | null,
) {
    const originalTotal = targets.reduce(
        (sum, target) => sum + BigInt(target.amountInCents),
        0n,
    );
    if (
        originalTotal < 1n ||
        !Number.isSafeInteger(totalAmountInCents) ||
        totalAmountInCents < targets.length
    )
        throw new FinancesError('VALIDATION_ERROR', ['amountInCents']);
    const amounts: number[] = [];
    let before = 0n;
    for (const target of targets) {
        const after = before + BigInt(target.amountInCents);
        amounts.push(
            Number(
                (BigInt(totalAmountInCents) * after) / originalTotal -
                    (BigInt(totalAmountInCents) * before) / originalTotal,
            ),
        );
        before = after;
    }
    if (amounts.some((amount) => amount < 1))
        throw new FinancesError('VALIDATION_ERROR', ['amountInCents']);
    const split =
        memberIds && distribution
            ? ResponsibilitySplit.create(
                  totalAmountInCents,
                  [...memberIds],
                  distribution,
              )
            : null;
    let cumulative = 0;
    const proposedTargets = targets.map((target, index) => {
        const prior = split?.realizedShares(cumulative);
        cumulative += amounts[index]!;
        const economicShares =
            split?.realizedShares(cumulative).map((share, shareIndex) => ({
                memberId: share.memberId,
                amountInCents:
                    share.amountInCents - prior![shareIndex]!.amountInCents,
            })) ?? null;
        return {
            targetId: target.id,
            amountInCents: amounts[index]!,
            economicShares,
        };
    });
    const impactByMember = (memberIds ?? []).map((memberId) => {
        const current = targets.reduce(
            (sum, target) =>
                sum +
                BigInt(
                    target.economicShares?.find(
                        (share) => share.memberId === memberId,
                    )?.amountInCents ?? 0,
                ),
            0n,
        );
        const proposed = proposedTargets.reduce(
            (sum, target) =>
                sum +
                BigInt(
                    target.economicShares?.find(
                        (share) => share.memberId === memberId,
                    )?.amountInCents ?? 0,
                ),
            0n,
        );
        const increasesInTarget = targets.some((target, index) => {
            const a =
                target.economicShares?.find(
                    (share) => share.memberId === memberId,
                )?.amountInCents ?? 0;
            const b =
                proposedTargets[index]!.economicShares?.find(
                    (share) => share.memberId === memberId,
                )?.amountInCents ?? 0;
            const ratioDelta =
                BigInt(b) * BigInt(target.amountInCents) -
                BigInt(a) * BigInt(proposedTargets[index]!.amountInCents);
            return kind === 'EXPENSE'
                ? b > a || ratioDelta > 0n
                : b < a || ratioDelta < 0n;
        });
        return {
            memberId,
            currentAmountInCents: current.toString(),
            proposedAmountInCents: proposed.toString(),
            deltaInCents: (proposed - current).toString(),
            requiresAcceptance: memberId !== actorMemberId && increasesInTarget,
        };
    });
    return {
        proposedTargets,
        impactByMember,
        requiresAcceptance: impactByMember.some(
            (row) => row.requiresAcceptance,
        ),
    };
}
