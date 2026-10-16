import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
    UNIT_OF_WORK,
    type UnitOfWork,
} from '../../../../shared/application/unit-of-work.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import { ObligationWaiver } from '../../domain/shared-expense/obligation-waiver.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import type {
    WaiveObligationCommand,
    ObligationWaiverResult,
} from '../models/obligation-waiver.js';
import {
    OBLIGATION_WAIVER_REPOSITORY,
    type ObligationWaiverRepository,
} from '../ports/private/obligation-waiver.repository.js';
import {
    SETTLEMENT_ADJUSTMENT_REPOSITORY,
    SettlementAdjustmentReceiptRaceError,
    type SettlementAdjustmentRepository,
} from '../ports/private/settlement-adjustment.repository.js';
import {
    SETTLEMENT_TRANSFER_REPOSITORY,
    type SettlementTransferRepository,
} from '../ports/private/settlement-transfer.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
@Injectable()
export class WaiveObligationHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(OBLIGATION_WAIVER_REPOSITORY)
        private readonly waivers: ObligationWaiverRepository,
        @Inject(SETTLEMENT_ADJUSTMENT_REPOSITORY)
        private readonly adjustments: SettlementAdjustmentRepository,
        @Inject(SETTLEMENT_TRANSFER_REPOSITORY)
        private readonly obligations: SettlementTransferRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    async execute(c: WaiveObligationCommand): Promise<ObligationWaiverResult> {
        try {
            return await this.uow.execute(async () => {
                await this.context.read(c.actorId, c.spaceId);
                const receipt =
                    await this.adjustments.findReceipt<ObligationWaiverResult>(
                        'WAIVE_INTER_MEMBER_OBLIGATION',
                        c,
                    );
                if (receipt) return { ...receipt, replayed: true };
                const context = await this.context.lockForSettlement(
                    c.actorId,
                    c.spaceId,
                );
                if (context.version !== c.expectedSpaceVersion)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const [discovered] = await this.obligations.discover(
                    c.spaceId.value,
                    [c.obligationId],
                );
                if (!discovered)
                    throw new FinancesError(
                        'INTER_MEMBER_OBLIGATION_NOT_FOUND',
                    );
                await this.obligations.lockOrigins(c.spaceId.value, [
                    discovered.commitmentId,
                ]);
                const lockedReceipt =
                    await this.adjustments.findReceipt<ObligationWaiverResult>(
                        'WAIVE_INTER_MEMBER_OBLIGATION',
                        c,
                    );
                if (lockedReceipt) return { ...lockedReceipt, replayed: true };
                if (discovered.cycleId)
                    await this.obligations.lockCycles(c.spaceId.value, [
                        discovered.cycleId,
                    ]);
                const [before] = await this.obligations.lockObligations(
                    c.spaceId.value,
                    [c.obligationId],
                );
                if (
                    !before ||
                    before.cycleId !== discovered.cycleId ||
                    before.originCommitmentId !== discovered.commitmentId
                )
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                if (civilDate(c.factDate) > this.clock.today())
                    throw new FinancesError('VALIDATION_ERROR', ['factDate']);
                const now = this.clock.now().toISOString();
                const waiver = new ObligationWaiver(
                    randomUUID(),
                    before.id,
                    before.creditorMemberId,
                    c.amountInCents,
                    c.factDate,
                    now,
                    c.actorId.value,
                    c.reason ?? null,
                );
                const after = before.waive(
                    waiver,
                    context.actorMemberId,
                    c.expectedObligationVersion,
                );
                await this.waivers.save(waiver, before, after);
                const result: ObligationWaiverResult = {
                    spaceId: c.spaceId.value,
                    waiver: { ...waiver },
                    obligation: {
                        id: after.id,
                        version: after.version,
                        status: after.status,
                        cycleId: after.cycleId,
                        remainingAmountInCents: after.remainingAmountInCents,
                    },
                    affectedCycleIds: after.cycleId ? [after.cycleId] : [],
                    replayed: false,
                };
                await this.adjustments.saveReceipt(
                    'WAIVE_INTER_MEMBER_OBLIGATION',
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
                    await this.adjustments.findReceipt<ObligationWaiverResult>(
                        'WAIVE_INTER_MEMBER_OBLIGATION',
                        c,
                    );
                if (!receipt) throw error;
                return { ...receipt, replayed: true };
            });
        }
    }
}
