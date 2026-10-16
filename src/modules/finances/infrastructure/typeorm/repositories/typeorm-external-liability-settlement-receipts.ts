import { recordFinancialCommandAudit } from './record-financial-command-audit.js';
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { ExternalLiabilitySettlementReceipts } from '../../../application/ports/private/external-liability-settlement.ports.js';
import type {
    SettleExternalLiabilityCommand,
    ExternalLiabilitySettlementResult,
} from '../../../application/models/external-liability-settlement.js';
import { ExpenseReceiptRaceError } from '../../../application/ports/private/shared-expense.repositories.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import { FinancialExpenseCommandReceiptOrmEntity } from '../entities/shared-expense.orm-entity.js';
export function externalLiabilitySettlementCommandHash(
    c: SettleExternalLiabilityCommand,
) {
    return createHash('sha256')
        .update(
            JSON.stringify([
                'SETTLE_EXTERNAL_LIABILITY',
                c.spaceId.value,
                c.commitmentId,
                c.amountInCents,
                c.factDate,
                c.externalLiabilityId,
                c.expectedCommitmentVersion,
                c.expectedSpaceVersion ?? null,
            ]),
        )
        .digest();
}
@Injectable()
export class TypeOrmExternalLiabilitySettlementReceipts implements ExternalLiabilitySettlementReceipts {
    constructor(private readonly provider: EntityManagerProvider) {}
    async find(
        c: SettleExternalLiabilityCommand,
    ): Promise<ExternalLiabilitySettlementResult | null> {
        const row = await this.provider
            .get()
            .findOneBy(FinancialExpenseCommandReceiptOrmEntity, {
                actorId: c.actorId.value,
                operation: 'SETTLE_EXTERNAL_LIABILITY',
                idempotencyKey: c.idempotencyKey,
            });
        if (!row) return null;
        if (!row.requestHash.equals(externalLiabilitySettlementCommandHash(c)))
            throw new FinancesError('IDEMPOTENCY_KEY_REUSED');
        return row.result as ExternalLiabilitySettlementResult;
    }
    async save(
        c: SettleExternalLiabilityCommand,
        result: ExternalLiabilitySettlementResult,
        registeredAt: string,
    ): Promise<void> {
        const m = this.provider.get();
        if (!m.queryRunner?.isTransactionActive)
            throw new Error('Disbursement requires a transaction');
        try {
            await m.insert(FinancialExpenseCommandReceiptOrmEntity, {
                actorId: c.actorId.value,
                operation: 'SETTLE_EXTERNAL_LIABILITY',
                idempotencyKey: c.idempotencyKey,
                requestHash: externalLiabilitySettlementCommandHash(c),
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
            'SETTLE_EXTERNAL_LIABILITY',
            result.commitment.id,
            registeredAt,
        );
    }
}
