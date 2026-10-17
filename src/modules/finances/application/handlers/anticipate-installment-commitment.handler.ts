import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import {
    UNIT_OF_WORK,
    type UnitOfWork,
} from '../../../../shared/application/unit-of-work.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../../spaces/application/ports/public/space-access.port.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import { type InstallmentSelection } from '../../domain/installment/installment-commitment.js';
import { type InstallmentAnticipation } from '../../domain/installment/installment-plan.js';
import {
    FinancialOccurrence,
    type OccurrenceFact,
} from '../../domain/recurrence/financial-occurrence.js';
import type { SettlementSelection } from '../../domain/shared-expense/settlement-selection.js';
import { SettlementRule } from '../../domain/settlement-rule/settlement-rule.js';
import type { InstallmentAnticipationPreviewDto } from '../../http/dto/installment-commitment.dto.js';
import {
    SETTLEMENT_ADJUSTMENT_REPOSITORY,
    type SettlementAdjustmentRepository,
} from '../ports/private/settlement-adjustment.repository.js';
import {
    INSTALLMENT_COMMITMENT_REPOSITORY,
    type InstallmentCommitmentRepository,
} from '../ports/private/installment-commitment.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import { ReconcileFinancialOrigin } from './reconcile-financial-origin.js';
import {
    digest,
    type Anticipation,
} from './installment-commitment.commands.js';
import { rootView, installmentView } from './installment-commitment.models.js';
import { synthetic } from './installment-commitment.origin.js';
@Injectable()
export class AnticipateInstallmentCommitmentHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(INSTALLMENT_COMMITMENT_REPOSITORY)
        private readonly repository: InstallmentCommitmentRepository,
        @Inject(SETTLEMENT_ADJUSTMENT_REPOSITORY)
        private readonly adjustments: SettlementAdjustmentRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
        private readonly reconcile: ReconcileFinancialOrigin,
    ) {}

    async anticipationOptions(
        actor: PersonId,
        space: SpaceId,
        id: string,
        cursor?: string,
    ) {
        const access = await this.access.assertCanRead(actor, space);
        const root = await this.repository.find(space.value, id);
        if (!root) throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const today = this.clock.today();
        let after: number | null = null;
        if (cursor)
            try {
                const value = JSON.parse(
                    Buffer.from(cursor, 'base64url').toString('utf8'),
                ) as [string, string, string, string, number, number];
                if (
                    !Array.isArray(value) ||
                    value.length !== 6 ||
                    value[0] !== actor.value ||
                    value[1] !== space.value ||
                    value[2] !== id ||
                    value[3] !== today ||
                    value[4] !== root.version ||
                    !Number.isSafeInteger(value[5]) ||
                    value[5] < 1 ||
                    cursor.length > 512 ||
                    Buffer.from(JSON.stringify(value)).toString('base64url') !==
                        cursor
                )
                    throw new Error();
                after = value[5];
            } catch {
                throw new FinancesError('VALIDATION_ERROR', ['cursor']);
            }
        const future = root.plan.installments
            .filter((item) => item.dueDate > today)
            .reverse();
        const page = future
            .filter((item) => after === null || item.position < after)
            .slice(0, 21);
        const items = page.slice(0, 20).map((item) => ({
            ...installmentView(root, item),
            selectionEligible: item.remainingAmountInCents > 0,
            blockingReason:
                item.remainingAmountInCents > 0
                    ? null
                    : 'INSTALLMENT_ALREADY_FULFILLED',
        }));
        const last = items.at(-1);
        const context =
            access.type === 'SHARED'
                ? await this.context.read(actor, space)
                : null;
        await this.access.assertCanRead(actor, space);
        return {
            commitmentId: id,
            expectedCommitmentVersion: root.version,
            ...(context
                ? {
                      expectedSpaceVersion: context.version,
                      actorMemberId: context.actorMemberId,
                  }
                : {}),
            totalEligibleCount: future.filter(
                (item) => item.remainingAmountInCents > 0,
            ).length,
            totalFutureCount: future.length,
            items,
            nextCursor:
                page.length > 20 && last
                    ? Buffer.from(
                          JSON.stringify([
                              actor.value,
                              space.value,
                              id,
                              today,
                              root.version,
                              last.position,
                          ]),
                      ).toString('base64url')
                    : null,
        };
    }

    async anticipationPreview(
        actor: PersonId,
        space: SpaceId,
        id: string,
        input: InstallmentAnticipationPreviewDto,
    ) {
        const access = await this.access.assertCanRead(actor, space);
        const root = await this.repository.find(space.value, id);
        if (!root) throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        if (
            input.expectedCommitmentVersion !== undefined &&
            input.expectedCommitmentVersion !== root.version
        )
            throw new FinancesError('CONCURRENT_MODIFICATION');
        const context =
            access.type === 'SHARED'
                ? await this.context.read(actor, space)
                : null;
        if ((context !== null) !== (root.participation.type === 'SHARED'))
            throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        if (
            context &&
            input.expectedSpaceVersion !== undefined &&
            input.expectedSpaceVersion !== context.version
        )
            throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
        if (
            context &&
            input.payerMemberId &&
            !context.members.some(
                (member) => member.memberId === input.payerMemberId,
            )
        )
            throw new FinancesError('VALIDATION_ERROR', ['payerMemberId']);
        const items = root.selectForAnticipation(
            input.selection as InstallmentSelection,
            input.values ?? null,
            input.factDate,
            this.clock.today(),
            context?.actorMemberId ?? null,
        );
        if (!context && (input.payerMemberId || input.settlement))
            throw new FinancesError('VALIDATION_ERROR', ['settlement']);
        let settlementTargetDate: string | null = null;
        if (context && input.settlement) {
            const selection = input.settlement;
            if (selection.mode === 'CYCLE') {
                const cycle = await this.adjustments.cycle(
                    space.value,
                    selection.cycleId,
                );
                if (!cycle)
                    throw new FinancesError('SETTLEMENT_CYCLE_NOT_FOUND');
                if (cycle.status !== 'OPEN')
                    throw new FinancesError('SETTLEMENT_CYCLE_FINALIZED');
                settlementTargetDate = cycle.targetDate;
            } else if (selection.mode === 'DATE') {
                if (selection.targetDate < this.clock.today())
                    throw new FinancesError('VALIDATION_ERROR', [
                        'settlement.targetDate',
                    ]);
                settlementTargetDate = selection.targetDate;
            } else if (selection.mode === 'SUGGESTED') {
                const p = root.participation;
                if (p.type !== 'SHARED')
                    throw new FinancesError('VALIDATION_ERROR');
                const effective = await this.adjustments.effectiveRule(
                    space.value,
                    id,
                    p.settlementRuleSnapshot,
                    p.settlementRuleSourceVersion,
                );
                if (
                    !effective.rule ||
                    selection.referenceDate !== this.clock.today() ||
                    selection.expectedRuleVersion !== effective.version
                )
                    throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
                settlementTargetDate = SettlementRule.from(
                    effective.rule,
                ).suggestTargetDate(this.clock.today());
            }
            if (selection.mode !== 'CYCLE' && settlementTargetDate) {
                const cycle = await this.adjustments.cycleForDate(
                    space.value,
                    settlementTargetDate,
                );
                if (cycle?.status === 'FINALIZED')
                    throw new FinancesError('SETTLEMENT_CYCLE_FINALIZED');
            }
        }
        await this.access.assertCanRead(actor, space);
        return {
            commitmentId: id,
            selection: input.selection,
            factDate: input.factDate,
            expectedCommitmentVersion: root.version,
            ...(context
                ? {
                      expectedSpaceVersion: context.version,
                      actorMemberId: context.actorMemberId,
                  }
                : {}),
            payerMemberId: input.payerMemberId ?? null,
            method: input.method ?? null,
            settlement: input.settlement ?? null,
            settlementTargetDate,
            adjustmentPolicy:
                context === null
                    ? 'PERSONAL'
                    : 'DISCOUNT_PROPORTIONAL_SURCHARGE_ACTOR',
            items,
            totalExpectedRemainingAmountInCents: items
                .reduce(
                    (sum, item) =>
                        sum + BigInt(item.expectedRemainingAmountInCents),
                    0n,
                )
                .toString(),
            totalPaidAmountInCents: items
                .reduce((sum, item) => sum + BigInt(item.paidAmountInCents), 0n)
                .toString(),
            totalAdjustmentInCents: items
                .reduce((sum, item) => sum + BigInt(item.adjustmentInCents), 0n)
                .toString(),
        };
    }

    async anticipate(c: Anticipation) {
        const operation = 'ANTICIPATE_INSTALLMENTS';
        const hash = digest(operation, c.spaceId.value, {
            ...c,
            actorId: undefined,
            spaceId: undefined,
            idempotencyKey: undefined,
        });
        const execute = () =>
            this.uow.execute(async () => {
                const access = await this.access.assertCanRead(
                    c.actorId,
                    c.spaceId,
                );
                const prior = await this.repository.findReceipt(
                    c.actorId.value,
                    operation,
                    c.idempotencyKey,
                    hash,
                );
                if (prior) return { ...(prior as object), replayed: true };
                const context =
                    access.type === 'SHARED'
                        ? await this.context.lockForFulfillment(
                              c.actorId,
                              c.spaceId,
                          )
                        : null;
                if (!context)
                    await this.access.assertCanWrite(c.actorId, c.spaceId);
                if ((context !== null) !== 'expectedSpaceVersion' in c)
                    throw new FinancesError('VALIDATION_ERROR', [
                        'expectedSpaceVersion',
                    ]);
                if (
                    context &&
                    context.version !==
                        ('expectedSpaceVersion' in c
                            ? c.expectedSpaceVersion
                            : undefined)
                )
                    throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
                if (
                    context &&
                    (!('payerMemberId' in c) ||
                        !context.members.some(
                            (member) => member.memberId === c.payerMemberId,
                        ))
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'payerMemberId',
                    ]);
                let root = await this.repository.find(
                    c.spaceId.value,
                    c.commitmentId,
                    true,
                );
                if (
                    !root ||
                    (root.participation.type === 'SHARED') !==
                        (context !== null)
                )
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                const replay = await this.repository.findReceipt(
                    c.actorId.value,
                    operation,
                    c.idempotencyKey,
                    hash,
                );
                if (replay) return { ...(replay as object), replayed: true };
                if (root.version !== c.expectedCommitmentVersion)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const today = this.clock.today();
                const plan = root.selectForAnticipation(
                    c.selection as InstallmentSelection,
                    c.values,
                    c.factDate,
                    today,
                    context?.actorMemberId ?? null,
                );
                const now = this.clock.now().toISOString();
                const applied = [];
                for (const selected of plan) {
                    const occurrence = await this.repository.occurrence(
                        root,
                        selected.installmentId,
                    );
                    if (
                        !occurrence ||
                        occurrence.stateVersion !==
                            selected.expectedInstallmentVersion ||
                        occurrence.remainingAmountInCents !==
                            selected.expectedRemainingAmountInCents
                    )
                        throw new FinancesError(
                            'INSTALLMENT_SELECTION_CHANGED',
                        );
                    const fact: OccurrenceFact = {
                        kind: 'DISBURSEMENT',
                        id: randomUUID(),
                        amountInCents: selected.paidAmountInCents,
                        factDate: c.factDate,
                        registeredAt: now,
                        recordedByPersonId: c.actorId.value,
                        payerMemberId:
                            context && 'payerMemberId' in c
                                ? c.payerMemberId
                                : null,
                        payerPersonId: context ? null : c.actorId.value,
                        method: c.method,
                    };
                    const next = new FinancialOccurrence(
                        occurrence.id,
                        occurrence.commitmentId,
                        occurrence.spaceId,
                        occurrence.referenceDate,
                        occurrence.economicVersion,
                        occurrence.stateVersion + 1,
                        selected.effectiveAmountInCents,
                        [...occurrence.facts, fact],
                        occurrence.materializedAt,
                        'FULFILLED',
                        occurrence.externalSettlements,
                        occurrence.valueHistory,
                        occurrence.cancellation,
                        occurrence.adjustments,
                        selected.effectiveEconomicShares,
                        occurrence.reversals,
                    );
                    const anticipation: InstallmentAnticipation = {
                        id: randomUUID(),
                        factId: fact.id,
                        factDate: c.factDate,
                        registeredAt: now,
                        actorId: c.actorId.value,
                        expectedRemainingAmountInCents:
                            selected.expectedRemainingAmountInCents,
                        paidAmountInCents: selected.paidAmountInCents,
                        adjustmentInCents: selected.adjustmentInCents,
                        economicShares: selected.effectiveEconomicShares,
                    };
                    await this.repository.record(
                        root,
                        next,
                        fact,
                        anticipation,
                    );
                    root = (await this.repository.find(root.spaceId, root.id))!;
                    if (context) {
                        await this.reconcile.execute(
                            synthetic(root, next, today),
                            ('settlement' in c
                                ? c.settlement
                                : undefined) as SettlementSelection,
                            c.actorId.value,
                            today,
                            now,
                            selected.installmentId,
                        );
                    }
                    applied.push({
                        installmentId: selected.installmentId,
                        position: selected.position,
                        dueDate: selected.dueDate,
                        expectedRemainingAmountInCents:
                            selected.expectedRemainingAmountInCents,
                        paidAmountInCents: selected.paidAmountInCents,
                        adjustmentInCents: selected.adjustmentInCents,
                        effectiveAmountInCents: selected.effectiveAmountInCents,
                        fact,
                        anticipationId: anticipation.id,
                        effectiveEconomicShares:
                            selected.effectiveEconomicShares,
                    });
                }
                const result = {
                    commitment: rootView(root),
                    items: applied,
                    replayed: false,
                };
                await this.repository.saveReceipt(
                    c.actorId.value,
                    c.spaceId.value,
                    root.id,
                    null,
                    operation,
                    c.idempotencyKey,
                    hash,
                    result,
                    now,
                );
                return result;
            });
        try {
            return await execute();
        } catch (error) {
            if (
                !(error instanceof QueryFailedError) ||
                error.driverError.code !== '23505'
            )
                throw error;
            return this.uow.execute(async () => {
                await this.access.assertCanRead(c.actorId, c.spaceId);
                const prior = await this.repository.findReceipt(
                    c.actorId.value,
                    operation,
                    c.idempotencyKey,
                    hash,
                );
                if (!prior) throw error;
                return { ...(prior as object), replayed: true };
            });
        }
    }
}
