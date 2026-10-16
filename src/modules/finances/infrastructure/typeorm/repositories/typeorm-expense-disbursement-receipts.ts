import { recordFinancialCommandAudit } from './record-financial-command-audit.js';
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { ExpenseDisbursementReceipts } from '../../../application/ports/private/expense-disbursement.ports.js';
import type {
    RecordExpenseDisbursementCommand,
    ExpenseDisbursementResult,
} from '../../../application/models/expense-disbursement.js';
import { ExpenseReceiptRaceError } from '../../../application/ports/private/shared-expense.repositories.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import { FinancialExpenseCommandReceiptOrmEntity } from '../entities/shared-expense.orm-entity.js';
export function disbursementCommandHash(c: RecordExpenseDisbursementCommand) {
    return createHash('sha256')
        .update(
            JSON.stringify([
                'RECORD_EXPENSE_DISBURSEMENT',
                c.spaceId.value,
                c.commitmentId,
                c.amountInCents,
                c.factDate,
                c.method,
                c.expectedCommitmentVersion,
                c.expectedSpaceVersion ?? null,
                c.payerMemberId ?? null,
                c.settlement ?? null,
            ]),
        )
        .digest();
}
@Injectable()
export class TypeOrmExpenseDisbursementReceipts implements ExpenseDisbursementReceipts {
    constructor(private readonly provider: EntityManagerProvider) {}
    async find(
        c: RecordExpenseDisbursementCommand,
    ): Promise<ExpenseDisbursementResult | null> {
        const row = await this.provider
            .get()
            .findOneBy(FinancialExpenseCommandReceiptOrmEntity, {
                actorId: c.actorId.value,
                operation: 'RECORD_EXPENSE_DISBURSEMENT',
                idempotencyKey: c.idempotencyKey,
            });
        if (!row) return null;
        if (!row.requestHash.equals(disbursementCommandHash(c)))
            throw new FinancesError('IDEMPOTENCY_KEY_REUSED');
        return row.result as ExpenseDisbursementResult;
    }
    async save(
        c: RecordExpenseDisbursementCommand,
        result: ExpenseDisbursementResult,
        registeredAt: string,
    ): Promise<void> {
        const m = this.provider.get();
        if (!m.queryRunner?.isTransactionActive)
            throw new Error('Disbursement requires a transaction');
        try {
            await m.insert(FinancialExpenseCommandReceiptOrmEntity, {
                actorId: c.actorId.value,
                operation: 'RECORD_EXPENSE_DISBURSEMENT',
                idempotencyKey: c.idempotencyKey,
                requestHash: disbursementCommandHash(c),
                status: 'COMPLETED',
                commitmentId: result.commitment.id,
                result,
                createdAt: new Date(registeredAt),
            });
        } catch (error) {
            if (
                error instanceof QueryFailedError &&
                error.driverError.code === '23505'
            )
                throw new ExpenseReceiptRaceError();
            throw error;
        }
        await recordFinancialCommandAudit(
            this.provider.get(),
            c,
            'RECORD_EXPENSE_DISBURSEMENT',
            result.commitment.id,
            registeredAt,
        );
    }
}
