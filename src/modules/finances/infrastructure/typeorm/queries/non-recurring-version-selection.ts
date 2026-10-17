import type { EntityManager } from 'typeorm';
import { FinancialNonRecurringVersionOrmEntity } from '../entities/non-recurring-version.orm-entity.js';

export async function nonRecurringVersions(
    manager: EntityManager,
    spaceId: string,
    commitmentId: string,
) {
    return manager.find(FinancialNonRecurringVersionOrmEntity, {
        where: { spaceId, commitmentId },
        order: { effectiveFrom: 'ASC', version: 'ASC' },
    });
}

export function applicableNonRecurringVersion(
    versions: readonly FinancialNonRecurringVersionOrmEntity[],
    targetId: string,
    referenceDate: string,
    firstFactDate?: string,
) {
    const date =
        firstFactDate && firstFactDate < referenceDate
            ? firstFactDate
            : referenceDate;
    return (
        versions
            .filter(
                (version) =>
                    version.targetId === targetId &&
                    version.effectiveFrom <= date,
            )
            .at(-1) ?? null
    );
}

export function nonRecurringReadModels(
    referenceDate = "(CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date",
    todayReference = "(CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date",
    preserveCancelledHistory = false,
) {
    const reference = (target: string, source: string) =>
        referenceDate === 'TARGET_DATE'
            ? `GREATEST((${todayReference})::date,COALESCE((SELECT expected_payment_date FROM public.financial_commitment_versions original WHERE original.space_id=${source}.space_id AND original.commitment_id=${source}.commitment_id AND original.version=1),(SELECT expected_receipt_date FROM public.financial_income_versions original WHERE original.space_id=${source}.space_id AND original.commitment_id=${source}.commitment_id),(SELECT due_date FROM public.financial_installments original WHERE original.space_id=${source}.space_id AND original.id=${target})))`
            : referenceDate;
    const selected = (
        target: string,
        factPredicate: string,
        source = 'base',
    ) => `LEFT JOIN LATERAL (
        SELECT v.* FROM financial_non_recurring_versions v WHERE v.space_id=${source}.space_id AND v.commitment_id=${source}.commitment_id AND v.target_id=${target}
        AND v.effective_from<=LEAST((${reference(target, source)})::date,COALESCE((SELECT MIN(fact_date) FROM (
            SELECT fact_date FROM public.financial_disbursements d WHERE d.space_id=${source}.space_id AND ${factPredicate.replaceAll('FACT', 'd')}
            UNION ALL SELECT fact_date FROM public.financial_external_liabilities l WHERE l.space_id=${source}.space_id AND ${factPredicate.replaceAll('FACT', 'l')}
            UNION ALL SELECT fact_date FROM public.financial_receipts r WHERE r.space_id=${source}.space_id AND ${factPredicate.replaceAll('FACT', 'r')}
            UNION ALL SELECT fact_date FROM public.financial_installment_resolutions resolved WHERE resolved.space_id=${source}.space_id AND resolved.installment_id=${target}
        ) valid_dates),(${reference(target, source)})::date)) ORDER BY v.effective_from DESC,v.version DESC LIMIT 1
    ) applied ON true`;
    const delta = (target: string, source = 'base') =>
        `(SELECT COALESCE(SUM(CASE WHEN direction='INCREASE' THEN amount_in_cents ELSE -amount_in_cents END),0) FROM financial_commitment_adjustments a WHERE a.space_id=${source}.space_id AND a.commitment_id=${source}.commitment_id AND a.target_id=${target} AND a.commitment_version>COALESCE(applied.version,1))`;
    const shareDelta = (target: string, source = 'base') =>
        `(SELECT COALESCE(SUM((change->>'amountInCents')::bigint),0) FROM financial_commitment_adjustments a CROSS JOIN LATERAL jsonb_array_elements(a.share_changes) change WHERE a.space_id=${source}.space_id AND a.commitment_id=${source}.commitment_id AND a.target_id=${target} AND a.commitment_version>COALESCE(applied.version,1) AND (change->>'memberId')::uuid=${source}.member_id)`;
    const correctedInput = (
        original: string,
        target: string,
        table: string,
        source = 'base',
    ) =>
        `CASE WHEN EXISTS (SELECT 1 FROM financial_commitment_adjustments a WHERE a.space_id=${source}.space_id AND a.target_id=${target} AND a.commitment_version>COALESCE(applied.version,1)) AND ${original} IS NOT NULL THEN jsonb_build_object('mode','AMOUNTS','shares',(SELECT jsonb_agg(jsonb_build_object('memberId',s.member_id,'amountInCents',COALESCE((SELECT (share->>'amountInCents')::bigint FROM jsonb_array_elements(applied.economic_shares) share WHERE (share->>'memberId')::uuid=s.member_id),s.amount_in_cents)+${shareDelta(target, 's')}) ORDER BY s.member_id) FROM public.${table} s WHERE s.space_id=${source}.space_id AND s.commitment_id=${source}.commitment_id)) ELSE ${original} END`;
    return `financial_commitments AS (
        SELECT adjusted.* FROM (SELECT original.*,original.id AS commitment_id FROM public.financial_commitments original) base
        LEFT JOIN LATERAL (SELECT v.description FROM financial_non_recurring_versions v WHERE v.space_id=base.space_id AND v.commitment_id=base.id AND v.effective_from<=(${reference('base.id', 'base')})::date ORDER BY v.effective_from DESC,v.version DESC LIMIT 1) chosen ON true
        CROSS JOIN LATERAL jsonb_populate_record(NULL::public.financial_commitments,to_jsonb(base) || CASE WHEN chosen.description IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('description',chosen.description) END) adjusted
    ), financial_commitment_versions AS (
        SELECT adjusted.*,COALESCE(applied.version,1) AS economic_base_version FROM public.financial_commitment_versions base
        ${selected('base.commitment_id', 'FACT.commitment_id=base.commitment_id')}
        CROSS JOIN LATERAL jsonb_populate_record(NULL::public.financial_commitment_versions,to_jsonb(base) || jsonb_build_object('amount_in_cents',COALESCE(applied.amount_in_cents,base.amount_in_cents)+${delta('base.commitment_id')},'split_input',${correctedInput('COALESCE(applied.distribution,base.split_input)', 'base.commitment_id', 'financial_commitment_shares')},'split_mode',CASE WHEN base.split_input IS NULL THEN NULL WHEN EXISTS (SELECT 1 FROM financial_commitment_adjustments a WHERE a.space_id=base.space_id AND a.target_id=base.commitment_id AND a.commitment_version>COALESCE(applied.version,1)) THEN 'AMOUNTS' ELSE COALESCE(applied.distribution->>'mode',base.split_mode) END,'expected_payer_member_id',CASE WHEN applied.id IS NULL THEN base.expected_payer_member_id ELSE applied.expected_member_id END)) adjusted
        WHERE ${preserveCancelledHistory ? 'true' : 'NOT EXISTS (SELECT 1 FROM financial_commitment_cancellations cancelled WHERE cancelled.space_id=base.space_id AND cancelled.commitment_id=base.commitment_id)'}
    ), financial_income_versions AS (
        SELECT adjusted.*,COALESCE(applied.version,1) AS economic_base_version FROM public.financial_income_versions base
        ${selected('base.commitment_id', 'FACT.commitment_id=base.commitment_id')}
        CROSS JOIN LATERAL jsonb_populate_record(NULL::public.financial_income_versions,to_jsonb(base) || jsonb_build_object('amount_in_cents',COALESCE(applied.amount_in_cents,base.amount_in_cents)+${delta('base.commitment_id')},'split_input',${correctedInput('COALESCE(applied.distribution,base.split_input)', 'base.commitment_id', 'financial_income_shares')},'expected_recipient_member_id',CASE WHEN applied.id IS NULL THEN base.expected_recipient_member_id ELSE applied.expected_member_id END)) adjusted
        WHERE ${preserveCancelledHistory ? 'true' : 'NOT EXISTS (SELECT 1 FROM financial_commitment_cancellations cancelled WHERE cancelled.space_id=base.space_id AND cancelled.commitment_id=base.commitment_id)'}
    ), financial_installments AS (
        SELECT adjusted.*,COALESCE(applied.version,1) AS economic_base_version FROM public.financial_installments base
        ${selected('base.id', 'FACT.occurrence_id=base.id')}
        CROSS JOIN LATERAL jsonb_populate_record(NULL::public.financial_installments,to_jsonb(base) || jsonb_build_object('amount_in_cents',COALESCE(applied.amount_in_cents,base.amount_in_cents)+${delta('base.id')})) adjusted
    ), financial_commitment_shares AS (
        SELECT base.commitment_id,base.version,base.member_id,base.space_id,COALESCE((SELECT (share->>'amountInCents')::bigint FROM jsonb_array_elements(applied.economic_shares) share WHERE (share->>'memberId')::uuid=base.member_id),base.amount_in_cents)+${shareDelta('base.commitment_id')} AS amount_in_cents
        FROM public.financial_commitment_shares base ${selected('base.commitment_id', 'FACT.commitment_id=base.commitment_id')}
    ), financial_income_shares AS (
        SELECT base.commitment_id,base.member_id,base.space_id,COALESCE((SELECT (share->>'amountInCents')::bigint FROM jsonb_array_elements(applied.economic_shares) share WHERE (share->>'memberId')::uuid=base.member_id),base.amount_in_cents)+${shareDelta('base.commitment_id')} AS amount_in_cents
        FROM public.financial_income_shares base ${selected('base.commitment_id', 'FACT.commitment_id=base.commitment_id')}
    ), financial_installment_shares AS (
        SELECT base.installment_id,base.member_id,base.space_id,base.commitment_id,COALESCE((SELECT (share->>'amountInCents')::bigint FROM jsonb_array_elements(applied.economic_shares) share WHERE (share->>'memberId')::uuid=base.member_id),base.amount_in_cents)+${shareDelta('base.installment_id')} AS amount_in_cents
        FROM public.financial_installment_shares base ${selected('base.installment_id', 'FACT.occurrence_id=base.installment_id')}
    ), financial_occurrence_shares AS (
        SELECT original.occurrence_id,original.member_id,original.space_id,original.commitment_id,original.amount_in_cents FROM public.financial_occurrence_shares original WHERE NOT EXISTS (SELECT 1 FROM financial_commitment_adjustments a WHERE a.space_id=original.space_id AND a.target_id=original.occurrence_id)
        UNION ALL SELECT a.occurrence_id,(share->>'memberId')::uuid,a.space_id,a.commitment_id,(share->>'amountInCents')::bigint FROM financial_commitment_adjustments a CROSS JOIN LATERAL jsonb_array_elements(a.economic_shares) share WHERE a.occurrence_id IS NOT NULL AND a.installment_id IS NULL AND NOT EXISTS (SELECT 1 FROM financial_commitment_adjustments later WHERE later.space_id=a.space_id AND later.target_id=a.target_id AND later.commitment_version>a.commitment_version)
    ), financial_correction_bases AS (
        SELECT space_id,commitment_id,commitment_id AS target_id,economic_base_version FROM financial_commitment_versions
        UNION ALL SELECT space_id,commitment_id,commitment_id,economic_base_version FROM financial_income_versions
        UNION ALL SELECT space_id,commitment_id,id,economic_base_version FROM financial_installments
        UNION ALL SELECT space_id,commitment_id,id,0 FROM public.financial_occurrences WHERE installment_id IS NULL
    )`;
}

