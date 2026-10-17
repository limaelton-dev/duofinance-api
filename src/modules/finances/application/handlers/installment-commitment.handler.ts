import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
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
    type InstallmentSelection,
    type InstallmentParticipation,
    type InstallmentResolutionItem,
} from '../../domain/installment/installment-commitment.js';
import {
    Installment,
    InstallmentPlan,
    createInstallmentSchedule,
    type InstallmentAnticipation,
} from '../../domain/installment/installment-plan.js';
import {
    FinancialOccurrence,
    type OccurrenceFact,
} from '../../domain/recurrence/financial-occurrence.js';
import { FinancialCommitment } from '../../domain/shared-expense/financial-commitment.js';
import { ResponsibilitySplit } from '../../domain/shared-expense/responsibility-split.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import type { SettlementSelection } from '../../domain/shared-expense/settlement-selection.js';
import { SettlementRule } from '../../domain/settlement-rule/settlement-rule.js';
import type {
    InstallmentCommitmentDto,
    InstallmentDisbursementDto,
    InstallmentLiabilityDto,
    InstallmentSettlementDto,
    InstallmentAnticipationPreviewDto,
    InstallmentAnticipationDto,
    InstallmentPayoffPreviewDto,
    InstallmentPayoffDto,
    InstallmentCancellationDto,
} from '../../http/dto/installment-commitment.dto.js';
import {
    DEFAULT_SETTLEMENT_RULE_REPOSITORY,
    type DefaultSettlementRuleRepository,
} from '../ports/private/default-settlement-rule.repository.js';
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
    SETTLEMENT_CYCLE_REPOSITORY,
    type FinancesClock,
    type SettlementCycleRepository,
} from '../ports/private/shared-expense.repositories.js';
import { ReconcileFinancialOrigin } from './reconcile-financial-origin.js';

type Base = { actorId: PersonId; spaceId: SpaceId; idempotencyKey: string };
type Create = Base & InstallmentCommitmentDto;
type Fulfillment = Base & { commitmentId: string; installmentId: string } & (
        | ({ kind: 'DISBURSEMENT' } & InstallmentDisbursementDto)
        | ({ kind: 'EXTERNAL_LIABILITY' } & InstallmentLiabilityDto)
        | ({
              kind: 'SETTLE_EXTERNAL_LIABILITY';
              liabilityId: string;
          } & InstallmentSettlementDto)
    );
type Anticipation = Base & {
    commitmentId: string;
} & InstallmentAnticipationDto;
type Payoff = Base & { commitmentId: string } & InstallmentPayoffDto;
type Cancellation = Base & {
    commitmentId: string;
} & InstallmentCancellationDto;

function digest(operation: string, spaceId: string, payload: unknown): Buffer {
    const canonical = (value: unknown): unknown =>
        Array.isArray(value)
            ? value.map(canonical)
            : value && typeof value === 'object'
              ? Object.fromEntries(
                    Object.entries(value)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([key, item]) => [key, canonical(item)]),
                )
              : value;
    return createHash('sha256')
        .update(JSON.stringify([operation, spaceId, canonical(payload)]))
        .digest();
}

function installmentView(
    root: InstallmentCommitment,
    item: Installment,
    occurrence?: FinancialOccurrence | null,
) {
    return {
        id: item.id,
        position: item.position,
        dueDate: item.dueDate,
        amountInCents: item.amountInCents,
        economicShares: root.sharesFor(item.position),
        effectiveAmountInCents: item.effectiveAmountInCents,
        effectiveEconomicShares: root.effectiveSharesFor(item.position),
        anticipation: item.anticipation,
        resolution: item.resolution,
        stateVersion: occurrence?.stateVersion ?? item.stateVersion,
        status: item.status,
        fulfilledAmountInCents: item.fulfilledAmountInCents,
        remainingAmountInCents: item.remainingAmountInCents,
        facts: occurrence?.facts ?? [],
        externalSettlements: occurrence?.externalSettlements ?? [],
    };
}

