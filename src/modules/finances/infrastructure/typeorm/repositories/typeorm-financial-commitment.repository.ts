import { Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { SharedCashExpenseView } from '../../../application/models/shared-cash-expense.js';
import type { FinancialCommitmentRepository } from '../../../application/ports/private/shared-expense.repositories.js';
import {
    FinancialCommitment,
    type ExpenseVersion,
} from '../../../domain/shared-expense/shared-expense.js';
import {
    commitmentRow,
    disbursementRow,
    shareRow,
    versionRow,
} from '../../mappers/shared-expense.mapper.js';
import {
    FinancialCommitmentOrmEntity,
    FinancialCommitmentShareOrmEntity,
    FinancialCommitmentVersionOrmEntity,
    FinancialDisbursementOrmEntity,
    InterMemberObligationOrmEntity,
    SettlementCycleOrmEntity,
} from '../entities/shared-expense.orm-entity.js';
function transaction(provider: EntityManagerProvider) {
    const manager = provider.get();
    if (!manager.queryRunner?.isTransactionActive)
        throw new Error('Expense writes require a transaction');
    return manager;
}
@Injectable()
export class TypeOrmFinancialCommitmentRepository implements FinancialCommitmentRepository {
    constructor(private readonly provider: EntityManagerProvider) {}
    async save(c: FinancialCommitment<ExpenseVersion>): Promise<void> {
        const m = transaction(this.provider),
            v = c.initialVersion;
        await m.insert(FinancialCommitmentOrmEntity, commitmentRow(c));
        await m.insert(FinancialCommitmentVersionOrmEntity, versionRow(c));
        if ('split' in v)
            for (const share of v.split.shares) {
                await m.insert(
                    FinancialCommitmentShareOrmEntity,
                    shareRow(c as FinancialCommitment, share),
                );
            }
        await m.insert(FinancialDisbursementOrmEntity, disbursementRow(c));
    }
    async detail(
        spaceId: string,
        commitmentId: string,
    ): Promise<SharedCashExpenseView | null> {
        const m = this.provider.get();
        const c = await m.findOneBy(FinancialCommitmentOrmEntity, {
            id: commitmentId,
            spaceId,
        });
        if (!c || c.personalOwnerPersonId !== null) return null;
        const v = await m.findOneByOrFail(FinancialCommitmentVersionOrmEntity, {
            commitmentId,
            version: 1,
        });
        const shares = await m.find(FinancialCommitmentShareOrmEntity, {
            where: { commitmentId, version: 1 },
            order: { memberId: 'ASC' },
        });
        const d = await m.findOneByOrFail(FinancialDisbursementOrmEntity, {
            commitmentId,
            spaceId,
        });
        const o = await m.findOneBy(InterMemberObligationOrmEntity, {
            commitmentId,
            spaceId,
        });
        const cycle = o?.cycleId
            ? await m.findOneByOrFail(SettlementCycleOrmEntity, {
                  id: o.cycleId,
                  spaceId,
              })
            : null;
        return {
            spaceId,
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
                expectedPayerMemberId: v.expectedPayerMemberId,
                responsibilitySplit: {
                    ...(v.splitInput as SharedCashExpenseView['commitment']['responsibilitySplit']),
                    calculatedShares: shares.map((s) => ({
                        memberId: s.memberId,
                        amountInCents: s.amountInCents,
                    })),
                },
                settlementRuleSnapshot:
                    v.ruleSnapshot as SharedCashExpenseView['commitment']['settlementRuleSnapshot'],
                settlementRuleSourceVersion: v.ruleSourceVersion,
                suggestedTargetDate: v.suggestedTargetDate,
            },
            disbursement: {
                id: d.id,
                payerMemberId: d.payerMemberId!,
                method: d.method as 'PIX' | 'DEBIT' | 'CASH',
                amountInCents: d.amountInCents,
                factDate: d.factDate,
                registeredAt: d.registeredAt.toISOString(),
            },
            obligation: o
                ? {
                      id: o.id,
                      originCommitmentId: o.commitmentId,
                      originDisbursementId: o.disbursementId,
                      debtorMemberId: o.debtorMemberId,
                      creditorMemberId: o.creditorMemberId,
                      originalAmountInCents: o.originalAmountInCents,
                      remainingAmountInCents: o.remainingAmountInCents,
                      status: o.status,
                      cycleId: o.cycleId,
                  }
                : null,
            settlementCycle: cycle
                ? {
                      id: cycle.id,
                      targetDate: cycle.targetDate,
                      status: cycle.status as 'OPEN' | 'FINALIZED',
                  }
                : null,
        };
    }
}