export function financialAdjustmentDeltaSql(
    target: string,
    space = '$1',
    member?: string,
) {
    const base = `COALESCE((SELECT b.economic_base_version FROM financial_correction_bases b WHERE b.space_id=a.space_id AND b.commitment_id=a.commitment_id AND b.target_id=a.target_id),1)`;
    return member
        ? `(SELECT COALESCE(SUM((change->>'amountInCents')::bigint),0) FROM financial_commitment_adjustments a CROSS JOIN LATERAL jsonb_array_elements(a.share_changes) change WHERE a.space_id=${space} AND a.target_id=${target} AND a.commitment_version>${base} AND (change->>'memberId')::uuid=${member})`
        : `(SELECT COALESCE(SUM(CASE WHEN a.direction='INCREASE' THEN a.amount_in_cents ELSE -a.amount_in_cents END),0) FROM financial_commitment_adjustments a WHERE a.space_id=${space} AND a.target_id=${target} AND a.commitment_version>${base})`;
}

export function withNonRecurringReadModels(
    sql: string,
    referenceDate?: string,
    todayReference?: string,
    netFulfillments = true,
) {
    const ctes = [
        ...(netFulfillments ? [financialFulfillmentReadModels()] : []),
        nonRecurringReadModels(referenceDate, todayReference, !netFulfillments),
    ].join(', ');
    return /^\s*WITH\s/i.test(sql)
        ? sql.replace(/^\s*WITH\s/i, `WITH ${ctes}, `)
        : `WITH ${ctes} ${sql}`;
}

