import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { SettlementCycleRepository } from '../../../application/ports/private/shared-expense.repositories.js';
import { SettlementCycle } from '../../../domain/shared-expense/shared-expense.js';
import { SettlementCycleOrmEntity } from '../entities/shared-expense.orm-entity.js';
function transaction(provider: EntityManagerProvider) {
    const manager = provider.get();
    if (!manager.queryRunner?.isTransactionActive)
        throw new Error('Expense writes require a transaction');
    return manager;
}
@Injectable()
export class TypeOrmSettlementCycleRepository implements SettlementCycleRepository {
    constructor(private readonly provider: EntityManagerProvider) {}
    private map(row: SettlementCycleOrmEntity): SettlementCycle {
        return new SettlementCycle(
            row.id,
            row.spaceId,
            row.targetDate,
            row.status as 'OPEN' | 'FINALIZED',
            row.version,
        );
    }
    async lockExisting(
        spaceId: string,
        cycleId: string,
    ): Promise<SettlementCycle | null> {
        const row = await transaction(this.provider).findOne(
            SettlementCycleOrmEntity,
            {
                where: { id: cycleId, spaceId },
                lock: { mode: 'pessimistic_read' },
            },
        );
        return row ? this.map(row) : null;
    }
    async lockForDate(
        spaceId: string,
        targetDate: string,
    ): Promise<SettlementCycle> {
        const m = transaction(this.provider);
        await m.query(
            `INSERT INTO settlement_cycles(id, space_id, target_date, status, version) VALUES ($1,$2,$3,'OPEN',1) ON CONFLICT (space_id,target_date) DO NOTHING`,
            [randomUUID(), spaceId, targetDate],
        );
        const row = await m.findOneOrFail(SettlementCycleOrmEntity, {
            where: { spaceId, targetDate },
            lock: { mode: 'pessimistic_read' },
        });
        const cycle = this.map(row);
        cycle.assertOpen();
        return cycle;
    }
    async listOpen(
        spaceId: string,
        after: { targetDate: string; id: string } | null,
    ): Promise<SettlementCycle[]> {
        const rows = await this.provider
            .get()
            .getRepository(SettlementCycleOrmEntity)
            .createQueryBuilder('c')
            .where('c.space_id = :spaceId AND c.status = :status', {
                spaceId,
                status: 'OPEN',
            })
            .andWhere(
                after ? '(c.target_date, c.id) > (:targetDate, :id)' : 'TRUE',
                after ?? {},
            )
            .orderBy('c.target_date')
            .addOrderBy('c.id')
            .limit(21)
            .getMany();
        return rows.map((row) => this.map(row));
    }
}
