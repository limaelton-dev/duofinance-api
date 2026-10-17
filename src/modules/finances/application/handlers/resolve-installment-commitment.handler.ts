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
import {
    InstallmentCommitment,
    type InstallmentResolutionItem,
} from '../../domain/installment/installment-commitment.js';
import { type OccurrenceFact } from '../../domain/recurrence/financial-occurrence.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import type { SettlementSelection } from '../../domain/shared-expense/settlement-selection.js';
import { SettlementRule } from '../../domain/settlement-rule/settlement-rule.js';
import type { InstallmentPayoffPreviewDto } from '../../http/dto/installment-commitment.dto.js';
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
import { digest, type Payoff } from './installment-commitment.commands.js';
import { rootView } from './installment-commitment.models.js';
import { syntheticPayoff } from './installment-commitment.origin.js';
@Injectable()
export class ResolveInstallmentCommitmentHandler {
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

    async resolutionOptions(
        actor: PersonId,
        space: SpaceId,
        id: string,
        cursor?: string,
    ) {
        const access = await this.access.assertCanRead(actor, space);
        const root = await this.repository.find(space.value, id);
        if (!root) throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        let after = 0;
        if (cursor) {
            try {
                const value = JSON.parse(
                    Buffer.from(cursor, 'base64url').toString('utf8'),
                ) as [string, string, string, number, number];
                if (
                    !Array.isArray(value) ||
                    value.length !== 5 ||
                    value[0] !== actor.value ||
                    value[1] !== space.value ||
                    value[2] !== id ||
                    value[3] !== root.version ||
                    !Number.isSafeInteger(value[4]) ||
                    value[4] < 1 ||
                    cursor.length > 512 ||
                    Buffer.from(JSON.stringify(value)).toString('base64url') !==
                        cursor
                )
                    throw new Error();
                after = value[4];
            } catch {
                throw new FinancesError('VALIDATION_ERROR', ['cursor']);
            }
        }
        const today = this.clock.today();
        const open = root
            .resolutionOptions()
            .filter((item) => item.expectedRemainingAmountInCents > 0);
        const page = open.filter((item) => item.position > after).slice(0, 21);
        const items = [];
        for (const item of page.slice(0, 20)) {
            const occurrence = await this.repository.occurrence(
                root,
                item.installmentId,
            );
            const external =
                occurrence?.facts.some(
                    (fact) => fact.kind === 'EXTERNAL_LIABILITY',
                ) ?? false;
            items.push({
                ...item,
                cancellationEligible: item.dueDate > today && !external,
                blockingReason:
                    item.dueDate <= today
                        ? 'INSTALLMENT_NOT_FUTURE'
                        : external
                          ? 'EXTERNAL_LIABILITY_EXISTS'
                          : null,
            });
        }
        const context =
            access.type === 'SHARED'
                ? await this.context.read(actor, space)
                : null;
        await this.access.assertCanRead(actor, space);
        return {
            commitmentId: id,
            expectedCommitmentVersion: root.version,
            expectedSpaceVersion: context?.version ?? null,
            actorMemberId: context?.actorMemberId ?? null,
            totalOpenCount: open.length,
            totalExpectedRemainingAmountInCents: open
                .reduce(
                    (sum, item) =>
                        sum + BigInt(item.expectedRemainingAmountInCents),
                    0n,
                )
                .toString(),
            items,
            nextCursor:
                page.length > 20
                    ? Buffer.from(
                          JSON.stringify([
                              actor.value,
                              space.value,
                              id,
                              root.version,
                              items.at(-1)!.position,
                          ]),
                      ).toString('base64url')
                    : null,
        };
    }

