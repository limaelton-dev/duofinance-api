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
import { CommitmentSettlementRule } from '../../domain/settlement-rule/commitment-settlement-rule.js';
import type {
    AdjustmentCommand,
    ConfigureCommitmentSettlementRuleCommand,
    ConfigureCommitmentSettlementRuleResult,
    MoveObligationCommand,
    MoveObligationResult,
} from '../models/settlement-adjustment.js';
import {
    SETTLEMENT_ADJUSTMENT_REPOSITORY,
    SettlementAdjustmentReceiptRaceError,
    type AdjustmentOperation,
    type AdjustmentResult,
    type SettlementAdjustmentRepository,
} from '../ports/private/settlement-adjustment.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import {
    SETTLEMENT_TRANSFER_REPOSITORY,
    type SettlementTransferRepository,
} from '../ports/private/settlement-transfer.repository.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';

@Injectable()
export class SettlementAdjustmentHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(SETTLEMENT_ADJUSTMENT_REPOSITORY)
        private readonly adjustments: SettlementAdjustmentRepository,
        @Inject(SETTLEMENT_TRANSFER_REPOSITORY)
        private readonly obligations: SettlementTransferRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    configure(
        c: ConfigureCommitmentSettlementRuleCommand,
    ): Promise<ConfigureCommitmentSettlementRuleResult> {
        return this.withReceiptRace(
            'CONFIGURE_COMMITMENT_SETTLEMENT_RULE',
            c,
            () =>
                this.uow.execute(async () => {
                    await this.context.read(c.actorId, c.spaceId);
                    const receipt =
                        await this.adjustments.findReceipt<ConfigureCommitmentSettlementRuleResult>(
                            'CONFIGURE_COMMITMENT_SETTLEMENT_RULE',
                            c,
                        );
                    if (receipt) return { ...receipt, replayed: true };
                    const context = await this.context.lockForWrite(
                        c.actorId,
                        c.spaceId,
                    );
                    const concurrent =
                        await this.adjustments.findReceipt<ConfigureCommitmentSettlementRuleResult>(
                            'CONFIGURE_COMMITMENT_SETTLEMENT_RULE',
                            c,
                        );
                    if (concurrent) return { ...concurrent, replayed: true };
                    if (context.version !== c.expectedSpaceVersion)
                        throw new FinancesError('CONCURRENT_MODIFICATION');
                    const commitment = await this.adjustments.commitment(
                        c.spaceId.value,
                        c.commitmentId,
                        true,
                    );
                    const lockedReceipt =
                        await this.adjustments.findReceipt<ConfigureCommitmentSettlementRuleResult>(
                            'CONFIGURE_COMMITMENT_SETTLEMENT_RULE',
                            c,
                        );
                    if (lockedReceipt)
                        return { ...lockedReceipt, replayed: true };
                    if (!commitment)
                        throw new FinancesError(
                            'FINANCIAL_COMMITMENT_NOT_FOUND',
                        );
                    const rule = CommitmentSettlementRule.configure(
                        c.commitmentId,
                        commitment.version,
                        c.expectedCommitmentVersion,
                        c.rule,
                        commitment.specificRuleVersion,
                    );
                    const now = this.clock.now().toISOString(),
                        referenceDate = this.clock.today();
                    await this.adjustments.saveRule(
                        c.spaceId.value,
                        rule,
                        c.actorId.value,
                        now,
                    );
                    const result: ConfigureCommitmentSettlementRuleResult = {
                        spaceId: c.spaceId.value,
                        commitmentId: c.commitmentId,
                        commitmentVersion: rule.commitmentVersion,
                        settlementRule: {
                            source: 'SPECIFIC',
                            rule: rule.rule.snapshot,
                            version: rule.version,
                            referenceDate,
                            suggestedTargetDate:
                                rule.rule.suggestTargetDate(referenceDate),
                        },
                        affectedCycleIds: [],
                        replayed: false,
                    };
                    await this.adjustments.saveReceipt(
                        'CONFIGURE_COMMITMENT_SETTLEMENT_RULE',
                        c,
                        result,
                        now,
                    );
                    return result;
                }),
        );
    }
    move(c: MoveObligationCommand): Promise<MoveObligationResult> {
        return this.withReceiptRace('MOVE_OBLIGATION', c, () =>
            this.uow.execute(async () => {
                await this.context.read(c.actorId, c.spaceId);
                const receipt =
                    await this.adjustments.findReceipt<MoveObligationResult>(
                        'MOVE_OBLIGATION',
                        c,
                    );
                if (receipt) return { ...receipt, replayed: true };
                const context = await this.context.lockForSettlement(
                    c.actorId,
                    c.spaceId,
                );
                const concurrent =
                    await this.adjustments.findReceipt<MoveObligationResult>(
                        'MOVE_OBLIGATION',
                        c,
                    );
                if (concurrent) return { ...concurrent, replayed: true };
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
                    await this.adjustments.findReceipt<MoveObligationResult>(
                        'MOVE_OBLIGATION',
                        c,
                    );
                if (lockedReceipt) return { ...lockedReceipt, replayed: true };
                let destination =
                    c.settlement.mode === 'CYCLE'
                        ? await this.adjustments.cycle(
                              c.spaceId.value,
                              c.settlement.cycleId,
                          )
                        : c.settlement.mode === 'DATE'
                          ? await this.adjustments.cycleForDate(
                                c.spaceId.value,
                                c.settlement.targetDate,
                            )
                          : null;
                if (c.settlement.mode === 'CYCLE' && !destination)
                    throw new FinancesError('SETTLEMENT_CYCLE_NOT_FOUND');
                if (
                    c.settlement.mode === 'DATE' &&
                    civilDate(c.settlement.targetDate) < this.clock.today()
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'settlement.targetDate',
                    ]);
                const existingDestination = destination;
                if (c.settlement.mode === 'DATE' && !destination)
                    destination = await this.adjustments.createCycleForDate(
                        c.spaceId.value,
                        c.settlement.targetDate,
                    );
                const ids = [
                    ...new Set(
                        [discovered.cycleId, destination?.id ?? null].filter(
                            (id): id is string => id !== null,
                        ),
                    ),
                ].sort();
                const locked = await this.adjustments.lockCycles(
                    c.spaceId.value,
                    ids,
                );
                if (locked.some((cycle) => cycle.status !== 'OPEN'))
                    throw new FinancesError('SETTLEMENT_CYCLE_FINALIZED');
                const expectedIds = [
                    ...new Set(
                        [
                            discovered.cycleId,
                            existingDestination?.id ?? null,
                        ].filter((id): id is string => id !== null),
                    ),
                ];
                if (
                    c.expectedCycleVersions.length !== expectedIds.length ||
                    expectedIds.some(
                        (id) =>
                            !c.expectedCycleVersions.some(
                                (v) =>
                                    v.cycleId === id &&
                                    v.version ===
                                        locked.find((cycle) => cycle.id === id)!
                                            .version,
                            ),
                    )
                )
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const [before] = await this.obligations.lockObligations(
                    c.spaceId.value,
                    [c.obligationId],
                );
                if (
                    !before ||
                    before.originCommitmentId !== discovered.commitmentId ||
                    before.cycleId !== discovered.cycleId
                )
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const targetId = destination?.id ?? null;
                const after = before.moveToCycle(
                    targetId,
                    c.expectedObligationVersion,
                );
                const now = this.clock.now().toISOString();
                await this.adjustments.saveAssignment(
                    before,
                    after,
                    c.actorId.value,
                    now,
                );
                const result: MoveObligationResult = {
                    spaceId: c.spaceId.value,
                    obligation: {
                        id: after.id,
                        version: after.version,
                        cycleId: after.cycleId,
                        remainingAmountInCents: after.remainingAmountInCents,
                    },
                    settlementCycle: targetId
                        ? await this.adjustments.cycle(
                              c.spaceId.value,
                              targetId,
                          )
                        : null,
                    affectedCycleIds: [
                        ...new Set(
                            [before.cycleId, after.cycleId].filter(
                                (id): id is string => id !== null,
                            ),
                        ),
                    ].sort(),
                    replayed: false,
                };
                await this.adjustments.saveReceipt(
                    'MOVE_OBLIGATION',
                    c,
                    result,
                    now,
                );
                return result;
            }),
        );
    }
    private async withReceiptRace<T extends AdjustmentResult>(
        operation: AdjustmentOperation,
        c: AdjustmentCommand,
        work: () => Promise<T>,
    ): Promise<T> {
        try {
            return await work();
        } catch (error) {
            if (!(error instanceof SettlementAdjustmentReceiptRaceError))
                throw error;
            return this.uow.execute(async () => {
                await this.context.read(c.actorId, c.spaceId);
                const receipt = await this.adjustments.findReceipt<T>(
                    operation,
                    c,
                );
                if (!receipt) throw error;
                return { ...receipt, replayed: true };
            });
        }
    }
}
