import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type {
    CreatePlannedExpenseCommand,
    PlannedExpenseResult,
} from '../../../application/models/planned-expense.js';
import type { PlannedExpenseReceipts } from '../../../application/ports/private/planned-expense.receipts.js';
import { ExpenseReceiptRaceError } from '../../../application/ports/private/shared-expense.repositories.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import { FinancialExpenseCommandReceiptOrmEntity } from '../entities/shared-expense.orm-entity.js';
import { recordFinancialCommandAudit } from './record-financial-command-audit.js';

const operation = 'CREATE_PLANNED_EXPENSE';

function hash(c: CreatePlannedExpenseCommand): Buffer {
    const split =
        c.scope === 'SHARED'
            ? [
                  c.responsibilitySplit.mode,
                  [...c.responsibilitySplit.shares].sort((a, b) =>
                      a.memberId.localeCompare(b.memberId),
                  ),
              ]
            : null;
    return createHash('sha256')
        .update(
            JSON.stringify([
                operation,
                c.spaceId.value,
                c.scope,
                c.description,
                c.amountInCents,
                c.expectedPaymentDate,
                c.scope === 'SHARED' ? c.expectedSpaceVersion : null,
                split,
                c.scope === 'SHARED' ? (c.expectedPayerMemberId ?? null) : null,
            ]),
        )
        .digest();
}

@Injectable()
export class TypeOrmPlannedExpenseReceipts implements PlannedExpenseReceipts {
    constructor(private readonly provider: EntityManagerProvider) {}

    async find(
        c: CreatePlannedExpenseCommand,
    ): Promise<PlannedExpenseResult | null> {
        const row = await this.provider
            .get()
            .findOneBy(FinancialExpenseCommandReceiptOrmEntity, {
                actorId: c.actorId.value,
                operation,
                idempotencyKey: c.idempotencyKey,
            });
        if (!row) return null;
        if (!row.requestHash.equals(hash(c)))
            throw new FinancesError('IDEMPOTENCY_KEY_REUSED');
        return row.result as PlannedExpenseResult;
    }

    async save(
        c: CreatePlannedExpenseCommand,
        result: PlannedExpenseResult,
        registeredAt: string,
    ): Promise<void> {
        const manager = this.provider.get();
        if (!manager.queryRunner?.isTransactionActive)
            throw new Error('Planned expense writes require a transaction');
        try {
            await manager.insert(FinancialExpenseCommandReceiptOrmEntity, {
                actorId: c.actorId.value,
                operation,
                idempotencyKey: c.idempotencyKey,
                requestHash: hash(c),
                status: 'COMPLETED',
                commitmentId: result.commitment.id,
                result,
                createdAt: new Date(registeredAt),
            });
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
        await recordFinancialCommandAudit(
            manager,
            c,
            operation,
            result.commitment.id,
            registeredAt,
        );
    }
}
