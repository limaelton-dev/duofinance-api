export const FINANCIAL_CLOSURE_DIAGNOSTICS_PORT = Symbol(
    'FINANCIAL_CLOSURE_DIAGNOSTICS_PORT',
);

export const financialClosureBlockerTypes = [
    'INTER_MEMBER_OBLIGATION',
    'PENDING_FINANCIAL_CHANGE',
    'OPEN_ONE_TIME_COMMITMENT',
    'OPEN_EXTERNAL_LIABILITY',
    'ACTIVE_RECURRENCE',
    'OPEN_RECURRING_OCCURRENCE',
    'UNRESOLVED_INSTALLMENT',
    'OPEN_SETTLEMENT_CYCLE',
] as const;

export type FinancialClosureBlockerType =
    (typeof financialClosureBlockerTypes)[number];

export interface FinancialClosureBlocker {
    type: FinancialClosureBlockerType;
    originId: string;
    commitmentId?: string;
    occurrenceId?: string;
    description?: string;
    version?: number;
    referenceDate?: string;
    amountInCents?: string | null;
    debtorMemberId?: string;
    creditorMemberId?: string;
    responsibleMemberId?: string;
    action: string;
}

export interface FinancialClosureDiagnostic {
    blockers: FinancialClosureBlocker[];
    totalCount: number;
    counts: Record<FinancialClosureBlockerType, number>;
    outstandingAmounts: {
        debtorMemberId: string;
        creditorMemberId: string;
        amountInCents: string;
    }[];
    financiallyReady: boolean;
}

export interface FinancialClosureDiagnosticsPort {
    read(
        actorId: string,
        spaceId: string,
        cutoffDate: string,
        page: { limit: number; offset?: number },
    ): Promise<FinancialClosureDiagnostic>;
}
