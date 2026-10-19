export const FINANCIAL_CLOSURE_DESTINATIONS_PORT = Symbol(
    'FINANCIAL_CLOSURE_DESTINATIONS_PORT',
);

export type FinancialClosureDestinationInput = {
    originType: 'RECURRING' | 'INSTALLMENT';
    originId: string;
    expectedOriginVersion: number;
    destination: 'TERMINATE' | 'PERSONAL_SUCCESSOR' | 'SETTLE_BEFORE_CLOSURE';
    assigneeMemberId?: string | null;
    amountInCents?: number | null;
};

export type FinancialClosureFutureItem = {
    originItemId: string | null;
    referenceDate: string;
    remainingInCents: number | null;
    version: number | null;
};

export type FinancialClosureRecurringImpact = {
    basis: 'PER_OCCURRENCE';
    economicVersion: number;
    effectiveFrom: string;
    valueMode: 'FIXED' | 'VARIABLE';
    amountInCents: number | null;
    distribution:
        | {
              mode: 'AMOUNTS';
              shares: { memberId: string; amountInCents: number }[];
          }
        | {
              mode: 'PERCENTAGES';
              shares: { memberId: string; basisPoints: number }[];
          };
    impactByMember: {
        memberId: string;
        beforeInCents: string | null;
        afterInCents: string | null;
        beforeBasisPoints: number | null;
        afterBasisPoints: number;
    }[];
};

export type FinancialClosureDestination = {
    originType: FinancialClosureDestinationInput['originType'];
    originId: string;
    expectedOriginVersion: number;
    destination: FinancialClosureDestinationInput['destination'];
    assigneeMemberId: string | null;
    amountInCents: number | null;
    cutoffDate: string;
    impactByMember: {
        memberId: string;
        beforeInCents: string | null;
        afterInCents: string | null;
        requiresAcceptance: boolean;
    }[];
    agreement?: {
        debtorMemberId: string;
        creditorMemberId: string;
        amountInCents: number;
    };
    originSnapshot: {
        version: number;
        fingerprint: string;
        kind: 'EXPENSE' | 'INCOME';
        description: string;
        eligibleRemainingInCents: string | null;
        futureItems: FinancialClosureFutureItem[];
        recurringImpacts?: FinancialClosureRecurringImpact[];
    };
};

export type FinancialClosureApplication = {
    effectId: string;
    originId: string;
    successorCommitmentId: string | null;
    agreementObligationId: string | null;
};

export interface FinancialClosureDestinationsPort {
    preview(
        actorId: string,
        spaceId: string,
        cutoffDate: string,
        input: FinancialClosureDestinationInput,
    ): Promise<FinancialClosureDestination>;
    applyApproved(
        actorId: string,
        spaceId: string,
        processId: string,
        now: Date,
    ): Promise<FinancialClosureApplication[]>;
}