export function nonRecurringReadQuery<T = unknown>(
    manager: EntityManager,
    sql: string,
    parameters?: unknown[],
    referenceDate?: string,
    netFulfillments = true,
): Promise<T> {
    if (
        referenceDate !== undefined &&
        !/^\d{4}-\d{2}-\d{2}$/.test(referenceDate)
    )
        throw new Error('Invalid financial reference date');
    return manager.query(
        withNonRecurringReadModels(
            sql,
            'TARGET_DATE',
            referenceDate ? `'${referenceDate}'::date` : undefined,
            netFulfillments,
        ),
        parameters,
    ) as Promise<T>;
}

export function financialFulfillmentReadModels() {
    const sources = [
        ['financial_disbursements', 'DISBURSEMENT'],
        ['financial_receipts', 'RECEIPT'],
        ['financial_external_liabilities', 'EXTERNAL_LIABILITY'],
        ['financial_external_liability_settlements', 'EXTERNAL_SETTLEMENT'],
    ];
    return sources
        .map(
            ([table, kind]) => `${table} AS (
        SELECT adjusted.* FROM public.${table} original
        CROSS JOIN LATERAL (SELECT original.amount_in_cents-COALESCE((SELECT SUM(r.amount_in_cents) FROM financial_fulfillment_reversals r WHERE r.space_id=original.space_id AND r.original_kind='${kind}' AND r.original_id=original.id),0) AS amount) valid
        CROSS JOIN LATERAL jsonb_populate_record(NULL::public.${table},to_jsonb(original)||jsonb_build_object('amount_in_cents',valid.amount)) adjusted
        WHERE valid.amount>0
    )`,
        )
        .concat([
            'financial_installment_payoffs AS (SELECT original.* FROM public.financial_installment_payoffs original WHERE NOT original.compensated)',
            'financial_installment_resolutions AS (SELECT original.* FROM public.financial_installment_resolutions original WHERE NOT original.compensated)',
        ])
        .join(', ');
}