    async payoffPreview(
        actor: PersonId,
        space: SpaceId,
        id: string,
        input: InstallmentPayoffPreviewDto,
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
        if (!context && (input.payerMemberId || input.settlement))
            throw new FinancesError('VALIDATION_ERROR', ['settlement']);
        if (civilDate(input.factDate) > this.clock.today())
            throw new FinancesError('VALIDATION_ERROR', ['factDate']);
        const impact = root.payoffImpact(
            input.paidAmountInCents,
            context?.actorMemberId ?? null,
        );
        await this.assertResolutionChronology(
            root,
            impact.items,
            input.factDate,
        );
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
            } else if (selection.mode === 'DATE') {
                if (selection.targetDate < this.clock.today())
                    throw new FinancesError('VALIDATION_ERROR', [
                        'settlement.targetDate',
                    ]);
                const cycle = await this.adjustments.cycleForDate(
                    space.value,
                    selection.targetDate,
                );
                if (cycle?.status === 'FINALIZED')
                    throw new FinancesError('SETTLEMENT_CYCLE_FINALIZED');
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
                const date = SettlementRule.from(
                    effective.rule,
                ).suggestTargetDate(this.clock.today());
                const cycle = await this.adjustments.cycleForDate(
                    space.value,
                    date,
                );
                if (cycle?.status === 'FINALIZED')
                    throw new FinancesError('SETTLEMENT_CYCLE_FINALIZED');
            }
        }
        await this.access.assertCanRead(actor, space);
        return {
            commitmentId: id,
            expectedCommitmentVersion: root.version,
            expectedSpaceVersion: context?.version ?? null,
            actorMemberId: context?.actorMemberId ?? null,
            payerMemberId: input.payerMemberId ?? null,
            method: input.method ?? null,
            settlement: input.settlement ?? null,
            factDate: input.factDate,
            ...impact,
            adjustmentPolicy: context
                ? 'DISCOUNT_PROPORTIONAL_SURCHARGE_ACTOR'
                : 'PERSONAL',
        };
    }

    private assertResolutionSelection(
        items: readonly InstallmentResolutionItem[],
        selected: readonly {
            installmentId: string;
            expectedInstallmentVersion: number;
        }[],
    ) {
        if (
            items.length !== selected.length ||
            new Set(selected.map((item) => item.installmentId)).size !==
                selected.length ||
            items.some(
                (item) =>
                    !selected.some(
                        (choice) =>
                            choice.installmentId === item.installmentId &&
                            choice.expectedInstallmentVersion ===
                                item.expectedInstallmentVersion,
                    ),
            )
        )
            throw new FinancesError('INSTALLMENT_SELECTION_CHANGED');
    }

    private async assertResolutionChronology(
        root: InstallmentCommitment,
        items: readonly InstallmentResolutionItem[],
        factDate: string,
    ) {
        for (const item of items) {
            const occurrence = await this.repository.occurrence(
                root,
                item.installmentId,
            );
            if (!occurrence)
                throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
            if (
                [...occurrence.facts, ...occurrence.externalSettlements].some(
                    (fact) => fact.factDate > factDate,
                )
            )
                throw new FinancesError('VALIDATION_ERROR', ['factDate']);
        }
    }

    async payoff(c: Payoff) {
        const operation = 'PAYOFF_INSTALLMENTS';
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
                const root = await this.repository.find(
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
                if (civilDate(c.factDate) > today)
                    throw new FinancesError('VALIDATION_ERROR', ['factDate']);
                const impact = root.payoffImpact(
                    c.paidAmountInCents,
                    context?.actorMemberId ?? null,
                );
                this.assertResolutionSelection(impact.items, c.installments);
                await this.assertResolutionChronology(
                    root,
                    impact.items,
                    c.factDate,
                );
                const now = this.clock.now().toISOString();
                const fact: Extract<OccurrenceFact, { kind: 'DISBURSEMENT' }> =
                    {
                        kind: 'DISBURSEMENT',
                        id: randomUUID(),
                        amountInCents: c.paidAmountInCents,
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
                const payoffId = randomUUID();
                await this.repository.payoff(root, impact, fact, payoffId);
                if (context)
                    await this.reconcile.execute(
                        syntheticPayoff(root, impact, fact, today),
                        ('settlement' in c
                            ? c.settlement
                            : undefined) as SettlementSelection,
                        c.actorId.value,
                        today,
                        now,
                        null,
                        undefined,
                        root.plan.payoffHistory.some(
                            (payoff) => payoff.compensated,
                        ),
                    );
                const updated = (await this.repository.find(
                    root.spaceId,
                    root.id,
                ))!;
                const result = {
                    commitment: rootView(updated),
                    payoffId,
                    fact,
                    items: impact.items,
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
