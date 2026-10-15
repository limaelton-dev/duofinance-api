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
        const rows: { id: string }[] = await this.provider
            .get()
            .query(
                `SELECT c.id FROM financial_commitments c JOIN financial_commitment_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id AND v.version=1 WHERE c.space_id=$1 AND c.kind='EXPENSE' AND c.personal_owner_person_id IS NOT NULL AND ($2::date IS NULL OR (v.fact_date,c.id)<($2::date,$3::uuid)) ORDER BY v.fact_date DESC,c.id DESC LIMIT 21`,
                [spaceId, after?.factDate ?? null, after?.id ?? null],
            );
        return Promise.all(
            rows.map(async (r) => {
                const c = await this.commitments.find(spaceId, r.id);
                if (!c || !('ownerPersonId' in c.initialVersion))
                    throw new Error('Personal expense missing');
                const view = personalExpenseView(
                    c as FinancialCommitment<PersonalCommitmentVersion>,
                );
                return {
                    id: r.id,
                    description: view.commitment.description,
                    amountInCents: view.commitment.amountInCents,
                    factDate: view.commitment.factDate,
                    disbursement: view.disbursement
                        ? {
                              amountInCents: view.disbursement.amountInCents,
                              method: view.disbursement.method,
                          }
                        : null,
                    externalLiabilities: view.externalLiabilities,
                    assumedAmountInCents: view.assumedAmountInCents,
                    externalOutstandingAmountInCents:
                        view.externalOutstandingAmountInCents,
                    supportedAmountInCents: view.supportedAmountInCents,
                    fulfillmentStatus: view.fulfillmentStatus,
                    paidAmountInCents: view.paidAmountInCents,
                    remainingAmountInCents: view.remainingAmountInCents,
                    status: view.status,
                };
            }),
        );
    }
}
