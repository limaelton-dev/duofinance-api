import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type {
    RecordPersonalExpenseCommand,
    PersonalExpenseResult,
} from '../../../application/models/personal-expense.js';
import type { PersonalExpenseReceipts } from '../../../application/ports/private/personal-expense.ports.js';
import { ExpenseReceiptRaceError } from '../../../application/ports/private/shared-expense.repositories.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import { FinancialExpenseCommandReceiptOrmEntity } from '../entities/shared-expense.orm-entity.js';
export function personalExpenseCommandHash(
    c: RecordPersonalExpenseCommand,
): Buffer {
    return createHash('sha256')
        .update(
            JSON.stringify([
                'RECORD_PERSONAL_EXPENSE',
                c.spaceId.value.toLowerCase(),
                c.description.trim(),
                c.amountInCents,
                c.factDate,
                c.disbursement.method,
            ]),
        )
        .digest();
}
@Injectable()
export class TypeOrmPersonalExpenseReceipts implements PersonalExpenseReceipts {
    constructor(private readonly provider: EntityManagerProvider) {}
    async find(
        c: RecordPersonalExpenseCommand,
    ): Promise<PersonalExpenseResult | null> {
        const row = await this.provider
            .get()
            .findOneBy(FinancialExpenseCommandReceiptOrmEntity, {
                actorId: c.actorId.value,
                operation: 'RECORD_PERSONAL_EXPENSE',
                idempotencyKey: c.idempotencyKey,
            });
        if (!row) return null;
        if (!row.requestHash.equals(personalExpenseCommandHash(c)))
            throw new FinancesError('IDEMPOTENCY_KEY_REUSED');
        return row.result as PersonalExpenseResult;
    }
    async save(
        c: RecordPersonalExpenseCommand,
        result: PersonalExpenseResult,
        registeredAt: string,
    ): Promise<void> {
        const manager = this.provider.get();
        if (!manager.queryRunner?.isTransactionActive)
            throw new Error('Expense writes require a transaction');
        try {
            await manager.insert(FinancialExpenseCommandReceiptOrmEntity, {
                actorId: c.actorId.value,
                operation: 'RECORD_PERSONAL_EXPENSE',
                idempotencyKey: c.idempotencyKey,
                requestHash: personalExpenseCommandHash(c),
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
    }
}