function rootView(root: InstallmentCommitment) {
    const p = root.participation;
    return {
        id: root.id,
        spaceId: root.spaceId,
        kind: root.kind,
        modality: root.modality,
        description: root.description,
        createdByPersonId: root.createdByPersonId,
        registeredAt: root.registeredAt,
        version: root.version,
        scope: p.type,
        plan: {
            id: root.plan.id,
            count: root.plan.count,
            cadence: root.cadence,
            status: root.plan.status,
            plannedPaymentMethod: root.plannedPaymentMethod,
            totalAmountInCents: root.plan.totalAmountInCents,
            fulfilledAmountInCents: root.plan.installments.reduce(
                (sum, item) => sum + item.fulfilledAmountInCents,
                root.plan.payoff?.paidAmountInCents ?? 0,
            ),
            remainingAmountInCents: root.plan.installments.reduce(
                (sum, item) => sum + item.remainingAmountInCents,
                0,
            ),
            installments: root.plan.installments.map((item) =>
                installmentView(root, item),
            ),
            payoff: root.plan.payoff,
        },
        ...(p.type === 'PERSONAL'
            ? { ownerPersonId: p.ownerPersonId }
            : {
                  distribution: p.distribution,
                  expectedMemberId: p.expectedMemberId,
                  settlementRuleSnapshot: p.settlementRuleSnapshot,
                  settlementRuleSourceVersion: p.settlementRuleSourceVersion,
              }),
    };
}

