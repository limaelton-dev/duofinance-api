export function recurringClosureCutoffSql(
    referenceDate: string,
    occurrenceId: string,
    cutoff: string,
    spaceId = 'c.space_id',
) {
    return `(${cutoff}::date IS NULL OR ${referenceDate}<${cutoff}::date OR EXISTS (
        SELECT 1 FROM public.financial_disbursements recorded WHERE recorded.space_id=${spaceId} AND recorded.occurrence_id=${occurrenceId}
        UNION ALL SELECT 1 FROM public.financial_receipts recorded WHERE recorded.space_id=${spaceId} AND recorded.occurrence_id=${occurrenceId}
        UNION ALL SELECT 1 FROM public.financial_external_liabilities recorded WHERE recorded.space_id=${spaceId} AND recorded.occurrence_id=${occurrenceId}
    )) AND NOT EXISTS (SELECT 1 FROM financial_closure_effects destination WHERE destination.space_id=${spaceId}
        AND destination.origin_id=c.id AND ${referenceDate}>=destination.cutoff_date)`;
}
