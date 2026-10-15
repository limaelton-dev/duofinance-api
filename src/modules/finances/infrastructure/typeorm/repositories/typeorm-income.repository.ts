import { Inject, Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { IncomeRepository } from '../../../application/ports/private/income.ports.js';
import type {
    IncomeSummary,
    IncomeView,
} from '../../../application/models/income.js';
import {
    IncomeCommitment,
    type IncomeReceipt,
} from '../../../domain/income/income-commitment.js';
import { ResponsibilitySplit } from '../../../domain/shared-expense/responsibility-split.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import {
    INTER_MEMBER_OBLIGATION_REPOSITORY,
    type InterMemberObligationRepository,
} from '../../../application/ports/private/shared-expense.repositories.js';
import {
    FinancialCommitmentOrmEntity,
    SettlementCycleOrmEntity,
} from '../entities/shared-expense.orm-entity.js';
import {
    FinancialIncomeVersionOrmEntity,
    FinancialIncomeShareOrmEntity,
    FinancialReceiptOrmEntity,
} from '../entities/income.orm-entity.js';
@Injectable()
export class TypeOrmIncomeRepository implements IncomeRepository {
    constructor(
        private readonly provider: EntityManagerProvider,
        @Inject(INTER_MEMBER_OBLIGATION_REPOSITORY)
        private readonly obligations: InterMemberObligationRepository,
    ) {}
    async save(income: IncomeCommitment): Promise<void> {
        const m = this.provider.get(),
            p = income.participation;
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
        if (p.type === 'SHARED')
            for (const share of p.split.shares)
                await m.insert(FinancialIncomeShareOrmEntity, {
                    commitmentId: income.id,
                    spaceId: income.spaceId,
                    memberId: share.memberId,
                    amountInCents: share.amountInCents,
                });
        for (const [i, receipt] of income.receipts.entries())
            await this.insertReceipt(income, receipt, i + 1);
    }
    private async insertReceipt(
        income: IncomeCommitment,
        receipt: IncomeReceipt,
        sequence: number,
    ) {
        await this.provider.get().insert(FinancialReceiptOrmEntity, {
            ...receipt,
            sequence,
            spaceId: income.spaceId,
            commitmentId: income.id,
            registeredAt: new Date(receipt.registeredAt),
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
                'c.space_id=:spaceId AND c.id=:commitmentId AND c.kind=:kind',
                { spaceId, commitmentId, kind: 'INCOME' },
            );
        if (lock) query.setLock('pessimistic_write');
        const c = await query.getOne();
        if (!c) return null;
        const v = await m.findOneByOrFail(FinancialIncomeVersionOrmEntity, {
            spaceId,
            commitmentId,
        });
        const receipts = await m.find(FinancialReceiptOrmEntity, {
            where: { spaceId, commitmentId },
            order: { sequence: 'ASC' },
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
                          v.splitInput!.shares.map((s) => s.memberId),
                          v.splitInput!,
                      ),
                      expectedRecipientMemberId: v.expectedRecipientMemberId,
                      settlementRuleSnapshot: v.ruleSnapshot,
                      settlementRuleSourceVersion: v.ruleSourceVersion,
                  },
            receipts.map((r) => ({
                id: r.id,
                amountInCents: r.amountInCents,
                factDate: r.factDate,
                registeredAt: r.registeredAt.toISOString(),
                recordedByPersonId: r.recordedByPersonId,
                recipientPersonId: r.recipientPersonId,
                recipientMemberId: r.recipientMemberId,
            })),
            c.version,
        );
    }
    async saveReceipt(
        income: IncomeCommitment,
        expectedVersion: number,
    ): Promise<void> {
        const result = await this.provider.get().update(
            FinancialCommitmentOrmEntity,
            {
                id: income.id,
                spaceId: income.spaceId,
                version: expectedVersion,
                kind: 'INCOME',
            },
            { version: income.version },
        );
        if (result.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        await this.insertReceipt(
            income,
            income.receipts.at(-1)!,
            income.receipts.length,
        );
    }
    async detail(
        spaceId: string,
        commitmentId: string,
    ): Promise<IncomeView | null> {
        const income = await this.find(spaceId, commitmentId);
        if (!income) return null;
        const p = income.participation;
        const obligations = await this.obligations.history(
            spaceId,
            commitmentId,
        );
        const latest = obligations.at(-1);
        const obligation =
            obligations.find((o) => o.remainingAmountInCents > 0) ??
            (latest?.status === 'SETTLED' ? latest : null);
        const cycle = obligation?.cycleId
            ? await this.provider
                  .get()
                  .findOneByOrFail(SettlementCycleOrmEntity, {
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
                                  ...s,
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
            receipts: income.receipts,
            status: income.status,
            receivedAmountInCents: income.receivedAmountInCents,
            remainingAmountInCents: income.remainingAmountInCents,
            obligations,
            obligation,
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
                'v.commitment_id=c.id AND v.space_id=c.space_id',
            )
            .select('c.id', 'id')
            .addSelect('c.description', 'description')
            .addSelect('v.amount_in_cents', 'amountInCents')
            .addSelect('v.expected_receipt_date::text', 'expectedReceiptDate')
            .addSelect('c.registered_at', 'registeredAt')
            .addSelect(
                `COALESCE((SELECT SUM(r.amount_in_cents) FROM financial_receipts r WHERE r.space_id=c.space_id AND r.commitment_id=c.id),0)::text`,
                'received',
            )
            .where('c.space_id=:spaceId AND c.kind=:kind', {
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
            received: string;
        }[],
    ): IncomeSummary[] {
        return rows.map((r) => ({
            id: r.id,
            description: r.description,
            amountInCents: Number(r.amountInCents),
            expectedReceiptDate: r.expectedReceiptDate,
            registeredAt: r.registeredAt.toISOString(),
            receivedAmountInCents: Number(r.received),
            remainingAmountInCents:
                Number(r.amountInCents) - Number(r.received),
            status:
                r.received === '0'
                    ? 'PENDING'
                    : r.received === r.amountInCents
                      ? 'RECEIVED'
                      : 'PARTIALLY_RECEIVED',
        }));
    }
    private readonly remainingSql = `COALESCE((SELECT SUM(r.amount_in_cents) FROM financial_receipts r WHERE r.space_id=c.space_id AND r.commitment_id=c.id),0)<v.amount_in_cents`;
    async list(
        spaceId: string,
        status: 'ALL' | 'PENDING' | 'RECEIVED',
        after: { registeredAt: string; id: string } | null,
    ): Promise<IncomeSummary[]> {
        const query = this.summaryQuery(spaceId);
        if (status !== 'ALL')
            query.andWhere(
                status === 'PENDING'
                    ? this.remainingSql
                    : `NOT (${this.remainingSql})`,
            );
        if (after)
            query.andWhere('(c.registered_at,c.id)<(:registeredAt,:id)', after);
        return this.summaries(
            await query
                .orderBy('c.registered_at', 'DESC')
                .addOrderBy('c.id', 'DESC')
                .limit(21)
                .getRawMany(),
        );
    }
    async upcoming(spaceId: string, referenceDate: string) {
        const query = this.summaryQuery(spaceId).andWhere(
            `${this.remainingSql} AND v.expected_receipt_date>=:referenceDate`,
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
