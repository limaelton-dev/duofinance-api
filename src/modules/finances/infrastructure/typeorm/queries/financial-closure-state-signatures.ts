import type { EntityManager } from 'typeorm';

const sources = [
    'financial_commitments',
    'financial_commitment_versions',
    'financial_commitment_shares',
    'financial_income_versions',
    'financial_income_shares',
    'financial_recurrence_versions',
    'financial_recurrence_shares',
    'financial_recurrence_terminations',
    'financial_occurrences',
    'financial_occurrence_value_changes',
    'financial_occurrence_shares',
    'financial_occurrence_cancellations',
    'financial_installment_plans',
    'financial_installments',
    'financial_installment_shares',
    'financial_installment_anticipations',
    'financial_installment_payoffs',
    'financial_installment_resolutions',
    'financial_non_recurring_versions',
    'financial_disbursements',
    'financial_receipts',
    'financial_external_liabilities',
    'financial_external_liability_settlements',
    'financial_commitment_change_proposals',
    'financial_commitment_adjustments',
    'financial_commitment_cancellations',
    'financial_fulfillment_reversals',
    'inter_member_obligations',
    'inter_member_obligation_changes',
    'settlement_cycles',
    'settlement_cycle_changes',
    'settlement_transfers',
    'settlement_allocations',
    'settlement_offsets',
    'settlement_offset_allocations',
    'obligation_waivers',
    'settlement_reversals',
    'settlement_reversal_applications',
    'financial_commitment_settlement_rules',
    'financial_commitment_settlement_rule_changes',
    'default_settlement_rules',
    'default_settlement_rule_changes',
    'financial_closure_effects',
] as const;

const signaturesSql = sources
    .map(
        (source) => `SELECT '${source}' AS source,COUNT(*)::text AS total_count,
    encode(sha256(convert_to(COALESCE(string_agg(to_jsonb(r)::text,E'\\n' ORDER BY to_jsonb(r)::text),''),'UTF8')),'hex') AS signature
    FROM public.${source} r WHERE r.space_id=$1`,
    )
    .join(' UNION ALL ');

export function financialClosureStateSignatures(
    manager: EntityManager,
    spaceId: string,
): Promise<
    {
        source: string;
        total_count: string;
        signature: string;
    }[]
> {
    return manager.query(
        `SELECT * FROM (${signaturesSql}) state ORDER BY source`,
        [spaceId],
    );
}
