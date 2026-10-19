import { FinancesError } from '../errors/finances.error.js';
import type { InterMemberObligation } from '../shared-expense/inter-member-obligation.js';
import type { InitialDifference } from '../shared-expense/obligation-reconciler.js';
import { civilDate } from '../shared-expense/settlement-cycle.js';

export interface ReversalAllocation {
    id: string;
    originalAllocationId: string;
    obligationId: string;
    debtorMemberId: string;
    creditorMemberId: string;
    amountInCents: number;
    originalCycleId: string | null;
    correctionCycleId: string | null;
}

export type SettlementReversalSource = Pick<
    InterMemberObligation,
    'originCommitmentId' | 'occurrenceId' | 'originClosureAgreementId'
>;

export function settlementReversalSourceKey(source: SettlementReversalSource) {
    return JSON.stringify([
        source.originCommitmentId,
        source.occurrenceId,
        source.originClosureAgreementId,
    ]);
}

export class SettlementReversal {
    readonly amountInCents: number;
    readonly allocations: readonly Readonly<ReversalAllocation>[];
    constructor(
        readonly id: string,
        readonly spaceId: string,
        readonly originalKind: 'TRANSFER' | 'OFFSET',
        readonly originalId: string,
        readonly factDate: string,
        readonly registeredAt: string,
        readonly createdByPersonId: string,
        allocations: ReversalAllocation[],
    ) {
        civilDate(factDate);
        if (!Number.isFinite(Date.parse(registeredAt)))
            throw new FinancesError('VALIDATION_ERROR', ['registeredAt']);
        if (
            !['TRANSFER', 'OFFSET'].includes(originalKind) ||
            allocations.length < (originalKind === 'OFFSET' ? 2 : 1) ||
            new Set(allocations.map((a) => a.id)).size !== allocations.length ||
            new Set(allocations.map((a) => a.originalAllocationId)).size !==
                allocations.length
        )
            throw new FinancesError('VALIDATION_ERROR', ['applications']);
        const first = allocations[0];
        let forward = 0n,
            backward = 0n;
        for (const a of allocations) {
            if (
                !Number.isSafeInteger(a.amountInCents) ||
                a.amountInCents <= 0 ||
                a.debtorMemberId === a.creditorMemberId
            )
                throw new FinancesError('VALIDATION_ERROR', ['applications']);
            if (
                a.debtorMemberId === first.debtorMemberId &&
                a.creditorMemberId === first.creditorMemberId
            )
                forward += BigInt(a.amountInCents);
            else if (
                a.debtorMemberId === first.creditorMemberId &&
                a.creditorMemberId === first.debtorMemberId
            )
                backward += BigInt(a.amountInCents);
            else throw new FinancesError('VALIDATION_ERROR', ['applications']);
        }
        if (
            (originalKind === 'TRANSFER'
                ? backward !== 0n
                : forward !== backward) ||
            forward > BigInt(Number.MAX_SAFE_INTEGER)
        )
            throw new FinancesError('VALIDATION_ERROR', ['applications']);
        this.amountInCents = Number(forward);
        this.allocations = Object.freeze(
            allocations.map((a) => Object.freeze({ ...a })),
        );
        Object.freeze(this);
    }
}

export function planSettlementReversal<
    T extends Pick<
        InterMemberObligation,
        | 'id'
        | 'spaceId'
        | 'originCommitmentId'
        | 'occurrenceId'
        | 'originClosureAgreementId'
        | 'cycleId'
        | 'debtorMemberId'
        | 'creditorMemberId'
        | 'remainingAmountInCents'
    >,
>(
    obligations: readonly T[],
    applications: readonly Pick<
        ReversalAllocation,
        'obligationId' | 'debtorMemberId' | 'creditorMemberId' | 'amountInCents'
    >[],
    finalizedCycleIds: readonly string[],
) {
    if (!applications.length)
        throw new FinancesError('VALIDATION_ERROR', ['applications']);
    const first = obligations[0];
    const [debtor, creditor] = [
        applications[0].debtorMemberId,
        applications[0].creditorMemberId,
    ];
    if (
        !first ||
        debtor === creditor ||
        obligations.some(
            (o) =>
                o.spaceId !== first.spaceId ||
                settlementReversalSourceKey(o) !==
                    settlementReversalSourceKey(first),
        )
    )
        throw new FinancesError('VALIDATION_ERROR', ['applications']);
    const signed = (debtorId: string, creditorId: string, amount: number) => {
        if (!Number.isSafeInteger(amount) || amount < 0)
            throw new FinancesError('VALIDATION_ERROR', ['applications']);
        if (debtorId === debtor && creditorId === creditor)
            return BigInt(amount);
        if (debtorId === creditor && creditorId === debtor)
            return -BigInt(amount);
        throw new FinancesError('VALIDATION_ERROR', ['applications']);
    };
    let net = obligations.reduce(
        (sum, o) =>
            sum +
            signed(
                o.debtorMemberId,
                o.creditorMemberId,
                o.remainingAmountInCents,
            ),
        0n,
    );
    for (const a of applications) {
        const original = obligations.find((o) => o.id === a.obligationId);
        if (
            !original ||
            a.amountInCents <= 0 ||
            original.debtorMemberId !== a.debtorMemberId ||
            original.creditorMemberId !== a.creditorMemberId
        )
            throw new FinancesError('VALIDATION_ERROR', ['applications']);
        net += signed(a.debtorMemberId, a.creditorMemberId, a.amountInCents);
    }
    if (
        net > BigInt(Number.MAX_SAFE_INTEGER) ||
        net < -BigInt(Number.MAX_SAFE_INTEGER)
    )
        throw new FinancesError('VALIDATION_ERROR', ['applications']);
    const difference: InitialDifference | null =
        net === 0n
            ? null
            : {
                  debtorMemberId: net > 0n ? debtor : creditor,
                  creditorMemberId: net > 0n ? creditor : debtor,
                  amountInCents: Number(net > 0n ? net : -net),
              };
    const writable = obligations.filter(
        (o) => !o.cycleId || !finalizedCycleIds.includes(o.cycleId),
    );
    const matching = writable.filter(
        (o) =>
            difference &&
            o.debtorMemberId === difference.debtorMemberId &&
            o.creditorMemberId === difference.creditorMemberId,
    );
    const reusedObligation =
        matching.find((o) => o.remainingAmountInCents > 0) ??
        matching.find((o) =>
            applications.some((a) => a.obligationId === o.id),
        ) ??
        null;
    const changes = writable.flatMap((obligation) => {
        const remainingAmountInCents =
            obligation === reusedObligation ? difference!.amountInCents : 0;
        const reversedAmountInCents = applications
            .filter((a) => a.obligationId === obligation.id)
            .reduce((sum, a) => sum + a.amountInCents, 0);
        return remainingAmountInCents === obligation.remainingAmountInCents &&
            reversedAmountInCents === 0
            ? []
            : [{ obligation, remainingAmountInCents, reversedAmountInCents }];
    });
    return {
        reusedObligation,
        changes,
        newDifference: reusedObligation ? null : difference,
    };
}
