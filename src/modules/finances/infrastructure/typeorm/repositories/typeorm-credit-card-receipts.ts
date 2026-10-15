import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { CreditCardReceipts } from '../../../application/ports/private/credit-card-receipts.js';
import type {
    CreditCardCommand,
    CreditCardResult,
} from '../../../application/models/credit-card-purchase.js';
import { ExpenseReceiptRaceError } from '../../../application/ports/private/shared-expense.repositories.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import { FinancialExpenseCommandReceiptOrmEntity } from '../entities/shared-expense.orm-entity.js';
function identity(c: CreditCardCommand) {
    const additional = 'commitmentId' in c;
    const operation = additional
        ? 'RECORD_EXTERNAL_LIABILITY'
        : 'RECORD_CREDIT_CARD_PURCHASE';
    const payload = additional
        ? [
              c.commitmentId,
              c.amountInCents,
              c.factDate,
              c.holderMemberId ?? null,
              c.expectedCommitmentVersion,
              c.expectedSpaceVersion ?? null,
              c.settlement ?? null,
          ]
        : [
              c.description,
              c.amountInCents,
              c.factDate,
              c.externalLiability.amountInCents ?? c.amountInCents,
              c.externalLiability.holderMemberId ?? null,
              c.expectedSpaceVersion ?? null,
              c.responsibilitySplit ?? null,
              c.expectedPayerMemberId ?? null,
              c.settlement ?? null,
          ];
    return {
        operation,
        requestHash: createHash('sha256')
            .update(JSON.stringify([operation, c.spaceId.value, ...payload]))
            .digest(),
    };
}
@Injectable()
export class TypeOrmCreditCardReceipts implements CreditCardReceipts {
    constructor(private readonly provider: EntityManagerProvider) {}
    async find(c: CreditCardCommand): Promise<CreditCardResult | null> {
        const { operation, requestHash } = identity(c);
        const row = await this.provider
            .get()
            .findOneBy(FinancialExpenseCommandReceiptOrmEntity, {
                actorId: c.actorId.value,
                operation,
                idempotencyKey: c.idempotencyKey,
            });
        if (!row) return null;
        if (!row.requestHash.equals(requestHash))
            throw new FinancesError('IDEMPOTENCY_KEY_REUSED');
        return row.result as CreditCardResult;
    }
    async save(
        c: CreditCardCommand,
        result: CreditCardResult,
        now: string,
    ): Promise<void> {
        const m = this.provider.get();
        if (!m.queryRunner?.isTransactionActive)
            throw new Error('Credit card writes require a transaction');
        try {
            await m.insert(FinancialExpenseCommandReceiptOrmEntity, {
                actorId: c.actorId.value,
                ...identity(c),
                idempotencyKey: c.idempotencyKey,
                status: 'COMPLETED',
                commitmentId: result.commitment.id,
                result,
                createdAt: new Date(now),
            });
        } catch (error) {
            if (
                error instanceof QueryFailedError &&
                error.driverError.code === '23505'
            )
                throw new ExpenseReceiptRaceError();
            throw error;
        }
    }
}
