import { Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { IncomeRepository } from '../../../application/ports/private/income.ports.js';
import type {
    IncomeSummary,
    IncomeView,
} from '../../../application/models/income.js';
import { IncomeCommitment } from '../../../domain/income/income-commitment.js';
import { ResponsibilitySplit } from '../../../domain/shared-expense/responsibility-split.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import {
    FinancialCommitmentOrmEntity,
    InterMemberObligationOrmEntity,
    SettlementCycleOrmEntity,
} from '../entities/shared-expense.orm-entity.js';
import {
    FinancialIncomeVersionOrmEntity,
    FinancialIncomeShareOrmEntity,
    FinancialReceiptOrmEntity,
} from '../entities/income.orm-entity.js';

@Injectable()
export class TypeOrmIncomeRepository implements IncomeRepository {
    constructor(private readonly provider: EntityManagerProvider) {}

    async save(income: IncomeCommitment): Promise<void> {
        const m = this.provider.get();
        const p = income.participation;
        await m.insert(FinancialCommitmentOrmEntity, {
            id: income.id,
            spaceId: income.spaceId,
            kind: 'INCOME',
            modality: 'ONE_TIME',
            description: income.description,
            createdBy: income.createdByPersonId,
            personalOwnerPersonId:
                p.type === 'PERSONAL' ? p.ownerPersonId : null,
            version: income.version,
            registeredAt: new Date(income.registeredAt),
        });
        await m.insert(FinancialIncomeVersionOrmEntity, {
            commitmentId: income.id,
            spaceId: income.spaceId,
            amountInCents: income.amountInCents,
            expectedReceiptDate: income.expectedReceiptDate,
            ownerPersonId: p.type === 'PERSONAL' ? p.ownerPersonId : null,
            splitInput: p.type === 'SHARED' ? p.split.original : null,
            expectedRecipientMemberId:
                p.type === 'SHARED' ? p.expectedRecipientMemberId : null,
            ruleSnapshot: p.type === 'SHARED' ? p.settlementRuleSnapshot : null,
            ruleSourceVersion:
                p.type === 'SHARED' ? p.settlementRuleSourceVersion : 0,
        });
        if (p.type === 'SHARED') {
            for (const share of p.split.shares) {
                await m.insert(FinancialIncomeShareOrmEntity, {
                    commitmentId: income.id,
                    spaceId: income.spaceId,
                    memberId: share.memberId,
                    amountInCents: share.amountInCents,
                });
            }
        }
        if (income.receipt) await this.insertReceipt(income);
    }

    private async insertReceipt(income: IncomeCommitment): Promise<void> {
        const receipt = income.receipt!;
        await this.provider.get().insert(FinancialReceiptOrmEntity, {
            id: receipt.id,
            spaceId: income.spaceId,
            commitmentId: income.id,
            amountInCents: receipt.amountInCents,
            factDate: receipt.factDate,
            registeredAt: new Date(receipt.registeredAt),
            recordedByPersonId: receipt.recordedByPersonId,
            recipientPersonId: receipt.recipientPersonId,
            recipientMemberId: receipt.recipientMemberId,
        });
    }

    async find(
        spaceId: string,
        commitmentId: string,
        lock = false,
    ): Promise<IncomeCommitment | null> {
        const m = this.provider.get();
        const query = m
            .createQueryBuilder(FinancialCommitmentOrmEntity, 'c')
            .where(
                'c.space_id = :spaceId AND c.id = :commitmentId AND c.kind = :kind',
                { spaceId, commitmentId, kind: 'INCOME' },
            );
        if (lock) query.setLock('pessimistic_write');
        const c = await query.getOne();
        if (!c) return null;
        const v = await m.findOneByOrFail(FinancialIncomeVersionOrmEntity, {
            spaceId,
            commitmentId,
        });
        const receipt = await m.findOneBy(FinancialReceiptOrmEntity, {
            spaceId,
            commitmentId,
        });
        const shares = v.ownerPersonId
            ? []
            : await m.find(FinancialIncomeShareOrmEntity, {
                  where: { spaceId, commitmentId },
                  order: { memberId: 'ASC' },
              });
        return new IncomeCommitment(
            c.id,
            c.spaceId,
            c.description,
            v.amountInCents,
            v.expectedReceiptDate,
            c.createdBy,
            c.registeredAt.toISOString(),
            v.ownerPersonId
                ? { type: 'PERSONAL', ownerPersonId: v.ownerPersonId }
                : {
                      type: 'SHARED',
                      split: ResponsibilitySplit.create(
                          v.amountInCents,
                          shares.map((s) => s.memberId),
                          v.splitInput!,
                      ),
                      expectedRecipientMemberId: v.expectedRecipientMemberId,
                      settlementRuleSnapshot: v.ruleSnapshot,
                      settlementRuleSourceVersion: v.ruleSourceVersion,
                  },
            receipt
                ? {
                      id: receipt.id,
                      amountInCents: receipt.amountInCents,
                      factDate: receipt.factDate,
                      registeredAt: receipt.registeredAt.toISOString(),
                      recordedByPersonId: receipt.recordedByPersonId,
                      recipientPersonId: receipt.recipientPersonId,
                      recipientMemberId: receipt.recipientMemberId,
                  }
                : null,
            c.version,
        );
    }

