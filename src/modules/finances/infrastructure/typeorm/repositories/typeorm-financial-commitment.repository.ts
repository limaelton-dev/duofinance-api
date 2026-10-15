import { FinancialExternalLiabilitySettlementOrmEntity } from '../entities/external-liability-settlement.orm-entity.js';
import { Inject, Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { SharedCashExpenseView } from '../../../application/models/shared-cash-expense.js';
import { expenseView } from '../../../application/models/shared-cash-expense.js';
import {
    FINANCES_CLOCK,
    INTER_MEMBER_OBLIGATION_REPOSITORY,
    type FinancialCommitmentRepository,
    type InterMemberObligationRepository,
    type FinancesClock,
} from '../../../application/ports/private/shared-expense.repositories.js';
import {
    FinancialCommitment,
    type ExpenseVersion,
    type CommitmentVersion,
} from '../../../domain/shared-expense/financial-commitment.js';
import { ResponsibilitySplit } from '../../../domain/shared-expense/responsibility-split.js';
import { Money } from '../../../domain/shared-expense/money.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import {
    commitmentRow,
    disbursementRow,
    externalLiabilityRow,
    shareRow,
    versionRow,
} from '../../mappers/shared-expense.mapper.js';
import {
    FinancialCommitmentOrmEntity,
    FinancialCommitmentShareOrmEntity,
    FinancialCommitmentVersionOrmEntity,
    FinancialDisbursementOrmEntity,
    FinancialExternalLiabilityOrmEntity,
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
    constructor(
        private readonly provider: EntityManagerProvider,
        @Inject(INTER_MEMBER_OBLIGATION_REPOSITORY)
        private readonly obligations: InterMemberObligationRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    async save(c: FinancialCommitment<ExpenseVersion>): Promise<void> {
        const m = transaction(this.provider),
            v = c.initialVersion;
        await m.insert(FinancialCommitmentOrmEntity, commitmentRow(c));
        await m.insert(FinancialCommitmentVersionOrmEntity, versionRow(c));
        if ('split' in v)
            for (const share of v.split.shares)
                await m.insert(
                    FinancialCommitmentShareOrmEntity,
                    shareRow(c as FinancialCommitment, share),
                );
        for (const fact of c.externalLiabilities)
            await m.insert(
                FinancialExternalLiabilityOrmEntity,
                externalLiabilityRow(c, fact),
            );
        for (const fact of c.disbursements)
            await m.insert(
                FinancialDisbursementOrmEntity,
                disbursementRow(c, fact),
            );
    }
    async saveExternalLiability(
        c: FinancialCommitment<ExpenseVersion>,
        expectedVersion: number,
    ): Promise<void> {
        const m = transaction(this.provider);
        const updated = await m.update(
            FinancialCommitmentOrmEntity,
            {
                id: c.id,
                spaceId: c.spaceId,
                version: expectedVersion,
                kind: 'EXPENSE',
            },
            { version: c.version },
        );
        if (updated.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        await m.insert(
            FinancialExternalLiabilityOrmEntity,
            externalLiabilityRow(c, c.externalLiabilities.at(-1)!),
        );
    }
    async find(
        spaceId: string,
        commitmentId: string,
        lock = false,
    ): Promise<FinancialCommitment<ExpenseVersion> | null> {
        const m = this.provider.get();
        const query = m
            .createQueryBuilder(FinancialCommitmentOrmEntity, 'c')
            .where(
                'c.space_id=:spaceId AND c.id=:commitmentId AND c.kind=:kind',
                { spaceId, commitmentId, kind: 'EXPENSE' },
            );
        if (lock) query.setLock('pessimistic_write');
        const c = await query.getOne();
        if (!c) return null;
        const v = await m.findOneByOrFail(FinancialCommitmentVersionOrmEntity, {
            spaceId,
            commitmentId,
            version: 1,
        });
        const facts = await m.find(FinancialDisbursementOrmEntity, {
            where: { spaceId, commitmentId },
            order: { sequence: 'ASC' },
        });
        const liabilities = await m.find(FinancialExternalLiabilityOrmEntity, {
            where: { spaceId, commitmentId },
            order: { sequence: 'ASC' },
        });
        const settlements = await m.find(
            FinancialExternalLiabilitySettlementOrmEntity,
            {
                where: { spaceId, commitmentId },
                order: { sequence: 'ASC' },
            },
        );
        const p = c.personalOwnerPersonId
            ? {
                  version: 1 as const,
                  ownerPersonId: c.personalOwnerPersonId,
                  amount: Money.from(v.amountInCents),
                  factDate: v.factDate,
              }
            : {
                  version: 1 as const,
                  split: ResponsibilitySplit.create(
                      v.amountInCents,
                      v.splitInput!.shares.map((s) => s.memberId),
                      v.splitInput!,
                  ),
                  expectedPayerMemberId: v.expectedPayerMemberId,
                  factDate: v.factDate,
                  settlementRuleSnapshot: v.ruleSnapshot,
                  settlementRuleSourceVersion: v.ruleSourceVersion,
                  suggestedTargetDate: v.suggestedTargetDate,
              };
        return new FinancialCommitment(
            c.id,
            c.spaceId,
            c.description,
            c.createdBy,
            c.registeredAt.toISOString(),
            p,
            facts.map((d) => ({
                id: d.id,
                sequence: d.sequence,
                ...(d.payerPersonId
                    ? { payerPersonId: d.payerPersonId }
                    : { payerMemberId: d.payerMemberId! }),
                method: d.method as 'PIX' | 'DEBIT' | 'CASH',
                amountInCents: d.amountInCents,
                factDate: d.factDate,
                registeredAt: d.registeredAt.toISOString(),
                recordedByPersonId: d.recordedByPersonId,
            })),
            this.clock.today(),
            c.version,
            liabilities.map((f) => ({
                id: f.id,
                sequence: f.sequence,
                ...(f.holderPersonId
                    ? { holderPersonId: f.holderPersonId }
                    : { holderMemberId: f.holderMemberId! }),
                amountInCents: f.amountInCents,
                remainingAmountInCents: f.remainingAmountInCents,
                settlements: settlements
                    .filter((s) => s.externalLiabilityId === f.id)
                    .map((s) => ({
                        id: s.id,
                        externalLiabilityId: s.externalLiabilityId,
                        sequence: s.sequence,
                        ...(s.holderPersonId
                            ? { holderPersonId: s.holderPersonId }
                            : { holderMemberId: s.holderMemberId! }),
                        amountInCents: s.amountInCents,
                        factDate: s.factDate,
                        registeredAt: s.registeredAt.toISOString(),
                        recordedByPersonId: s.recordedByPersonId,
                    })),
                factDate: f.factDate,
                registeredAt: f.registeredAt.toISOString(),
                recordedByPersonId: f.recordedByPersonId,
            })),
        );
    }
    async saveDisbursement(
        c: FinancialCommitment<ExpenseVersion>,
        expectedVersion: number,
    ): Promise<void> {
        const m = transaction(this.provider);
        const updated = await m.update(
            FinancialCommitmentOrmEntity,
            {
                id: c.id,
                spaceId: c.spaceId,
                version: expectedVersion,
                kind: 'EXPENSE',
            },
            { version: c.version },
        );
        if (updated.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        await m.insert(
            FinancialDisbursementOrmEntity,
            disbursementRow(c, c.disbursements.at(-1)!),
        );
    }
    async detail(
        spaceId: string,
        commitmentId: string,
    ): Promise<SharedCashExpenseView | null> {
        const c = await this.find(spaceId, commitmentId);
        if (!c || !('split' in c.initialVersion)) return null;
        const history = await this.obligations.history(spaceId, commitmentId);
        const latest = history.at(-1);
        const current =
            history.find((o) => o.remainingAmountInCents > 0) ??
            (latest?.status === 'SETTLED' ? latest : null);
        const cycle = current?.cycleId
            ? await this.provider
                  .get()
                  .findOneByOrFail(SettlementCycleOrmEntity, {
                      spaceId,
                      id: current.cycleId,
                  })
            : null;
        return {
            ...expenseView(
                c as FinancialCommitment<CommitmentVersion>,
                null,
                null,
            ),
            obligations: history,
            obligation: current,
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
