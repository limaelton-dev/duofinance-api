import { Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { PersonalExpenseReader } from '../../../application/ports/private/personal-expense.ports.js';
import type {
    PersonalExpenseView,
    PersonalExpenseSummary,
} from '../../../application/models/personal-expense.js';
import {
    FinancialCommitmentOrmEntity,
    FinancialCommitmentVersionOrmEntity,
    FinancialDisbursementOrmEntity,
} from '../entities/shared-expense.orm-entity.js';
@Injectable()
export class TypeOrmPersonalExpenseReader implements PersonalExpenseReader {
    constructor(private readonly provider: EntityManagerProvider) {}
    async detail(
        spaceId: string,
        commitmentId: string,
    ): Promise<PersonalExpenseView | null> {
        const manager = this.provider.get();
        const c = await manager.findOneBy(FinancialCommitmentOrmEntity, {
            spaceId,
            id: commitmentId,
        });
        if (!c?.personalOwnerPersonId) return null;
        const v = await manager.findOneByOrFail(
            FinancialCommitmentVersionOrmEntity,
            { spaceId, commitmentId, version: 1 },
        );
        const d = await manager.findOneByOrFail(
            FinancialDisbursementOrmEntity,
            { spaceId, commitmentId },
        );
        return {
            spaceId,
            spaceType: 'PERSONAL',
            commitment: {
                id: c.id,
                version: 1,
                kind: 'EXPENSE',
                modality: 'ONE_TIME',
                description: c.description,
                amountInCents: v.amountInCents,
                factDate: v.factDate,
                registeredAt: c.registeredAt.toISOString(),
                createdByPersonId: c.createdBy,
                ownerPersonId: c.personalOwnerPersonId,
            },
            disbursement: {
                id: d.id,
                payerPersonId: d.payerPersonId!,
                amountInCents: d.amountInCents,
                method: d.method as 'PIX' | 'DEBIT' | 'CASH',
                factDate: d.factDate,
                registeredAt: d.registeredAt.toISOString(),
            },
        };
    }
    async list(
        spaceId: string,
        after: { factDate: string; id: string } | null,
    ): Promise<PersonalExpenseSummary[]> {
        const query = this.provider
            .get()
            .createQueryBuilder(FinancialCommitmentOrmEntity, 'c')
            .innerJoin(
                FinancialCommitmentVersionOrmEntity,
                'v',
                'v.commitment_id = c.id AND v.space_id = c.space_id AND v.version = 1',
            )
            .innerJoin(
                FinancialDisbursementOrmEntity,
                'd',
                'd.commitment_id = c.id AND d.space_id = c.space_id',
            )
            .select('c.id', 'id')
            .addSelect('c.description', 'description')
            .addSelect('v.amount_in_cents', 'amountInCents')
            .addSelect('v.fact_date::text', 'factDate')
            .addSelect('d.amount_in_cents', 'disbursementAmountInCents')
            .addSelect('d.method', 'method')
            .where(
                'c.space_id = :spaceId AND c.personal_owner_person_id IS NOT NULL',
                { spaceId },
            );
        if (after)
            query.andWhere('(v.fact_date, c.id) < (:factDate, :id)', after);
        const rows = await query
            .orderBy('v.fact_date', 'DESC')
            .addOrderBy('c.id', 'DESC')
            .limit(21)
            .getRawMany<{
                id: string;
                description: string;
                amountInCents: string;
                factDate: string;
                disbursementAmountInCents: string;
                method: 'PIX' | 'DEBIT' | 'CASH';
            }>();
        return rows.map((r) => ({
            id: r.id,
            description: r.description,
            amountInCents: Number(r.amountInCents),
            factDate: r.factDate,
            disbursement: {
                amountInCents: Number(r.disbursementAmountInCents),
                method: r.method,
            },
        }));
    }
}