    async saveReceipt(
        income: IncomeCommitment,
        expectedVersion: number,
    ): Promise<void> {
        const result = await this.provider
            .get()
            .createQueryBuilder()
            .update(FinancialCommitmentOrmEntity)
            .set({ version: income.version })
            .where(
                'id = :id AND space_id = :spaceId AND version = :version AND kind = :kind',
                {
                    id: income.id,
                    spaceId: income.spaceId,
                    version: expectedVersion,
                    kind: 'INCOME',
                },
            )
            .execute();
        if (result.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        await this.insertReceipt(income);
    }

    async detail(
        spaceId: string,
        commitmentId: string,
    ): Promise<IncomeView | null> {
        const income = await this.find(spaceId, commitmentId);
        if (!income) return null;
        const p = income.participation;
        const m = this.provider.get();
        const obligation = await m.findOneBy(InterMemberObligationOrmEntity, {
            spaceId,
            commitmentId,
        });
        const cycle = obligation?.cycleId
            ? await m.findOneByOrFail(SettlementCycleOrmEntity, {
                  spaceId,
                  id: obligation.cycleId,
              })
            : null;
        return {
            spaceId,
            spaceType: p.type,
            commitment: {
                id: income.id,
                kind: 'INCOME',
                modality: 'ONE_TIME',
                version: income.version,
                description: income.description,
                amountInCents: income.amountInCents,
                expectedReceiptDate: income.expectedReceiptDate,
                createdByPersonId: income.createdByPersonId,
                registeredAt: income.registeredAt,
                ...(p.type === 'PERSONAL'
                    ? { ownerPersonId: p.ownerPersonId }
                    : {
                          participationSplit: {
                              ...p.split.original,
                              calculatedShares: p.split.shares.map((s) => ({
                                  memberId: s.memberId,
                                  amountInCents: s.amountInCents,
                              })),
                          },
                          expectedRecipientMemberId:
                              p.expectedRecipientMemberId,
                          settlementRuleSnapshot: p.settlementRuleSnapshot,
                          settlementRuleSourceVersion:
                              p.settlementRuleSourceVersion,
                      }),
            },
            receipt: income.receipt,
            status: income.receipt ? 'RECEIVED' : 'PENDING',
            receivedAmountInCents: income.receipt ? income.amountInCents : 0,
            obligation: obligation
                ? {
                      id: obligation.id,
                      originCommitmentId: obligation.commitmentId,
                      originReceiptId: obligation.receiptId!,
                      debtorMemberId: obligation.debtorMemberId,
                      creditorMemberId: obligation.creditorMemberId,
                      originalAmountInCents: obligation.originalAmountInCents,
                      remainingAmountInCents: obligation.remainingAmountInCents,
                      status: obligation.status as
                          'OPEN' | 'PARTIALLY_SETTLED' | 'SETTLED',
                      cycleId: obligation.cycleId,
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

    private summaryQuery(spaceId: string) {
        return this.provider
            .get()
            .createQueryBuilder(FinancialCommitmentOrmEntity, 'c')
            .innerJoin(
                FinancialIncomeVersionOrmEntity,
                'v',
                'v.commitment_id = c.id AND v.space_id = c.space_id',
            )
            .leftJoin(
                FinancialReceiptOrmEntity,
                'r',
                'r.commitment_id = c.id AND r.space_id = c.space_id',
            )
            .select('c.id', 'id')
            .addSelect('c.description', 'description')
            .addSelect('v.amount_in_cents', 'amountInCents')
            .addSelect('v.expected_receipt_date::text', 'expectedReceiptDate')
            .addSelect('c.registered_at', 'registeredAt')
            .addSelect('r.id', 'receiptId')
            .where('c.space_id = :spaceId AND c.kind = :kind', {
                spaceId,
                kind: 'INCOME',
            });
    }

    private summaries(
        rows: {
            id: string;
            description: string;
            amountInCents: string;
            expectedReceiptDate: string;
            registeredAt: Date;
            receiptId: string | null;
        }[],
    ): IncomeSummary[] {
        return rows.map((r) => ({
            id: r.id,
            description: r.description,
            amountInCents: Number(r.amountInCents),
            expectedReceiptDate: r.expectedReceiptDate,
            registeredAt: r.registeredAt.toISOString(),
            status: r.receiptId ? 'RECEIVED' : 'PENDING',
            receivedAmountInCents: r.receiptId ? Number(r.amountInCents) : 0,
        }));
    }

    async list(
        spaceId: string,
        status: 'ALL' | 'PENDING' | 'RECEIVED',
        after: { registeredAt: string; id: string } | null,
    ): Promise<IncomeSummary[]> {
        const query = this.summaryQuery(spaceId);
        if (status !== 'ALL')
            query.andWhere(
                status === 'PENDING' ? 'r.id IS NULL' : 'r.id IS NOT NULL',
            );
        if (after)
            query.andWhere(
                '(c.registered_at, c.id) < (:registeredAt, :id)',
                after,
            );
        const rows = await query
            .orderBy('c.registered_at', 'DESC')
            .addOrderBy('c.id', 'DESC')
            .limit(21)
            .getRawMany();
        return this.summaries(rows);
    }

    async upcoming(
        spaceId: string,
        referenceDate: string,
    ): Promise<{ items: IncomeSummary[]; totalCount: number }> {
        const query = this.summaryQuery(spaceId).andWhere(
            'r.id IS NULL AND v.expected_receipt_date >= :referenceDate',
            { referenceDate },
        );
        const totalCount = await query.clone().getCount();
        const rows = await query
            .orderBy('v.expected_receipt_date', 'ASC')
            .addOrderBy('c.id', 'ASC')
            .limit(4)
            .getRawMany();
        return { items: this.summaries(rows), totalCount };
    }
}
