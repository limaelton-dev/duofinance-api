import { Inject, Injectable } from '@nestjs/common';
import {
    UNIT_OF_WORK,
    type UnitOfWork,
} from '../../../../shared/application/unit-of-work.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import type {
    FinalizeSettlementCycleCommand,
    FinalizeSettlementCycleResult,
} from '../models/settlement-adjustment.js';
import {
    SETTLEMENT_ADJUSTMENT_REPOSITORY,
    SettlementAdjustmentReceiptRaceError,
    type SettlementAdjustmentRepository,
} from '../ports/private/settlement-adjustment.repository.js';
import {
    SETTLEMENT_CYCLE_FINALIZATION_REPOSITORY,
    type SettlementCycleFinalizationRepository,
} from '../ports/private/settlement-cycle-finalization.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
@Injectable()
export class FinalizeSettlementCycleHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(SETTLEMENT_ADJUSTMENT_REPOSITORY)
        private readonly receipts: SettlementAdjustmentRepository,
        @Inject(SETTLEMENT_CYCLE_FINALIZATION_REPOSITORY)
        private readonly cycles: SettlementCycleFinalizationRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    async execute(
        c: FinalizeSettlementCycleCommand,
    ): Promise<FinalizeSettlementCycleResult> {
        try {
            return await this.uow.execute(async () => {
                await this.context.read(c.actorId, c.spaceId);
                const receipt =
                    await this.receipts.findReceipt<FinalizeSettlementCycleResult>(
                        'FINALIZE_SETTLEMENT_CYCLE',
                        c,
                    );
                if (receipt) return { ...receipt, replayed: true };
                const context = await this.context.lockForSettlement(
                    c.actorId,
                    c.spaceId,
                );
                if (context.version !== c.expectedSpaceVersion)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const before = await this.cycles.lockCycle(
                    c.spaceId.value,
                    c.cycleId,
                );
                const lockedReceipt =
                    await this.receipts.findReceipt<FinalizeSettlementCycleResult>(
                        'FINALIZE_SETTLEMENT_CYCLE',
                        c,
                    );
                if (lockedReceipt) return { ...lockedReceipt, replayed: true };
                if (!before)
                    throw new FinancesError('SETTLEMENT_CYCLE_NOT_FOUND');
                const now = this.clock.now().toISOString();
                const after = before.finalize(
                    await this.cycles.hasOpenObligations(
                        c.spaceId.value,
                        c.cycleId,
                    ),
                    c.expectedCycleVersion,
                    now,
                );
                await this.cycles.saveFinalization(
                    before,
                    after,
                    c.actorId.value,
                    now,
                );
                const result: FinalizeSettlementCycleResult = {
                    spaceId: c.spaceId.value,
                    cycle: {
                        id: after.id,
                        targetDate: after.targetDate,
                        status: 'FINALIZED',
                        version: after.version,
                        finalizedAt: now,
                        finalizedByPersonId: c.actorId.value,
                    },
                    affectedCycleIds: [after.id],
                    replayed: false,
                };
                await this.receipts.saveReceipt(
                    'FINALIZE_SETTLEMENT_CYCLE',
                    c,
                    result,
                    now,
                );
                return result;
            });
        } catch (error) {
            if (!(error instanceof SettlementAdjustmentReceiptRaceError))
                throw error;
            return this.uow.execute(async () => {
                await this.context.read(c.actorId, c.spaceId);
                const receipt =
                    await this.receipts.findReceipt<FinalizeSettlementCycleResult>(
                        'FINALIZE_SETTLEMENT_CYCLE',
                        c,
                    );
                if (!receipt) throw error;
                return { ...receipt, replayed: true };
            });
        }
    }
}
