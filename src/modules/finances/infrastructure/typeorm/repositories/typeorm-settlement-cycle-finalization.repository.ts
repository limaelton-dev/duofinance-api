import { Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { SettlementCycleFinalizationRepository } from '../../../application/ports/private/settlement-cycle-finalization.repository.js';
import { SettlementCycle } from '../../../domain/shared-expense/settlement-cycle.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import { SettlementCycleOrmEntity } from '../entities/shared-expense.orm-entity.js';
import { SettlementCycleChangeOrmEntity } from '../entities/settlement-cycle-change.orm-entity.js';
@Injectable()
export class TypeOrmSettlementCycleFinalizationRepository implements SettlementCycleFinalizationRepository {
    constructor(private readonly provider: EntityManagerProvider) {}
    private transaction() {
        const m = this.provider.get();
        if (!m.queryRunner?.isTransactionActive)
            throw new Error('Cycle finalization requires a transaction');
        return m;
    }
    async lockCycle(spaceId: string, id: string) {
        const row = await this.transaction().findOne(SettlementCycleOrmEntity, {
            where: { spaceId, id },
            lock: { mode: 'pessimistic_write' },
        });
        return row
            ? new SettlementCycle(
                  row.id,
                  row.spaceId,
                  row.targetDate,
                  row.status as 'OPEN' | 'FINALIZED',
                  row.version,
              )
            : null;
    }
    async hasOpenObligations(spaceId: string, cycleId: string) {
        const rows: { open: boolean }[] = await this.transaction().query(
            `SELECT EXISTS (SELECT 1 FROM inter_member_obligations WHERE space_id=$1 AND cycle_id=$2 AND remaining_amount_in_cents>0) AS open`,
            [spaceId, cycleId],
        );
        return rows[0].open;
    }
    async saveFinalization(
        before: SettlementCycle,
        after: SettlementCycle,
        actorId: string,
        now: string,
    ) {
        const m = this.transaction();
        const changed = await m.update(
            SettlementCycleOrmEntity,
            {
                spaceId: before.spaceId,
                id: before.id,
                status: 'OPEN',
                version: before.version,
            },
            {
                status: after.status,
                version: after.version,
                finalizedAt: new Date(now),
            },
        );
        if (changed.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        await m.insert(SettlementCycleChangeOrmEntity, {
            cycleId: after.id,
            version: after.version,
            spaceId: after.spaceId,
            actorId,
            type: 'FINALIZED',
            snapshot: {
                previousStatus: before.status,
                status: after.status,
                previousVersion: before.version,
                version: after.version,
                targetDate: after.targetDate,
                finalizedAt: now,
            },
            registeredAt: new Date(now),
        });
    }
}
