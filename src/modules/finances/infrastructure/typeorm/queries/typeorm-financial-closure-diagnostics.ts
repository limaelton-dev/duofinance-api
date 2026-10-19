import { Inject, Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../../../spaces/application/ports/public/space-access.port.js';
import { PersonId } from '../../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../../spaces/domain/space/space-id.js';
import {
    financialClosureBlockerTypes,
    type FinancialClosureBlocker,
    type FinancialClosureDiagnostic,
    type FinancialClosureDiagnosticsPort,
} from '../../../application/ports/public/financial-closure-diagnostics.port.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import { civilDate } from '../../../domain/shared-expense/settlement-cycle.js';
import { nonRecurringReadQuery } from './non-recurring-version-selection.js';

const fulfilled = (predicate: string) => `CASE WHEN c.kind='INCOME'
    THEN COALESCE((SELECT SUM(f.amount_in_cents) FROM financial_receipts f WHERE f.space_id=c.space_id AND ${predicate}),0)
    ELSE COALESCE((SELECT SUM(f.amount_in_cents) FROM financial_disbursements f WHERE f.space_id=c.space_id AND ${predicate}),0)
        +COALESCE((SELECT SUM(f.amount_in_cents) FROM financial_external_liabilities f WHERE f.space_id=c.space_id AND ${predicate}),0)
    END`;

const sql = `WITH obligations AS MATERIALIZED (
    SELECT o.*,c.description FROM inter_member_obligations o
    JOIN financial_commitments c ON c.space_id=o.space_id AND c.id=o.commitment_id
    WHERE o.space_id=$1 AND o.remaining_amount_in_cents>0
), one_time AS (
    SELECT c.id,c.description,c.version,v.expected_payment_date AS reference_date,
        v.expected_payer_member_id AS responsible_member_id,v.amount_in_cents-${fulfilled('f.commitment_id=c.id')} AS remaining
    FROM financial_commitments c JOIN financial_commitment_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id
    WHERE c.space_id=$1 AND c.modality='ONE_TIME' AND c.kind='EXPENSE'
    UNION ALL
    SELECT c.id,c.description,c.version,v.expected_receipt_date,v.expected_recipient_member_id,
        v.amount_in_cents-${fulfilled('f.commitment_id=c.id')}
    FROM financial_commitments c JOIN financial_income_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id
    WHERE c.space_id=$1 AND c.modality='ONE_TIME' AND c.kind='INCOME'
), recurrence_versions AS (
    SELECT c.id,c.description,c.version,c.kind,v.version AS economic_version,v.amount_in_cents,v.value_mode,
        v.frequency,v.day_of_month,v.month_of_year,v.expected_member_id,
        GREATEST(v.starts_on,v.effective_from) AS lo,
        LEAST(COALESCE(v.ends_on,'9999-12-31'::date),COALESCE(t.ends_on,'9999-12-31'::date),
            COALESCE((SELECT MIN(later.effective_from)-1 FROM financial_recurrence_versions later
                WHERE later.space_id=c.space_id AND later.commitment_id=c.id AND later.effective_from>v.effective_from),'9999-12-31'::date)) AS hi
    FROM financial_commitments c JOIN financial_recurrence_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id
    LEFT JOIN financial_recurrence_terminations t ON t.space_id=c.space_id AND t.commitment_id=c.id
    WHERE c.space_id=$1 AND c.modality='RECURRING'
), recurrence_future AS (
    SELECT DISTINCT ON (r.id) r.*,candidate.reference_date
    FROM recurrence_versions r
    CROSS JOIN LATERAL (
        SELECT dates.reference_date
        FROM generate_series(date_trunc('month',GREATEST(r.lo,$2::date)),
            date_trunc('month',LEAST(r.hi,(GREATEST(r.lo,$2::date,COALESCE((SELECT MAX(o.reference_date)
                FROM financial_occurrences o WHERE o.space_id=$1 AND o.commitment_id=r.id),$2::date))+interval '1 year')::date)),interval '1 month') months(m)
        CROSS JOIN LATERAL (SELECT make_date(EXTRACT(YEAR FROM months.m)::integer,EXTRACT(MONTH FROM months.m)::integer,
            LEAST(r.day_of_month,EXTRACT(DAY FROM (months.m+interval '1 month - 1 day')::date)::integer)) AS reference_date) dates
        WHERE dates.reference_date BETWEEN GREATEST(r.lo,$2::date) AND r.hi
            AND (r.frequency='MONTHLY' OR r.month_of_year=EXTRACT(MONTH FROM months.m)::integer)
            AND NOT EXISTS (SELECT 1 FROM financial_occurrences o WHERE o.space_id=$1 AND o.commitment_id=r.id
                AND o.reference_date>=months.m::date AND o.reference_date<(months.m+interval '1 month')::date)
        ORDER BY dates.reference_date LIMIT 1
    ) candidate
    ORDER BY r.id,candidate.reference_date
), recurring_open AS (
    SELECT c.id AS commitment_id,o.id AS occurrence_id,c.description,c.version,o.reference_date,
        o.amount_in_cents-${fulfilled('f.occurrence_id=o.id')} AS remaining,v.expected_member_id
    FROM financial_occurrences o JOIN financial_commitments c ON c.space_id=o.space_id AND c.id=o.commitment_id
    JOIN financial_recurrence_versions v ON v.space_id=o.space_id AND v.commitment_id=o.commitment_id AND v.version=o.economic_version
    WHERE o.space_id=$1 AND c.modality='RECURRING' AND o.status<>'CANCELLED'
    UNION ALL
    SELECT r.id,NULL::uuid,r.description,r.version,candidate.reference_date,
        CASE WHEN r.value_mode='VARIABLE' THEN NULL::bigint ELSE r.amount_in_cents END,r.expected_member_id
    FROM recurrence_versions r
    CROSS JOIN LATERAL (
        SELECT dates.reference_date
        FROM generate_series(date_trunc('month',r.lo),date_trunc('month',LEAST(r.hi,$2::date-1)),interval '1 month') months(m)
        CROSS JOIN LATERAL (SELECT make_date(EXTRACT(YEAR FROM months.m)::integer,EXTRACT(MONTH FROM months.m)::integer,
            LEAST(r.day_of_month,EXTRACT(DAY FROM (months.m+interval '1 month - 1 day')::date)::integer)) AS reference_date) dates
        WHERE dates.reference_date BETWEEN r.lo AND LEAST(r.hi,$2::date-1)
            AND (r.frequency='MONTHLY' OR r.month_of_year=EXTRACT(MONTH FROM months.m)::integer)
            AND NOT EXISTS (SELECT 1 FROM financial_occurrences o WHERE o.space_id=$1 AND o.commitment_id=r.id
                AND o.reference_date>=months.m::date AND o.reference_date<(months.m+interval '1 month')::date)
        ORDER BY dates.reference_date
    ) candidate
), installment_open AS (
    SELECT c.id AS commitment_id,i.id AS installment_id,c.description,c.version,i.due_date,
        i.amount_in_cents+COALESCE((SELECT a.adjustment_in_cents FROM financial_installment_anticipations a
            WHERE a.space_id=i.space_id AND a.installment_id=i.id),0)-${fulfilled('f.occurrence_id=i.id')} AS remaining,p.expected_member_id
    FROM financial_installments i JOIN financial_commitments c ON c.space_id=i.space_id AND c.id=i.commitment_id
    JOIN financial_installment_plans p ON p.space_id=i.space_id AND p.id=i.plan_id
    LEFT JOIN financial_occurrences o ON o.space_id=i.space_id AND o.installment_id=i.id
    WHERE i.space_id=$1 AND c.modality='INSTALLMENT' AND (o.status IS NULL OR o.status<>'CANCELLED')
        AND NOT EXISTS (SELECT 1 FROM financial_installment_resolutions resolved WHERE resolved.space_id=i.space_id AND resolved.installment_id=i.id)
        AND NOT EXISTS (SELECT 1 FROM financial_commitment_cancellations cancelled WHERE cancelled.space_id=i.space_id AND cancelled.commitment_id=c.id)
), blockers AS MATERIALIZED (
    SELECT 'INTER_MEMBER_OBLIGATION'::text AS type,o.id::text AS origin_id,
        jsonb_build_object('commitmentId',o.commitment_id,'occurrenceId',o.occurrence_id,'description',o.description,
            'version',o.version,'referenceDate',o.fact_date,'amountInCents',o.remaining_amount_in_cents::text,
            'debtorMemberId',o.debtor_member_id,'creditorMemberId',o.creditor_member_id,
            'action','Resolver por transferência, compensação ou dispensa do credor.') AS details FROM obligations o
    UNION ALL
    SELECT 'PENDING_FINANCIAL_CHANGE',p.id::text,jsonb_build_object('commitmentId',p.commitment_id,'description',c.description,
        'version',p.version,'responsibleMemberId',p.recipient_member_id,'action','Decidir ou cancelar a proposta financeira pendente.')
    FROM financial_commitment_change_proposals p JOIN financial_commitments c ON c.space_id=p.space_id AND c.id=p.commitment_id
    WHERE p.space_id=$1 AND p.status='PROPOSED'
    UNION ALL
    SELECT 'OPEN_ONE_TIME_COMMITMENT',o.id::text,jsonb_build_object('commitmentId',o.id,'description',o.description,'version',o.version,
        'referenceDate',o.reference_date,'amountInCents',o.remaining::text,'responsibleMemberId',o.responsible_member_id,
        'action','Resolver ou cancelar o compromisso avulso conforme seus fatos existentes.') FROM one_time o WHERE o.remaining>0
    UNION ALL
    SELECT 'OPEN_EXTERNAL_LIABILITY',l.id::text,jsonb_build_object('commitmentId',l.commitment_id,'occurrenceId',l.occurrence_id,
        'description',c.description,'version',c.version,'referenceDate',l.fact_date,'amountInCents',l.remaining_amount_in_cents::text,
        'responsibleMemberId',l.holder_member_id,'action','Liquidar ou definir tratamento explícito para a obrigação externa.')
    FROM financial_external_liabilities l JOIN financial_commitments c ON c.space_id=l.space_id AND c.id=l.commitment_id
    WHERE l.space_id=$1 AND l.remaining_amount_in_cents>0
    UNION ALL
    SELECT 'ACTIVE_RECURRENCE',r.id::text,jsonb_build_object('commitmentId',r.id,'description',r.description,'version',r.version,
        'referenceDate',r.reference_date,'amountInCents',r.amount_in_cents::text,'responsibleMemberId',r.expected_member_id,
        'action','Definir e aplicar o destino futuro da recorrência no plano.') FROM recurrence_future r
    UNION ALL
    SELECT 'OPEN_RECURRING_OCCURRENCE',COALESCE(o.occurrence_id::text,o.commitment_id::text||':'||o.reference_date::text),
        jsonb_build_object('commitmentId',o.commitment_id,'occurrenceId',o.occurrence_id,'description',o.description,'version',o.version,
            'referenceDate',o.reference_date,'amountInCents',o.remaining::text,'responsibleMemberId',o.expected_member_id,
            'action','Resolver a ocorrência existente antes do encerramento.')
    FROM recurring_open o WHERE o.remaining IS NULL OR o.remaining>0
    UNION ALL
    SELECT 'UNRESOLVED_INSTALLMENT',i.installment_id::text,jsonb_build_object('commitmentId',i.commitment_id,'occurrenceId',i.installment_id,
        'description',i.description,'version',i.version,'referenceDate',i.due_date,'amountInCents',i.remaining::text,
        'responsibleMemberId',i.expected_member_id,'action','Definir e aplicar o destino da parcela ou resolver o remanescente.')
    FROM installment_open i WHERE i.remaining>0
    UNION ALL
    SELECT 'OPEN_SETTLEMENT_CYCLE',s.id::text,jsonb_build_object('version',s.version,'referenceDate',s.target_date,
        'action','Resolver as pendências e finalizar o ciclo de acerto.') FROM settlement_cycles s WHERE s.space_id=$1 AND s.status='OPEN'
), page AS (
    SELECT * FROM blockers ORDER BY type,origin_id LIMIT $3 OFFSET $4
)
SELECT (SELECT COUNT(*)::text FROM blockers) AS total_count,
    COALESCE((SELECT jsonb_object_agg(type,total) FROM (SELECT type,COUNT(*)::integer AS total FROM blockers GROUP BY type) counts),'{}'::jsonb) AS counts,
    COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(details||jsonb_build_object('type',type,'originId',origin_id)) ORDER BY type,origin_id) FROM page),'[]'::jsonb) AS blockers,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('debtorMemberId',debtor_member_id,'creditorMemberId',creditor_member_id,'amountInCents',amount::text)
        ORDER BY debtor_member_id,creditor_member_id) FROM (SELECT debtor_member_id,creditor_member_id,SUM(remaining_amount_in_cents) AS amount
            FROM obligations GROUP BY debtor_member_id,creditor_member_id) directions),'[]'::jsonb) AS outstanding_amounts`;

@Injectable()
export class TypeOrmFinancialClosureDiagnostics implements FinancialClosureDiagnosticsPort {
    constructor(
        private readonly managers: EntityManagerProvider,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
    ) {}

    async read(
        actorId: string,
        spaceId: string,
        cutoffDate: string,
        page: { limit: number; offset?: number },
    ): Promise<FinancialClosureDiagnostic> {
        civilDate(cutoffDate);
        if (
            !Number.isInteger(page.limit) ||
            page.limit < 1 ||
            page.limit > 100 ||
            !Number.isSafeInteger(page.offset ?? 0) ||
            (page.offset ?? 0) < 0
        )
            throw new FinancesError('VALIDATION_ERROR', ['page']);
        const actor = PersonId.from(actorId),
            space = SpaceId.from(spaceId);
        const access = await this.access.assertCanRead(actor, space);
        if (access.type !== 'SHARED')
            throw new FinancesError('SHARED_SPACE_REQUIRED');
        const rows = await this.managers.readSnapshot(() =>
            nonRecurringReadQuery<
                {
                    total_count: string;
                    counts: Partial<FinancialClosureDiagnostic['counts']>;
                    blockers: FinancialClosureBlocker[];
                    outstanding_amounts: FinancialClosureDiagnostic['outstandingAmounts'];
                }[]
            >(
                this.managers.get(),
                sql,
                [spaceId, cutoffDate, page.limit, page.offset ?? 0],
                cutoffDate,
            ),
        );
        await this.access.assertCanRead(actor, space);
        const row = rows[0];
        const totalCount = Number(row.total_count);
        if (!Number.isSafeInteger(totalCount))
            throw new Error('Unsafe financial closure blocker count');
        const counts = Object.fromEntries(
            financialClosureBlockerTypes.map((type) => [
                type,
                row.counts[type] ?? 0,
            ]),
        ) as FinancialClosureDiagnostic['counts'];
        return {
            blockers: row.blockers,
            totalCount,
            counts,
            outstandingAmounts: row.outstanding_amounts,
            financiallyReady: totalCount === 0,
        };
    }
}
