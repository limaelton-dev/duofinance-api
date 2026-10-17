import type { EntityManager } from 'typeorm';
import type { FinancialFulfillmentReversal } from '../../../domain/reversals/financial-fulfillment-reversal.js';
import { FinancialFulfillmentReversalOrmEntity } from '../entities/financial-fulfillment-reversal.orm-entity.js';

export async function financialFulfillmentReversals(
    manager: EntityManager,
    spaceId: string,
    commitmentId: string,
    targetId?: string,
): Promise<FinancialFulfillmentReversal[]> {
    const rows = await manager.find(FinancialFulfillmentReversalOrmEntity, {
        where: { spaceId, commitmentId, ...(targetId ? { targetId } : {}) },
        order: { commitmentVersion: 'ASC' },
    });
    return rows.map((row) => ({
        id: row.id,
        spaceId: row.spaceId,
        commitmentId: row.commitmentId,
        targetId: row.targetId,
        occurrenceId: row.occurrenceId,
        installmentId: row.installmentId,
        commitmentVersion: row.commitmentVersion,
        originalKind: row.originalKind,
        originalId: row.originalId,
        amountInCents: row.amountInCents,
        reason: row.reason,
        factDate: row.factDate,
        actorId: row.actorId,
        registeredAt: row.registeredAt.toISOString(),
    }));
}
