const fulfillmentSql = (target: string) => `CASE WHEN c.kind='INCOME'
    THEN COALESCE((SELECT SUM(f.amount_in_cents) FROM financial_receipts f WHERE f.space_id=c.space_id AND ${target}),0)
    ELSE COALESCE((SELECT SUM(f.amount_in_cents) FROM financial_disbursements f WHERE f.space_id=c.space_id AND ${target}),0)
        +COALESCE((SELECT SUM(f.amount_in_cents) FROM financial_external_liabilities f WHERE f.space_id=c.space_id AND ${target}),0)
    END`;

export const financeTodayBucketsSql = `WITH one_time AS (
    SELECT c.id AS commitment_id,NULL::uuid AS occurrence_id,c.modality,c.kind,c.description,
        v.expected_payment_date AS expected_date,v.amount_in_cents,v.amount_in_cents AS expected_amount_in_cents,
        ${fulfillmentSql('f.commitment_id=c.id')} AS fulfilled
    FROM financial_commitments c
    JOIN financial_commitment_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id
    WHERE c.space_id=$1 AND c.kind='EXPENSE' AND c.modality='ONE_TIME' AND v.expected_payment_date IS NOT NULL
    UNION ALL
    SELECT c.id,NULL::uuid,c.modality,c.kind,c.description,
        v.expected_receipt_date,v.amount_in_cents,v.amount_in_cents,
        ${fulfillmentSql('f.commitment_id=c.id')}
    FROM financial_commitments c
    JOIN financial_income_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id
    WHERE c.space_id=$1 AND c.kind='INCOME' AND c.modality='ONE_TIME'
), recurrence_bounds AS (
    SELECT c.id AS commitment_id,c.modality,c.kind,v.description,v.amount_in_cents,v.value_mode,
        v.frequency,v.day_of_month,v.month_of_year,
        GREATEST(v.starts_on,v.effective_from) AS starts_on,
        LEAST(COALESCE(v.ends_on,'9999-12-31'::date),COALESCE(t.ends_on,'9999-12-31'::date),
            COALESCE((SELECT MIN(later.effective_from)-1 FROM financial_recurrence_versions later
                WHERE later.space_id=c.space_id AND later.commitment_id=c.id AND later.effective_from>v.effective_from),'9999-12-31'::date),
            (GREATEST($2::date,v.starts_on,v.effective_from,COALESCE((SELECT MAX(o.reference_date)
                FROM financial_occurrences o WHERE o.space_id=c.space_id AND o.commitment_id=c.id),$2::date))
                +CASE WHEN v.frequency='ANNUAL' THEN interval '1 year' ELSE interval '1 month' END)::date) AS ends_on
    FROM financial_commitments c
    JOIN financial_recurrence_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id
    LEFT JOIN financial_recurrence_terminations t ON t.space_id=c.space_id AND t.commitment_id=c.id
    WHERE c.space_id=$1 AND c.modality='RECURRING'
), recurrence_ranges AS (
    SELECT r.*,b.bucket,
        GREATEST(r.starts_on,CASE b.bucket WHEN 'TODAY' THEN $2::date WHEN 'UPCOMING' THEN $2::date+1 ELSE r.starts_on END) AS lo,
        LEAST(r.ends_on,CASE b.bucket WHEN 'OVERDUE' THEN $2::date-1 WHEN 'TODAY' THEN $2::date ELSE r.ends_on END) AS hi
    FROM recurrence_bounds r CROSS JOIN (VALUES ('OVERDUE'),('TODAY'),('UPCOMING')) b(bucket)
), scheduled AS (
    SELECT r.commitment_id,NULL::uuid AS occurrence_id,r.modality,r.kind,r.description,
        candidate.expected_date,CASE WHEN r.value_mode='VARIABLE' THEN NULL::bigint ELSE r.amount_in_cents END AS amount_in_cents,
        r.amount_in_cents AS expected_amount_in_cents,0::numeric AS fulfilled
    FROM recurrence_ranges r
    CROSS JOIN LATERAL (
        SELECT dates.expected_date FROM generate_series(date_trunc('month',r.lo),date_trunc('month',r.hi),interval '1 month') AS months(m)
        CROSS JOIN LATERAL (SELECT make_date(EXTRACT(YEAR FROM months.m)::integer,EXTRACT(MONTH FROM months.m)::integer,
            LEAST(r.day_of_month,EXTRACT(DAY FROM (months.m+interval '1 month - 1 day')::date)::integer)) AS expected_date) dates
        WHERE dates.expected_date BETWEEN r.lo AND r.hi
            AND (r.frequency='MONTHLY' OR r.month_of_year=EXTRACT(MONTH FROM months.m)::integer)
            AND NOT EXISTS (SELECT 1 FROM financial_occurrences existing WHERE existing.space_id=$1
                AND existing.commitment_id=r.commitment_id AND existing.reference_date>=months.m::date
                AND existing.reference_date<(months.m+interval '1 month')::date)
        ORDER BY dates.expected_date LIMIT 1
    ) candidate
), materialized AS (
    SELECT c.id AS commitment_id,o.id AS occurrence_id,c.modality,c.kind,v.description,
        o.reference_date AS expected_date,o.amount_in_cents,v.amount_in_cents AS expected_amount_in_cents,
        ${fulfillmentSql('f.occurrence_id=o.id')} AS fulfilled
    FROM financial_occurrences o
    JOIN financial_commitments c ON c.space_id=o.space_id AND c.id=o.commitment_id
    JOIN financial_recurrence_versions v ON v.space_id=o.space_id AND v.commitment_id=o.commitment_id AND v.version=o.economic_version
    WHERE o.space_id=$1 AND c.modality='RECURRING' AND o.status<>'CANCELLED'
), installments AS (
    SELECT c.id AS commitment_id,i.id AS occurrence_id,c.modality,c.kind,c.description,
        i.due_date AS expected_date,i.amount_in_cents,i.amount_in_cents AS expected_amount_in_cents,
        ${fulfillmentSql('f.occurrence_id=i.id')} AS fulfilled
    FROM financial_installments i
    JOIN financial_commitments c ON c.space_id=i.space_id AND c.id=i.commitment_id
    JOIN financial_occurrences o ON o.space_id=i.space_id AND o.installment_id=i.id
    WHERE i.space_id=$1 AND c.modality='INSTALLMENT' AND o.status<>'CANCELLED'
        AND NOT EXISTS (SELECT 1 FROM financial_installment_resolutions resolved WHERE resolved.space_id=i.space_id AND resolved.installment_id=i.id)
        AND NOT EXISTS (SELECT 1 FROM financial_commitment_cancellations cancelled WHERE cancelled.space_id=c.space_id AND cancelled.commitment_id=c.id)
), eligible AS (
    SELECT * FROM one_time UNION ALL SELECT * FROM scheduled
    UNION ALL SELECT * FROM materialized UNION ALL SELECT * FROM installments
), classified AS (
    SELECT *,CASE WHEN expected_date<$2::date THEN 'OVERDUE' WHEN expected_date=$2::date THEN 'TODAY' ELSE 'UPCOMING' END AS bucket
    FROM eligible WHERE amount_in_cents IS NULL OR fulfilled<amount_in_cents
), ranked AS (
    SELECT *,ROW_NUMBER() OVER (PARTITION BY commitment_id,bucket ORDER BY expected_date,occurrence_id NULLS LAST) AS ordinal
    FROM classified
), selected AS (
    SELECT * FROM ranked WHERE ordinal=1
), counted AS (
    SELECT *,COUNT(*) OVER (PARTITION BY bucket) AS total_count,
        ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY expected_date,commitment_id) AS page_ordinal
    FROM selected
)
SELECT bucket,MAX(total_count)::text AS "totalCount",jsonb_agg(jsonb_build_object(
    'commitmentId',commitment_id,'occurrenceId',occurrence_id,'modality',modality,'kind',kind,'description',description,
    'expectedDate',expected_date::text,'amountInCents',amount_in_cents::text,'expectedAmountInCents',expected_amount_in_cents::text,
    'valuePending',amount_in_cents IS NULL,'fulfilledAmountInCents',fulfilled::text,'remainingAmountInCents',(amount_in_cents-fulfilled)::text
) ORDER BY expected_date,commitment_id) AS items
FROM counted WHERE page_ordinal<=4 GROUP BY bucket`;