@Injectable()
export class InstallmentCommitmentHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(DEFAULT_SETTLEMENT_RULE_REPOSITORY)
        private readonly rules: DefaultSettlementRuleRepository,
        @Inject(INSTALLMENT_COMMITMENT_REPOSITORY)
        private readonly repository: InstallmentCommitmentRepository,
        @Inject(SETTLEMENT_ADJUSTMENT_REPOSITORY)
        private readonly adjustments: SettlementAdjustmentRepository,
        @Inject(SETTLEMENT_CYCLE_REPOSITORY)
        private readonly cycles: SettlementCycleRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
        private readonly reconcile: ReconcileFinancialOrigin,
    ) {}

    private schedule(input: InstallmentCommitmentDto) {
        return createInstallmentSchedule(input);
    }

    private async participation(
        input: InstallmentCommitmentDto,
        actorId: PersonId,
        spaceId: SpaceId,
        locked: boolean,
    ) {
        if (input.scope === 'PERSONAL')
            return {
                participation: {
                    type: 'PERSONAL' as const,
                    ownerPersonId: actorId.value,
                },
                expectedSpaceVersion: null,
            };
        const context = locked
            ? await this.context.lockForWrite(actorId, spaceId)
            : await this.context.read(actorId, spaceId);
        if (locked && context.version !== input.expectedSpaceVersion)
            throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
        if (locked && input.expectedRuleVersion === undefined)
            throw new FinancesError('VALIDATION_ERROR', [
                'expectedRuleVersion',
            ]);
        const ids = context.members.map((member) => member.memberId);
        if (
            input.distribution.shares.length !== ids.length ||
            input.distribution.shares.some(
                (share) => !ids.includes(share.memberId),
            ) ||
            (input.expectedMemberId && !ids.includes(input.expectedMemberId))
        )
            throw new FinancesError('VALIDATION_ERROR', ['distribution']);
        const schedule = this.schedule(input);
        const total = schedule.reduce(
            (sum, item) => sum + item.amountInCents,
            0,
        );
        ResponsibilitySplit.create(total, ids, input.distribution);
        const rule = await this.rules.find(spaceId.value);
        if (
            locked &&
            rule?.version !== input.expectedRuleVersion &&
            !(rule === null && input.expectedRuleVersion === 0)
        )
            throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
        const participation: InstallmentParticipation = {
            type: 'SHARED',
            distribution: input.distribution,
            expectedMemberId: input.expectedMemberId ?? null,
            settlementRuleSnapshot: rule?.rule.snapshot ?? null,
            settlementRuleSourceVersion: rule?.version ?? 0,
        };
        return { participation, expectedSpaceVersion: context.version };
    }

    async preview(
        actorId: PersonId,
        spaceId: SpaceId,
        input: InstallmentCommitmentDto,
    ) {
        const access = await this.access.assertCanRead(actorId, spaceId);
        if (access.type !== input.scope)
            throw new FinancesError(
                input.scope === 'PERSONAL'
                    ? 'PERSONAL_SPACE_REQUIRED'
                    : 'SHARED_SPACE_REQUIRED',
            );
        const { participation, expectedSpaceVersion } =
            await this.participation(input, actorId, spaceId, false);
        const schedule = this.schedule(input);
        const id = randomUUID();
        const root = new InstallmentCommitment(
            id,
            spaceId.value,
            input.description,
            actorId.value,
            this.clock.now().toISOString(),
            1,
            new InstallmentPlan(
                randomUUID(),
                id,
                spaceId.value,
                schedule.map(
                    (entry) =>
                        new Installment(
                            randomUUID(),
                            entry.position,
                            entry.dueDate,
                            entry.amountInCents,
                        ),
                ),
            ),
            participation,
            input.cadence ?? 'EXPLICIT',
            input.plannedPaymentMethod ?? null,
        );
        await this.access.assertCanRead(actorId, spaceId);
        return {
            scope: input.scope,
            description: input.description,
            count: root.plan.count,
            cadence: root.cadence,
            plannedPaymentMethod: root.plannedPaymentMethod,
            totalAmountInCents: root.plan.totalAmountInCents,
            installments: root.plan.installments.map((item) => ({
                position: item.position,
                dueDate: item.dueDate,
                amountInCents: item.amountInCents,
                economicShares: root.sharesFor(item.position),
            })),
            ...(participation.type === 'SHARED'
                ? {
                      distribution: participation.distribution,
                      expectedMemberId: participation.expectedMemberId,
                      settlementRuleSnapshot:
                          participation.settlementRuleSnapshot,
                      settlementRuleSourceVersion:
                          participation.settlementRuleSourceVersion,
                      expectedSpaceVersion,
                      expectedRuleVersion:
                          participation.settlementRuleSourceVersion,
                  }
                : { ownerPersonId: actorId.value }),
        };
    }

    async create(c: Create) {
        const operation = 'CREATE_INSTALLMENT_COMMITMENT';
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
                if (access.type !== c.scope)
                    throw new FinancesError(
                        c.scope === 'PERSONAL'
                            ? 'PERSONAL_SPACE_REQUIRED'
                            : 'SHARED_SPACE_REQUIRED',
                    );
                if (c.scope === 'PERSONAL')
                    await this.access.assertCanWrite(c.actorId, c.spaceId);
                const { participation } = await this.participation(
                    c,
                    c.actorId,
                    c.spaceId,
                    true,
                );
                const schedule = this.schedule(c);
                const now = this.clock.now().toISOString();
                const id = randomUUID();
                const root = new InstallmentCommitment(
                    id,
                    c.spaceId.value,
                    c.description,
                    c.actorId.value,
                    now,
                    1,
                    new InstallmentPlan(
                        randomUUID(),
                        id,
                        c.spaceId.value,
                        schedule.map(
                            (entry) =>
                                new Installment(
                                    randomUUID(),
                                    entry.position,
                                    entry.dueDate,
                                    entry.amountInCents,
                                ),
                        ),
                    ),
                    participation,
                    c.cadence ?? 'EXPLICIT',
                    c.plannedPaymentMethod ?? null,
                );
                await this.repository.save(root);
                const result = { commitment: rootView(root), replayed: false };
                await this.repository.saveReceipt(
                    c.actorId.value,
                    c.spaceId.value,
                    id,
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

    async detail(actor: PersonId, space: SpaceId, id: string) {
        await this.access.assertCanRead(actor, space);
        const root = await this.repository.find(space.value, id);
        if (!root) throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        await this.access.assertCanRead(actor, space);
        return { commitment: rootView(root) };
    }

    async list(actor: PersonId, space: SpaceId, cursor?: string) {
        await this.access.assertCanRead(actor, space);
        let after: string | null = null;
        if (cursor)
            try {
                const value = JSON.parse(
                    Buffer.from(cursor, 'base64url').toString('utf8'),
                ) as [string, string, string];
                if (
                    !Array.isArray(value) ||
                    value.length !== 3 ||
                    value[0] !== actor.value ||
                    value[1] !== space.value ||
                    !/^[0-9a-f-]{36}$/.test(value[2]) ||
                    Buffer.from(JSON.stringify(value)).toString('base64url') !==
                        cursor
                )
                    throw new Error();
                after = value[2];
            } catch {
                throw new FinancesError('VALIDATION_ERROR', ['cursor']);
            }
        const result = await this.repository.list(space.value, after);
        await this.access.assertCanRead(actor, space);
        const items = result.items.slice(0, 20).map(rootView);
        const last = result.items.length > 20 ? items.at(-1) : null;
        return {
            spaceId: space.value,
            items,
            totalCount: result.totalCount,
            totalAmountInCents: result.totalAmountInCents,
            nextCursor: last
                ? Buffer.from(
                      JSON.stringify([actor.value, space.value, last.id]),
                  ).toString('base64url')
                : null,
        };
    }

    async installments(actor: PersonId, space: SpaceId, id: string) {
        await this.access.assertCanRead(actor, space);
        const root = await this.repository.find(space.value, id);
        if (!root) throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const items = [];
        for (const installment of root.plan.installments) {
            const occurrence = await this.repository.occurrence(
                root,
                installment.id,
            );
            items.push(installmentView(root, installment, occurrence));
        }
        await this.access.assertCanRead(actor, space);
        return {
            commitmentId: id,
            planId: root.plan.id,
            totalCount: items.length,
            items,
        };
    }

    async options(
        actor: PersonId,
        space: SpaceId,
        id: string,
        installmentId: string,
        cursor?: string,
    ) {
        const access = await this.access.assertCanRead(actor, space);
        const root = await this.repository.find(space.value, id);
        if (
            !root ||
            !root.plan.installments.some((item) => item.id === installmentId)
        )
            throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const occurrence = await this.repository.occurrence(
            root,
            installmentId,
        );
        if (!occurrence)
            throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const p = root.participation;
        const context =
            access.type === 'SHARED'
                ? await this.context.read(actor, space)
                : null;
        let after: { targetDate: string; id: string } | null = null;
        if (cursor)
            try {
                const value = JSON.parse(
                    Buffer.from(cursor, 'base64url').toString('utf8'),
                ) as [string, string, string, string, string];
                if (
                    !Array.isArray(value) ||
                    value.length !== 5 ||
                    value[0] !== actor.value ||
                    value[1] !== space.value ||
                    value[2] !== id ||
                    value[3] !== installmentId
                )
                    throw new Error();
                const [targetDate, cycleId] = value[4].split(':');
                if (
                    !targetDate ||
                    !/^[0-9a-f-]{36}$/.test(cycleId) ||
                    cursor.length > 512 ||
                    Buffer.from(JSON.stringify(value)).toString('base64url') !==
                        cursor
                )
                    throw new Error();
                after = { targetDate: civilDate(targetDate), id: cycleId };
            } catch {
                throw new FinancesError('VALIDATION_ERROR', ['cursor']);
            }
        if (cursor && !context)
            throw new FinancesError('VALIDATION_ERROR', ['cursor']);
        const effective =
            p.type === 'SHARED'
                ? await this.adjustments.effectiveRule(
                      space.value,
                      id,
                      p.settlementRuleSnapshot,
                      p.settlementRuleSourceVersion,
                  )
                : null;
        const cycles = context
            ? await this.cycles.listOpen(space.value, after)
            : [];
        const page = cycles.slice(0, 20),
            last = page.at(-1);
        await this.access.assertCanRead(actor, space);
        return {
            commitment: rootView(root),
            installment: installmentView(
                root,
                root.plan.installments.find(
                    (item) => item.id === installmentId,
                )!,
                occurrence,
            ),
            ...(context
                ? {
                      expectedSpaceVersion: context.version,
                      members: context.members,
                  }
                : {}),
            settlementRule: effective,
            suggestedSettlement: effective?.rule
                ? {
                      referenceDate: this.clock.today(),
                      expectedRuleVersion: effective.version,
                      targetDate: SettlementRule.from(
                          effective.rule,
                      ).suggestTargetDate(this.clock.today()),
                  }
                : null,
            openCycles: page.map((cycle) => ({
                id: cycle.id,
                targetDate: cycle.targetDate,
                version: cycle.version,
            })),
            nextCursor:
                cycles.length > 20 && last
                    ? Buffer.from(
                          JSON.stringify([
                              actor.value,
                              space.value,
                              id,
                              installmentId,
                              `${last.targetDate}:${last.id}`,
                          ]),
                      ).toString('base64url')
                    : null,
        };
    }

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
                            this.synthetic(root, next, today),
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
                        this.syntheticPayoff(root, impact, fact, today),
                        ('settlement' in c
                            ? c.settlement
                            : undefined) as SettlementSelection,
                        c.actorId.value,
                        today,
                        now,
                        null,
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

    async cancelFuture(c: Cancellation) {
        const operation = 'CANCEL_FUTURE_INSTALLMENTS';
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
                if (
                    (context !== null) !==
                    (c.expectedSpaceVersion !== undefined)
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'expectedSpaceVersion',
                    ]);
                if (context && context.version !== c.expectedSpaceVersion)
                    throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
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
                const open = root
                    .resolutionOptions()
                    .filter((item) => item.expectedRemainingAmountInCents > 0);
                const selected = c.installments.map((choice) =>
                    open.find(
                        (item) => item.installmentId === choice.installmentId,
                    ),
                );
                if (
                    new Set(c.installments.map((item) => item.installmentId))
                        .size !== c.installments.length ||
                    selected.some(
                        (item, index) =>
                            !item ||
                            item.expectedInstallmentVersion !==
                                c.installments[index]!
                                    .expectedInstallmentVersion ||
                            item.dueDate <= today,
                    )
                )
                    throw new FinancesError('INSTALLMENT_SELECTION_CHANGED');
                for (const item of selected as InstallmentResolutionItem[]) {
                    const occurrence = await this.repository.occurrence(
                        root,
                        item.installmentId,
                    );
                    if (
                        !occurrence ||
                        occurrence.facts.some(
                            (fact) => fact.kind === 'EXTERNAL_LIABILITY',
                        )
                    )
                        throw new FinancesError('OCCURRENCE_ALREADY_RESOLVED');
                    if (
                        occurrence.facts.some(
                            (fact) => fact.factDate > c.factDate,
                        )
                    )
                        throw new FinancesError('VALIDATION_ERROR', [
                            'factDate',
                        ]);
                }
                const now = this.clock.now().toISOString();
                await this.repository.cancelFuture(
                    root,
                    selected as InstallmentResolutionItem[],
                    c.reason,
                    c.actorId.value,
                    c.factDate,
                    now,
                );
                const updated = (await this.repository.find(
                    root.spaceId,
                    root.id,
                ))!;
                const result = {
                    commitment: rootView(updated),
                    cancelled: selected,
                    reason: c.reason,
                    factDate: c.factDate,
                    actorId: c.actorId.value,
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

    async record(c: Fulfillment) {
        const operation =
            c.kind === 'DISBURSEMENT'
                ? 'RECORD_INSTALLMENT_DISBURSEMENT'
                : c.kind === 'EXTERNAL_LIABILITY'
                  ? 'RECORD_INSTALLMENT_EXTERNAL_LIABILITY'
                  : 'SETTLE_INSTALLMENT_EXTERNAL_LIABILITY';
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
                const root = await this.repository.find(
                    c.spaceId.value,
                    c.commitmentId,
                    true,
                );
                if (
                    !root ||
                    !root.plan.installments.some(
                        (item) => item.id === c.installmentId,
                    ) ||
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
                if (
                    root.plan.installments.find(
                        (item) => item.id === c.installmentId,
                    )?.remainingAmountInCents === 0 &&
                    c.kind !== 'SETTLE_EXTERNAL_LIABILITY'
                )
                    throw new FinancesError('OCCURRENCE_ALREADY_RESOLVED');
                const occurrence = await this.repository.occurrence(
                    root,
                    c.installmentId,
                );
                if (!occurrence)
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                if (occurrence.stateVersion !== c.expectedInstallmentVersion)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const now = this.clock.now().toISOString();
                const today = this.clock.today();
                if (civilDate(c.factDate) > today)
                    throw new FinancesError('VALIDATION_ERROR', ['factDate']);
                if (c.kind === 'SETTLE_EXTERNAL_LIABILITY') {
                    const liability = occurrence.facts.find(
                        (fact) =>
                            fact.kind === 'EXTERNAL_LIABILITY' &&
                            fact.id === c.liabilityId,
                    );
                    if (!liability || liability.kind !== 'EXTERNAL_LIABILITY')
                        throw new FinancesError('EXTERNAL_LIABILITY_NOT_FOUND');
                    if (
                        liability.holderMemberId
                            ? liability.holderMemberId !==
                              context?.actorMemberId
                            : liability.holderPersonId !== c.actorId.value
                    )
                        throw new FinancesError(
                            'EXTERNAL_LIABILITY_HOLDER_REQUIRED',
                        );
                    if (c.amountInCents > liability.remainingAmountInCents)
                        throw new FinancesError('CONCURRENT_MODIFICATION');
                    const settlement = await this.repository.settleExternal(
                        root,
                        occurrence,
                        c.liabilityId,
                        c.amountInCents,
                        c.factDate,
                        c.actorId.value,
                        now,
                    );
                    const updatedRoot = (await this.repository.find(
                        root.spaceId,
                        root.id,
                    ))!;
                    const updated = (await this.repository.occurrence(
                        updatedRoot,
                        c.installmentId,
                    ))!;
                    const result = {
                        commitment: rootView(updatedRoot),
                        installment: installmentView(
                            updatedRoot,
                            updatedRoot.plan.installments.find(
                                (item) => item.id === c.installmentId,
                            )!,
                            updated,
                        ),
                        settlement,
                        replayed: false,
                    };
                    await this.repository.saveReceipt(
                        c.actorId.value,
                        c.spaceId.value,
                        root.id,
                        c.installmentId,
                        operation,
                        c.idempotencyKey,
                        hash,
                        result,
                        now,
                    );
                    return result;
                }
                const memberId =
                    c.kind === 'DISBURSEMENT'
                        ? 'payerMemberId' in c
                            ? c.payerMemberId
                            : null
                        : 'holderMemberId' in c
                          ? c.holderMemberId
                          : null;
                if (
                    context &&
                    (!memberId ||
                        !context.members.some(
                            (member) => member.memberId === memberId,
                        ))
                )
                    throw new FinancesError('VALIDATION_ERROR', ['memberId']);
                const common = {
                    id: randomUUID(),
                    amountInCents: c.amountInCents,
                    factDate: c.factDate,
                    registeredAt: now,
                    recordedByPersonId: c.actorId.value,
                };
                const fact: OccurrenceFact =
                    c.kind === 'DISBURSEMENT'
                        ? {
                              ...common,
                              kind: 'DISBURSEMENT',
                              method: c.method,
                              payerMemberId: context ? memberId : null,
                              payerPersonId: context ? null : c.actorId.value,
                          }
                        : {
                              ...common,
                              kind: 'EXTERNAL_LIABILITY',
                              holderMemberId: context ? memberId : null,
                              holderPersonId: context ? null : c.actorId.value,
                              remainingAmountInCents: c.amountInCents,
                          };
                const next = occurrence.record(
                    fact,
                    c.expectedInstallmentVersion,
                    today,
                );
                await this.repository.record(root, next, fact);
                if (context) {
                    const synthetic = this.synthetic(root, next, today);
                    await this.reconcile.execute(
                        synthetic,
                        ('settlement' in c
                            ? c.settlement
                            : undefined) as SettlementSelection,
                        c.actorId.value,
                        today,
                        now,
                        c.installmentId,
                    );
                }
                const updatedRoot = (await this.repository.find(
                    root.spaceId,
                    root.id,
                ))!;
                const result = {
                    commitment: rootView(updatedRoot),
                    installment: installmentView(
                        updatedRoot,
                        updatedRoot.plan.installments.find(
                            (item) => item.id === c.installmentId,
                        )!,
                        next,
                    ),
                    replayed: false,
                };
                await this.repository.saveReceipt(
                    c.actorId.value,
                    c.spaceId.value,
                    root.id,
                    c.installmentId,
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

    private synthetic(
        root: InstallmentCommitment,
        occurrence: FinancialOccurrence,
        today: string,
    ) {
        const p = root.participation;
        if (p.type !== 'SHARED')
            throw new FinancesError('SHARED_SPACE_REQUIRED');
        const installment = root.plan.installments.find(
            (item) => item.id === occurrence.id,
        )!;
        const shares = root.effectiveSharesFor(installment.position)!;
        const split = ResponsibilitySplit.create(
            installment.effectiveAmountInCents,
            shares.map((share) => share.memberId),
            { mode: 'AMOUNTS', shares: shares.map((share) => ({ ...share })) },
        );
        const disbursements = occurrence.facts
            .filter(
                (
                    fact,
                ): fact is Extract<OccurrenceFact, { kind: 'DISBURSEMENT' }> =>
                    fact.kind === 'DISBURSEMENT',
            )
            .map((fact) => ({
                id: fact.id,
                sequence: occurrence.facts.indexOf(fact) + 1,
                payerMemberId: fact.payerMemberId!,
                method: fact.method,
                amountInCents: fact.amountInCents,
                factDate: fact.factDate,
                registeredAt: fact.registeredAt,
                recordedByPersonId: fact.recordedByPersonId,
            }));
        const liabilities = occurrence.facts
            .filter(
                (
                    fact,
                ): fact is Extract<
                    OccurrenceFact,
                    { kind: 'EXTERNAL_LIABILITY' }
                > => fact.kind === 'EXTERNAL_LIABILITY',
            )
            .map((fact) => ({
                id: fact.id,
                sequence: occurrence.facts.indexOf(fact) + 1,
                holderMemberId: fact.holderMemberId!,
                amountInCents: fact.amountInCents,
                remainingAmountInCents: fact.amountInCents,
                factDate: fact.factDate,
                registeredAt: fact.registeredAt,
                recordedByPersonId: fact.recordedByPersonId,
            }));
        return new FinancialCommitment(
            root.id,
            root.spaceId,
            root.description,
            root.createdByPersonId,
            root.registeredAt,
            {
                version: 1,
                split,
                expectedPayerMemberId: p.expectedMemberId,
                factDate: null,
                expectedPaymentDate: installment.dueDate,
                settlementRuleSnapshot: p.settlementRuleSnapshot,
                settlementRuleSourceVersion: p.settlementRuleSourceVersion,
                suggestedTargetDate: null,
            },
            disbursements,
            today,
            occurrence.stateVersion,
            liabilities,
        );
    }

    private syntheticPayoff(
        root: InstallmentCommitment,
        impact: ReturnType<InstallmentCommitment['payoffImpact']>,
        fact: Extract<OccurrenceFact, { kind: 'DISBURSEMENT' }>,
        today: string,
    ) {
        const p = root.participation;
        if (p.type !== 'SHARED' || !impact.effectiveEconomicShares)
            throw new FinancesError('SHARED_SPACE_REQUIRED');
        const shares = impact.effectiveEconomicShares;
        const split = ResponsibilitySplit.create(
            impact.paidAmountInCents,
            shares.map((share) => share.memberId),
            { mode: 'AMOUNTS', shares: shares.map((share) => ({ ...share })) },
        );
        return new FinancialCommitment(
            root.id,
            root.spaceId,
            root.description,
            root.createdByPersonId,
            root.registeredAt,
            {
                version: 1,
                split,
                expectedPayerMemberId: p.expectedMemberId,
                factDate: null,
                expectedPaymentDate: fact.factDate,
                settlementRuleSnapshot: p.settlementRuleSnapshot,
                settlementRuleSourceVersion: p.settlementRuleSourceVersion,
                suggestedTargetDate: null,
            },
            [
                {
                    id: fact.id,
                    sequence: 1,
                    payerMemberId: fact.payerMemberId!,
                    method: fact.method,
                    amountInCents: fact.amountInCents,
                    factDate: fact.factDate,
                    registeredAt: fact.registeredAt,
                    recordedByPersonId: fact.recordedByPersonId,
                },
            ],
            today,
            root.version + 1,
            [],
        );
    }
}
