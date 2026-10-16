import type { EntityManager } from 'typeorm';
import { FinancialCommandAuditOrmEntity } from '../entities/financial-command-audit.orm-entity.js';

export async function recordFinancialCommandAudit(
    manager: EntityManager,
    command: {
        actorId: { value: string };
        spaceId: { value: string };
        idempotencyKey: string;
    },
    action: string,
    commitmentId: string,
    registeredAt: string,
): Promise<void> {
    if (!manager.queryRunner?.isTransactionActive)
        throw new Error('Financial audit requires the command transaction');
    // Allowlist only: never persist command bodies, replay responses or secrets.
    await manager.insert(FinancialCommandAuditOrmEntity, {
        actorId: command.actorId.value,
        spaceId: command.spaceId.value,
        action,
        idempotencyKey: command.idempotencyKey,
        commitmentId,
        registeredAt: new Date(registeredAt),
    });
}
