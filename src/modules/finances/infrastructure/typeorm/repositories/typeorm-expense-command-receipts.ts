import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type {
    RecordSharedCashExpenseCommand,
    SharedCashExpenseResult,
} from '../../../application/models/shared-cash-expense.js';
import type { ExpenseCommandReceipts } from '../../../application/ports/private/shared-expense.repositories.js';
import { ExpenseReceiptRaceError } from '../../../application/ports/private/shared-expense.repositories.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import { FinancialExpenseCommandReceiptOrmEntity } from '../entities/shared-expense.orm-entity.js';
function transaction(provider: EntityManagerProvider) {
    const manager = provider.get();
    if (!manager.queryRunner?.isTransactionActive)
        throw new Error('Expense writes require a transaction');
    return manager;
}
export function expenseCommandHash(c: RecordSharedCashExpenseCommand): Buffer {
    const shares = c.responsibilitySplit.shares
        .map((s) =>
            c.responsibilitySplit.mode === 'AMOUNTS'
                ? [
                      s.memberId.toLowerCase(),
                      (s as { amountInCents: number }).amountInCents,
                  ]
                : [
                      s.memberId.toLowerCase(),
                      (s as { basisPoints: number }).basisPoints,
                  ],
        )
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const settlement = c.settlement;
    const selection =
        settlement.mode === 'SUGGESTED'
            ? [
                  settlement.mode,
                  settlement.referenceDate,
                  settlement.expectedRuleVersion,
              ]
            : settlement.mode === 'DATE'
              ? [settlement.mode, settlement.targetDate]
              : settlement.mode === 'CYCLE'
                ? [settlement.mode, settlement.cycleId.toLowerCase()]
                : [settlement.mode];
    return createHash('sha256')
        .update(
            JSON.stringify([
                'RECORD_SHARED_CASH_EXPENSE',
                c.spaceId.value.toLowerCase(),
                c.expectedSpaceVersion,
                c.description.trim(),
                c.amountInCents,
                c.factDate,
                c.responsibilitySplit.mode,
                shares,
                c.expectedPayerMemberId?.toLowerCase() ?? null,
                c.disbursement.payerMemberId.toLowerCase(),
                c.disbursement.method,
                selection,
            ]),
        )
        .digest();
}
@Injectable()
export class TypeOrmExpenseCommandReceipts implements ExpenseCommandReceipts {
    constructor(private readonly provider: EntityManagerProvider) {}
    async find(
        c: RecordSharedCashExpenseCommand,
    ): Promise<SharedCashExpenseResult | null> {
        const row = await this.provider
            .get()
            .findOneBy(FinancialExpenseCommandReceiptOrmEntity, {
                actorId: c.actorId.value,
                operation: 'RECORD_SHARED_CASH_EXPENSE',
                idempotencyKey: c.idempotencyKey,
            });
        if (!row) return null;
        if (!row.requestHash.equals(expenseCommandHash(c)))
            throw new FinancesError('IDEMPOTENCY_KEY_REUSED');
        return row.result as SharedCashExpenseResult;
    }
    async save(
        c: RecordSharedCashExpenseCommand,
        result: SharedCashExpenseResult,
        registeredAt: string,
    ): Promise<void> {
        try {
            await transaction(this.provider).insert(
                FinancialExpenseCommandReceiptOrmEntity,
                {
                    actorId: c.actorId.value,
                    operation: 'RECORD_SHARED_CASH_EXPENSE',
                    idempotencyKey: c.idempotencyKey,
                    requestHash: expenseCommandHash(c),
                    status: 'COMPLETED',
                    commitmentId: result.commitment.id,
                    result,
                    createdAt: new Date(registeredAt),
                },
            );
        } catch (error) {
            if (
                error instanceof QueryFailedError &&
                error.driverError.code === '23505' &&
                error.driverError.constraint ===
                    'PK_12cb2fc5905ff45de68ddff62a5'
            )
                throw new ExpenseReceiptRaceError();
            throw error;
        }
    }
}
