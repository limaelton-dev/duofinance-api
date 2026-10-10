import { Money } from './money.js';
import { invalidExpense } from './validation.js';
export type SplitInput =
    | { mode: 'AMOUNTS'; shares: { memberId: string; amountInCents: number }[] }
    | {
          mode: 'PERCENTAGES';
          shares: { memberId: string; basisPoints: number }[];
      };
export class EconomicShare {
    constructor(
        readonly memberId: string,
        readonly amountInCents: number,
    ) {
        Money.from(amountInCents);
        Object.freeze(this);
    }
}
export class ResponsibilitySplit {
    private constructor(
        readonly total: Money,
        readonly original: SplitInput,
        readonly shares: readonly EconomicShare[],
    ) {
        Object.freeze(this);
    }
    static create(
        total: number,
        members: readonly string[],
        input: SplitInput,
    ): ResponsibilitySplit {
        const money = Money.from(total);
        if (
            total === 0 ||
            members.length < 1 ||
            members.length > 2 ||
            new Set(members).size !== members.length ||
            input.shares.length !== members.length
        )
            invalidExpense();
        const normalized = input.shares
            .map((share) => ({
                ...share,
                memberId: share.memberId.toLowerCase(),
            }))
            .sort((x, y) => x.memberId.localeCompare(y.memberId));
        if (
            new Set(normalized.map((s) => s.memberId)).size !==
                members.length ||
            normalized.some((s) => !members.includes(s.memberId))
        )
            invalidExpense();
        let shares: EconomicShare[];
        if (input.mode === 'AMOUNTS') {
            const values = normalized as {
                memberId: string;
                amountInCents: number;
            }[];
            if (
                values.reduce(
                    (sum, s) => sum.add(Money.from(s.amountInCents)),
                    Money.from(0),
                ).amountInCents !== total
            )
                invalidExpense();
            shares = values.map(
                (s) => new EconomicShare(s.memberId, s.amountInCents),
            );
        } else if (input.mode === 'PERCENTAGES') {
            const values = normalized as {
                memberId: string;
                basisPoints: number;
            }[];
            if (
                values.some(
                    (s) =>
                        !Number.isInteger(s.basisPoints) ||
                        s.basisPoints < 0 ||
                        s.basisPoints > 10000,
                ) ||
                values.reduce((sum, s) => sum + s.basisPoints, 0) !== 10000
            )
                invalidExpense();
            const calculated = values.map((s) => ({
                memberId: s.memberId,
                quotient: (BigInt(total) * BigInt(s.basisPoints)) / 10000n,
                remainder: (BigInt(total) * BigInt(s.basisPoints)) % 10000n,
            }));
            let residual =
                BigInt(total) -
                calculated.reduce((sum, s) => sum + s.quotient, 0n);
            for (const s of [...calculated].sort((x, y) =>
                x.remainder === y.remainder
                    ? x.memberId.localeCompare(y.memberId)
                    : x.remainder > y.remainder
                      ? -1
                      : 1,
            )) {
                if (residual > 0n) {
                    s.quotient++;
                    residual--;
                }
            }
            shares = calculated.map(
                (s) => new EconomicShare(s.memberId, Number(s.quotient)),
            );
        } else invalidExpense();
        const original = Object.freeze({
            mode: input.mode,
            shares: Object.freeze(normalized.map((s) => Object.freeze(s))),
        }) as unknown as SplitInput;
        return new ResponsibilitySplit(money, original, Object.freeze(shares));
    }
}
