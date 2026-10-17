import { Inject, Injectable } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { EntityManagerProvider } from '../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../../spaces/application/ports/public/space-access.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import { FinanceTodayUnavailableError } from '../ports/public/finance-today-query.port.js';
import type { PlannedTodayQueryPort } from '../ports/public/planned-today-query.port.js';

@Injectable()
export class PlannedTodayQuery implements PlannedTodayQueryPort {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        private readonly managers: EntityManagerProvider,
    ) {}

    async readUpcoming(actor: PersonId, space: SpaceId, referenceDate: string) {
        await this.access.assertCanRead(actor, space);
        civilDate(referenceDate);
        type Row = {
            items: {
                commitmentId: string;
                occurrenceId: string | null;
                kind: 'EXPENSE' | 'INCOME';
                description: string;
                expectedDate: string;
                amountInCents: string | null;
                expectedAmountInCents: string | null;
                valuePending: boolean;
                fulfilledAmountInCents: string;
                remainingAmountInCents: string | null;
            }[];
            totalCount: string;
        };
        let rows: Row[];
        try {
            rows = await this.managers.readSnapshot(() =>
                this.managers.get().query(
                    `WITH one_time AS (
                    SELECT c.id AS commitment_id,NULL::uuid AS occurrence_id,'EXPENSE'::text AS kind,c.description,
                        v.expected_payment_date AS expected_date,v.amount_in_cents,v.amount_in_cents AS expected_amount_in_cents,
                        COALESCE((SELECT SUM(d.amount_in_cents) FROM financial_disbursements d WHERE d.space_id=c.space_id AND d.commitment_id=c.id),0)
                        +COALESCE((SELECT SUM(l.amount_in_cents) FROM financial_external_liabilities l WHERE l.space_id=c.space_id AND l.commitment_id=c.id),0) AS fulfilled
                    FROM financial_commitments c JOIN financial_commitment_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id
                    WHERE c.space_id=$1 AND c.modality='ONE_TIME' AND v.expected_payment_date IS NOT NULL
                ), scheduled AS (
                    SELECT c.id AS commitment_id,o.id AS occurrence_id,c.kind,v.description,
                        make_date(EXTRACT(YEAR FROM months.m)::integer,EXTRACT(MONTH FROM months.m)::integer,
                            LEAST(v.day_of_month,EXTRACT(DAY FROM (months.m+interval '1 month - 1 day')::date)::integer)) AS expected_date,
                        CASE WHEN v.value_mode='VARIABLE' THEN o.amount_in_cents ELSE v.amount_in_cents END AS amount_in_cents,
                        v.amount_in_cents AS expected_amount_in_cents,
                        CASE WHEN c.kind='INCOME'
                            THEN COALESCE((SELECT SUM(r.amount_in_cents) FROM financial_receipts r WHERE r.space_id=c.space_id AND r.occurrence_id=o.id),0)
                            ELSE COALESCE((SELECT SUM(d.amount_in_cents) FROM financial_disbursements d WHERE d.space_id=c.space_id AND d.occurrence_id=o.id),0)
                                +COALESCE((SELECT SUM(l.amount_in_cents) FROM financial_external_liabilities l WHERE l.space_id=c.space_id AND l.occurrence_id=o.id),0)
                        END AS fulfilled
                    FROM financial_commitments c JOIN financial_recurrence_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id
                    CROSS JOIN LATERAL generate_series(date_trunc('month',$2::date)-interval '12 months',date_trunc('month',$2::date)+interval '13 months',interval '1 month') AS months(m)
                    LEFT JOIN financial_recurrence_terminations t ON t.space_id=c.space_id AND t.commitment_id=c.id
                    LEFT JOIN financial_occurrences o ON o.space_id=c.space_id AND o.commitment_id=c.id AND o.reference_date=
                        make_date(EXTRACT(YEAR FROM months.m)::integer,EXTRACT(MONTH FROM months.m)::integer,
                            LEAST(v.day_of_month,EXTRACT(DAY FROM (months.m+interval '1 month - 1 day')::date)::integer))
                    WHERE c.space_id=$1 AND c.modality='RECURRING'
                        AND (v.frequency='MONTHLY' OR v.month_of_year=EXTRACT(MONTH FROM months.m)::integer)
                        AND o.id IS NULL
                        AND make_date(EXTRACT(YEAR FROM months.m)::integer,EXTRACT(MONTH FROM months.m)::integer,LEAST(v.day_of_month,EXTRACT(DAY FROM (months.m+interval '1 month - 1 day')::date)::integer)) >= v.starts_on
                        AND (v.ends_on IS NULL OR make_date(EXTRACT(YEAR FROM months.m)::integer,EXTRACT(MONTH FROM months.m)::integer,LEAST(v.day_of_month,EXTRACT(DAY FROM (months.m+interval '1 month - 1 day')::date)::integer)) <= v.ends_on)
                        AND make_date(EXTRACT(YEAR FROM months.m)::integer,EXTRACT(MONTH FROM months.m)::integer,LEAST(v.day_of_month,EXTRACT(DAY FROM (months.m+interval '1 month - 1 day')::date)::integer)) >= v.effective_from
                        AND NOT EXISTS (SELECT 1 FROM financial_recurrence_versions later WHERE later.commitment_id=v.commitment_id AND later.effective_from>v.effective_from AND later.effective_from<=make_date(EXTRACT(YEAR FROM months.m)::integer,EXTRACT(MONTH FROM months.m)::integer,LEAST(v.day_of_month,EXTRACT(DAY FROM (months.m+interval '1 month - 1 day')::date)::integer)))
                        AND (t.ends_on IS NULL OR make_date(EXTRACT(YEAR FROM months.m)::integer,EXTRACT(MONTH FROM months.m)::integer,LEAST(v.day_of_month,EXTRACT(DAY FROM (months.m+interval '1 month - 1 day')::date)::integer)) <= t.ends_on)
                        AND NOT EXISTS (SELECT 1 FROM financial_occurrences existing WHERE existing.space_id=c.space_id AND existing.commitment_id=c.id AND existing.reference_date>=months.m::date AND existing.reference_date<(months.m+interval '1 month')::date)
                ), materialized AS (
                    SELECT c.id AS commitment_id,o.id AS occurrence_id,c.kind,v.description,o.reference_date AS expected_date,
                        o.amount_in_cents,v.amount_in_cents AS expected_amount_in_cents,
                        CASE WHEN c.kind='INCOME'
                            THEN COALESCE((SELECT SUM(r.amount_in_cents) FROM financial_receipts r WHERE r.space_id=c.space_id AND r.occurrence_id=o.id),0)
                            ELSE COALESCE((SELECT SUM(d.amount_in_cents) FROM financial_disbursements d WHERE d.space_id=c.space_id AND d.occurrence_id=o.id),0)
                                +COALESCE((SELECT SUM(l.amount_in_cents) FROM financial_external_liabilities l WHERE l.space_id=c.space_id AND l.occurrence_id=o.id),0)
                        END AS fulfilled
                    FROM financial_occurrences o JOIN financial_commitments c ON c.space_id=o.space_id AND c.id=o.commitment_id
                    JOIN financial_recurrence_versions v ON v.space_id=o.space_id AND v.commitment_id=o.commitment_id AND v.version=o.economic_version
                    WHERE o.space_id=$1 AND o.status<>'CANCELLED'
                ), installments AS (
                    SELECT c.id AS commitment_id,i.id AS occurrence_id,'EXPENSE'::text AS kind,c.description,
                        i.due_date AS expected_date,i.amount_in_cents,i.amount_in_cents AS expected_amount_in_cents,
                        COALESCE((SELECT SUM(d.amount_in_cents) FROM financial_disbursements d WHERE d.space_id=i.space_id AND d.occurrence_id=i.id),0)
                        +COALESCE((SELECT SUM(l.amount_in_cents) FROM financial_external_liabilities l WHERE l.space_id=i.space_id AND l.occurrence_id=i.id),0) AS fulfilled
                    FROM financial_installments i JOIN financial_commitments c ON c.space_id=i.space_id AND c.id=i.commitment_id
                    JOIN financial_occurrences o ON o.space_id=i.space_id AND o.installment_id=i.id
                    WHERE i.space_id=$1 AND c.modality='INSTALLMENT' AND o.status<>'FULFILLED' AND NOT EXISTS (SELECT 1 FROM financial_installment_resolutions resolved WHERE resolved.installment_id=i.id)
                ), eligible AS (
                    SELECT * FROM one_time WHERE fulfilled<amount_in_cents
                    UNION ALL
                    SELECT * FROM scheduled
                    UNION ALL SELECT * FROM materialized
                    UNION ALL SELECT * FROM installments
                ), ranked AS (
                    SELECT *,ROW_NUMBER() OVER (PARTITION BY commitment_id ORDER BY expected_date) AS rank FROM eligible
                    WHERE fulfilled<amount_in_cents OR amount_in_cents IS NULL
                ), selected AS (
                    SELECT * FROM ranked WHERE rank=1
                ), page AS (
                    SELECT * FROM selected ORDER BY expected_date,commitment_id LIMIT 4
                ) SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object(
                    'commitmentId',commitment_id,'occurrenceId',occurrence_id,'kind',kind,'description',description,
                    'expectedDate',expected_date::text,'amountInCents',amount_in_cents::text,
                    'expectedAmountInCents',expected_amount_in_cents::text,
                    'fulfilledAmountInCents',fulfilled::text,'remainingAmountInCents',(amount_in_cents-fulfilled)::text,
                    'valuePending',amount_in_cents IS NULL
                ) ORDER BY expected_date,commitment_id) FROM page),'[]'::jsonb) AS items,
                (SELECT COUNT(*)::text FROM selected) AS "totalCount"`,
                    [space.value, referenceDate],
                ),
            );
        } catch (error) {
            if (error instanceof QueryFailedError)
                throw new FinanceTodayUnavailableError();
            throw error;
        }
        await this.access.assertCanRead(actor, space);
        return {
            items: rows[0].items.map((row) => ({
                ...row,
                amountInCents:
                    row.amountInCents === null
                        ? null
                        : Number(row.amountInCents),
                expectedAmountInCents:
                    row.expectedAmountInCents === null
                        ? null
                        : Number(row.expectedAmountInCents),
                fulfilledAmountInCents: Number(row.fulfilledAmountInCents),
                remainingAmountInCents:
                    row.remainingAmountInCents === null
                        ? null
                        : Number(row.remainingAmountInCents),
                overdue: row.expectedDate < referenceDate,
            })),
            totalCount: Number(rows[0].totalCount),
        };
    }
}
