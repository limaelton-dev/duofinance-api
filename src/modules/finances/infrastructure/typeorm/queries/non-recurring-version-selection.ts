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
            SELECT fact_date FROM financial_disbursements d WHERE d.space_id=${source}.space_id AND ${factPredicate.replaceAll('FACT', 'd')}
            UNION ALL SELECT fact_date FROM financial_external_liabilities l WHERE l.space_id=${source}.space_id AND ${factPredicate.replaceAll('FACT', 'l')}
            UNION ALL SELECT fact_date FROM financial_receipts r WHERE r.space_id=${source}.space_id AND ${factPredicate.replaceAll('FACT', 'r')}
            UNION ALL SELECT fact_date FROM financial_installment_resolutions resolved WHERE resolved.space_id=${source}.space_id AND resolved.installment_id=${target}
        ) valid_dates),(${reference(target, source)})::date)) ORDER BY v.effective_from DESC,v.version DESC LIMIT 1
    ) applied ON true`;
    return `financial_commitments AS (
        SELECT adjusted.* FROM (SELECT original.*,original.id AS commitment_id FROM public.financial_commitments original) base
        LEFT JOIN LATERAL (SELECT v.description FROM financial_non_recurring_versions v WHERE v.space_id=base.space_id AND v.commitment_id=base.id AND v.effective_from<=(${reference('base.id', 'base')})::date ORDER BY v.effective_from DESC,v.version DESC LIMIT 1) chosen ON true
        CROSS JOIN LATERAL jsonb_populate_record(NULL::public.financial_commitments,to_jsonb(base) || CASE WHEN chosen.description IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('description',chosen.description) END) adjusted
    ), financial_commitment_versions AS (
        SELECT adjusted.* FROM public.financial_commitment_versions base
        ${selected('base.commitment_id', 'FACT.commitment_id=base.commitment_id')}
        CROSS JOIN LATERAL jsonb_populate_record(NULL::public.financial_commitment_versions,to_jsonb(base) || CASE WHEN applied.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('amount_in_cents',applied.amount_in_cents,'split_input',applied.distribution,'split_mode',applied.distribution->>'mode','expected_payer_member_id',applied.expected_member_id) END) adjusted
    ), financial_income_versions AS (
        SELECT adjusted.* FROM public.financial_income_versions base
        ${selected('base.commitment_id', 'FACT.commitment_id=base.commitment_id')}
        CROSS JOIN LATERAL jsonb_populate_record(NULL::public.financial_income_versions,to_jsonb(base) || CASE WHEN applied.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('amount_in_cents',applied.amount_in_cents,'split_input',applied.distribution,'expected_recipient_member_id',applied.expected_member_id) END) adjusted
    ), financial_installments AS (
        SELECT adjusted.* FROM public.financial_installments base
        ${selected('base.id', 'FACT.occurrence_id=base.id')}
        CROSS JOIN LATERAL jsonb_populate_record(NULL::public.financial_installments,to_jsonb(base) || CASE WHEN applied.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('amount_in_cents',applied.amount_in_cents) END) adjusted
    ), financial_commitment_shares AS (
        SELECT base.commitment_id,base.version,base.member_id,base.space_id,COALESCE((SELECT (share->>'amountInCents')::bigint FROM jsonb_array_elements(applied.economic_shares) share WHERE (share->>'memberId')::uuid=base.member_id),base.amount_in_cents) AS amount_in_cents
        FROM public.financial_commitment_shares base ${selected('base.commitment_id', 'FACT.commitment_id=base.commitment_id')}
    ), financial_income_shares AS (
        SELECT base.commitment_id,base.member_id,base.space_id,COALESCE((SELECT (share->>'amountInCents')::bigint FROM jsonb_array_elements(applied.economic_shares) share WHERE (share->>'memberId')::uuid=base.member_id),base.amount_in_cents) AS amount_in_cents
        FROM public.financial_income_shares base ${selected('base.commitment_id', 'FACT.commitment_id=base.commitment_id')}
    ), financial_installment_shares AS (
        SELECT base.installment_id,base.member_id,base.space_id,base.commitment_id,COALESCE((SELECT (share->>'amountInCents')::bigint FROM jsonb_array_elements(applied.economic_shares) share WHERE (share->>'memberId')::uuid=base.member_id),base.amount_in_cents) AS amount_in_cents
        FROM public.financial_installment_shares base ${selected('base.installment_id', 'FACT.occurrence_id=base.installment_id')}
    )`;
}

export function withNonRecurringReadModels(
    sql: string,
    referenceDate?: string,
    todayReference?: string,
) {
    const ctes = nonRecurringReadModels(referenceDate, todayReference);
    return /^\s*WITH\s/i.test(sql)
        ? sql.replace(/^\s*WITH\s/i, `WITH ${ctes}, `)
        : `WITH ${ctes} ${sql}`;
}

export function nonRecurringReadQuery<T = unknown>(
    manager: EntityManager,
    sql: string,
    parameters?: unknown[],
    referenceDate?: string,
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
        ),
        parameters,
    ) as Promise<T>;
}
