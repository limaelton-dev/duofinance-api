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
import { SettlementOffset } from '../../domain/settlement-offset/settlement-offset.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import type {
    RecordSettlementOffsetCommand,
    SettlementOffsetResult,
} from '../models/settlement-offset.js';
import {
    SETTLEMENT_OFFSET_REPOSITORY,
    SettlementOffsetReceiptRaceError,
    type SettlementOffsetRepository,
} from '../ports/private/settlement-offset.repository.js';
import {
    SETTLEMENT_TRANSFER_REPOSITORY,
    type SettlementTransferRepository,
} from '../ports/private/settlement-transfer.repository.js';
import {
    SETTLEMENT_ADJUSTMENT_REPOSITORY,
    type SettlementAdjustmentRepository,
} from '../ports/private/settlement-adjustment.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
export function validateOffsetScope(scope: {
    cycleIds: string[];
    obligationIds: string[];
}) {
    const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (
        !scope ||
        !Array.isArray(scope.cycleIds) ||
        !Array.isArray(scope.obligationIds) ||
        scope.cycleIds.length + scope.obligationIds.length === 0 ||
        [scope.cycleIds, scope.obligationIds].some(
            (ids) =>
                ids.length > 50 ||
                new Set(ids).size !== ids.length ||
                ids.some((id) => !uuid.test(id)),
        )
    )
        throw new FinancesError('VALIDATION_ERROR', ['scope']);
}
@Injectable()
export class RecordSettlementOffsetHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(SETTLEMENT_OFFSET_REPOSITORY)
        private readonly offsets: SettlementOffsetRepository,
        @Inject(SETTLEMENT_TRANSFER_REPOSITORY)
        private readonly obligations: SettlementTransferRepository,
        @Inject(SETTLEMENT_ADJUSTMENT_REPOSITORY)
        private readonly adjustments: SettlementAdjustmentRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    async execute(
        c: RecordSettlementOffsetCommand,
    ): Promise<SettlementOffsetResult> {
        validateOffsetScope(c.scope);
        if (
            c.allocations.length < 2 ||
            c.allocations.length > 50 ||
            new Set(c.allocations.map((a) => a.obligationId)).size !==
                c.allocations.length ||
            c.allocations.some(
                (a) =>
                    !Number.isSafeInteger(a.amountInCents) ||
                    a.amountInCents <= 0 ||
                    !Number.isSafeInteger(a.expectedObligationVersion) ||
                    a.expectedObligationVersion < 1,
            )
        )
            throw new FinancesError('VALIDATION_ERROR', ['allocations']);
        try {
            return await this.uow.execute(async () => {
                await this.context.read(c.actorId, c.spaceId);
                const receipt = await this.offsets.findReceipt(c);
                if (receipt) return { ...receipt, replayed: true };
                const context = await this.context.lockForSettlement(
                    c.actorId,
                    c.spaceId,
                );
                if (context.version !== c.expectedSpaceVersion)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                if (civilDate(c.factDate) > this.clock.today())
                    throw new FinancesError('VALIDATION_ERROR', ['factDate']);
                const ids = c.allocations.map((a) => a.obligationId).sort();
                const discovered = await this.obligations.discover(
                    c.spaceId.value,
                    ids,
                );
                if (discovered.length !== ids.length)
                    throw new FinancesError(
                        'INTER_MEMBER_OBLIGATION_NOT_FOUND',
                    );
                await this.obligations.lockOrigins(
                    c.spaceId.value,
                    [...new Set(discovered.map((o) => o.commitmentId))].sort(),
                );
                const lockedReceipt = await this.offsets.findReceipt(c);
                if (lockedReceipt) return { ...lockedReceipt, replayed: true };
                const scopeCycles = await this.offsets.validateScope(
                    c.spaceId.value,
                    c.scope,
                );
                if (
                    discovered.some(
                        (o) =>
                            !c.scope.obligationIds.includes(o.id) &&
                            (o.cycleId === null ||
                                !c.scope.cycleIds.includes(o.cycleId)),
                    )
                )
                    throw new FinancesError('VALIDATION_ERROR', ['scope']);
                const cycleIds = [
                    ...new Set([
                        ...scopeCycles.map((c) => c.id),
                        ...discovered
                            .map((o) => o.cycleId)
                            .filter((id): id is string => id !== null),
                    ]),
                ].sort();
                const cycles = await this.adjustments.lockCycles(
                    c.spaceId.value,
                    cycleIds,
                );
                if (cycles.some((c) => c.status !== 'OPEN'))
                    throw new FinancesError('SETTLEMENT_CYCLE_FINALIZED');
                if (
                    c.expectedCycleVersions.length !== cycleIds.length ||
                    cycleIds.some(
                        (id) =>
                            !c.expectedCycleVersions.some(
                                (v) =>
                                    v.cycleId === id &&
                                    v.version ===
                                        cycles.find((c) => c.id === id)!
                                            .version,
                            ),
                    )
                )
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const before = await this.obligations.lockObligations(
                    c.spaceId.value,
                    ids,
                );
                if (
                    before.length !== ids.length ||
                    before.some(
                        (o) =>
                            o.cycleId !==
                                discovered.find((d) => d.id === o.id)!
                                    .cycleId ||
                            o.originCommitmentId !==
                                discovered.find((d) => d.id === o.id)!
                                    .commitmentId,
                    )
                )
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                if (
                    before.some(
                        (o) =>
                            ![o.debtorMemberId, o.creditorMemberId].every(
                                (id) =>
                                    context.members.some(
                                        (m) => m.memberId === id,
                                    ),
                            ),
                    )
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'allocations',
                    ]);
                const allocations = c.allocations.map((a) => {
                    const o = before.find((o) => o.id === a.obligationId)!;
                    return {
                        id: randomUUID(),
                        obligationId: o.id,
                        cycleId: o.cycleId,
                        debtorMemberId: o.debtorMemberId,
                        creditorMemberId: o.creditorMemberId,
                        amountInCents: a.amountInCents,
                    };
                });
                const offset = new SettlementOffset(
                    randomUUID(),
                    c.spaceId.value,
                    c.factDate,
                    this.clock.now().toISOString(),
                    c.actorId.value,
                    allocations,
                );
                const after = c.allocations.map((a) =>
                    before
                        .find((o) => o.id === a.obligationId)!
                        .applySettlement(
                            allocations.find(
                                (x) => x.obligationId === a.obligationId,
                            )!.id,
                            a.amountInCents,
                            a.expectedObligationVersion,
                        ),
                );
                await this.offsets.save(offset, before, after);
                const result = await this.offsets.detail(
                    c.spaceId.value,
                    offset.id,
                );
                if (!result)
                    throw new Error('Persisted settlement offset missing');
                await this.offsets.saveReceipt(c, result);
                return result;
            });
        } catch (error) {
            if (!(error instanceof SettlementOffsetReceiptRaceError))
                throw error;
            return this.uow.execute(async () => {
                await this.context.read(c.actorId, c.spaceId);
                const receipt = await this.offsets.findReceipt(c);
                if (!receipt) throw error;
                return { ...receipt, replayed: true };
            });
        }
    }
}
