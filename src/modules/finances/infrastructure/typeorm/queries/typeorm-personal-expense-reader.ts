import { nonRecurringReadQuery } from './non-recurring-version-selection.js';
import { externalLiabilityProjection } from '../repositories/typeorm-external-liability-settlement.repository.js';
import { Inject, Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { PersonalExpenseReader } from '../../../application/ports/private/personal-expense.ports.js';
import {
    personalExpenseView,
    type PersonalExpenseView,
    type PersonalExpenseSummary,
} from '../../../application/models/personal-expense.js';
import {
    FINANCIAL_COMMITMENT_REPOSITORY,
    type FinancialCommitmentRepository,
} from '../../../application/ports/private/shared-expense.repositories.js';
import type {
    FinancialCommitment,
    PersonalCommitmentVersion,
} from '../../../domain/shared-expense/financial-commitment.js';
@Injectable()
export class TypeOrmPersonalExpenseReader implements PersonalExpenseReader {
    constructor(
        private readonly provider: EntityManagerProvider,
        @Inject(FINANCIAL_COMMITMENT_REPOSITORY)
        private readonly commitments: FinancialCommitmentRepository,
    ) {}
    async detail(
        spaceId: string,
        commitmentId: string,
    ): Promise<PersonalExpenseView | null> {
        const c = await this.commitments.find(spaceId, commitmentId);
        return c && 'ownerPersonId' in c.initialVersion
            ? personalExpenseView(
                  c as FinancialCommitment<PersonalCommitmentVersion>,
              )
            : null;
    }
    async list(
        spaceId: string,
        after: { factDate: string; id: string } | null,
    ): Promise<PersonalExpenseSummary[]> {
        // Limit roots first. Totals, first disbursement and the existing liability
        // contract are projected together in one statement/snapshot.
        const rows: {
            id: string;
            description: string;
            amount: string;
            factDate: string | null;
            expectedPaymentDate: string | null;
            relevantDate: string;
            paid: string;
            assumed: string;
            outstanding: string;
            disbursement: PersonalExpenseSummary['disbursement'];
            externalLiabilities: NonNullable<
                PersonalExpenseSummary['externalLiabilities']
            >;
        }[] = await nonRecurringReadQuery(
            this.provider.get(),
            `WITH page AS MATERIALIZED (
                SELECT c.id,c.space_id,c.description,v.amount_in_cents,v.fact_date,v.expected_payment_date,
                    COALESCE(v.expected_payment_date,v.fact_date) AS relevant_date
                FROM financial_commitments c JOIN financial_commitment_versions v
                    ON v.space_id=c.space_id AND v.commitment_id=c.id AND v.version=1
                WHERE c.space_id=$1 AND c.kind='EXPENSE' AND c.personal_owner_person_id IS NOT NULL
                    AND ($2::date IS NULL OR (COALESCE(v.expected_payment_date,v.fact_date),c.id)<($2::date,$3::uuid))
                ORDER BY relevant_date DESC,c.id DESC LIMIT 21
            )
            SELECT p.id,p.description,p.amount_in_cents::text AS amount,p.fact_date::text AS "factDate",
                p.expected_payment_date::text AS "expectedPaymentDate",p.relevant_date::text AS "relevantDate",
                COALESCE(d.paid,0)::text AS paid,COALESCE(f.assumed,0)::text AS assumed,
                COALESCE(f.outstanding,0)::text AS outstanding,
                (SELECT jsonb_build_object('amountInCents',amount_in_cents,'method',method)
                    FROM financial_disbursements WHERE space_id=p.space_id AND commitment_id=p.id
                    ORDER BY sequence LIMIT 1) AS disbursement,
                COALESCE(f.liabilities,'[]'::jsonb) AS "externalLiabilities"
            FROM page p
            LEFT JOIN LATERAL (
                SELECT SUM(amount_in_cents) AS paid FROM financial_disbursements
                WHERE space_id=p.space_id AND commitment_id=p.id
            ) d ON true
            LEFT JOIN LATERAL (
                SELECT SUM((x."externalLiability"->>'amountInCents')::bigint) AS assumed,
                    SUM((x."externalLiability"->>'remainingAmountInCents')::bigint) AS outstanding,
                    jsonb_agg(x."externalLiability" ORDER BY (x."externalLiability"->>'sequence')::int) AS liabilities
                FROM (${externalLiabilityProjection} WHERE c.space_id=p.space_id AND c.id=p.id) x
            ) f ON true
            ORDER BY p.relevant_date DESC,p.id DESC`,
            [spaceId, after?.factDate ?? null, after?.id ?? null],
        );
        return rows.map((r) => {
            const paid = Number(r.paid),
                assumed = Number(r.assumed);
            const supported = paid + assumed;
            const remaining = Number(r.amount) - supported;
            const fulfillmentStatus =
                paid + assumed === 0
                    ? 'PENDING'
                    : remaining === 0
                      ? 'FULFILLED'
                      : 'PARTIALLY_FULFILLED';
            return {
                id: r.id,
                description: r.description,
                amountInCents: Number(r.amount),
                factDate: r.factDate,
                ...(r.expectedPaymentDate
                    ? { expectedPaymentDate: r.expectedPaymentDate }
                    : {}),
                relevantDate: r.relevantDate,
                ...(r.expectedPaymentDate
                    ? {
                          overdue:
                              r.expectedPaymentDate <
                                  new Intl.DateTimeFormat('en-CA', {
                                      timeZone: 'America/Sao_Paulo',
                                      year: 'numeric',
                                      month: '2-digit',
                                      day: '2-digit',
                                  }).format(new Date()) && remaining > 0,
                      }
                    : {}),
                disbursement: r.disbursement,
                externalLiabilities: r.externalLiabilities,
                assumedAmountInCents: assumed,
                externalOutstandingAmountInCents: Number(r.outstanding),
                supportedAmountInCents: supported,
                fulfillmentStatus,
                paidAmountInCents: paid,
                remainingAmountInCents: remaining,
                status:
                    fulfillmentStatus === 'PENDING'
                        ? 'PENDING'
                        : r.externalLiabilities.length
                          ? fulfillmentStatus
                          : remaining === 0
                            ? 'PAID'
                            : 'PARTIALLY_PAID',
            };
        });
    }
}
