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
        const rows: {
            id: string;
            description: string;
            amount: string;
            fact_date: string;
            first_amount: string;
            method: 'PIX' | 'DEBIT' | 'CASH';
            paid: string;
        }[] = await this.provider
            .get()
            .query(
                `SELECT c.id,c.description,v.amount_in_cents::text AS amount,to_char(v.fact_date,'YYYY-MM-DD') AS fact_date,d.amount_in_cents::text AS first_amount,d.method,(SELECT SUM(p.amount_in_cents)::text FROM financial_disbursements p WHERE p.space_id=c.space_id AND p.commitment_id=c.id) AS paid FROM financial_commitments c JOIN financial_commitment_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id AND v.version=1 JOIN financial_disbursements d ON d.space_id=c.space_id AND d.commitment_id=c.id AND d.sequence=1 WHERE c.space_id=$1 AND c.kind='EXPENSE' AND c.personal_owner_person_id IS NOT NULL AND ($2::date IS NULL OR (v.fact_date,c.id)<($2::date,$3::uuid)) ORDER BY v.fact_date DESC,c.id DESC LIMIT 21`,
                [spaceId, after?.factDate ?? null, after?.id ?? null],
            );
        return rows.map((r) => ({
            id: r.id,
            description: r.description,
            amountInCents: Number(r.amount),
            factDate: r.fact_date,
            disbursement: {
                amountInCents: Number(r.first_amount),
                method: r.method,
            },
            paidAmountInCents: Number(r.paid),
            remainingAmountInCents: Number(r.amount) - Number(r.paid),
            status: r.amount === r.paid ? 'PAID' : 'PARTIALLY_PAID',
        }));
    }
}
