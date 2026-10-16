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
import { IncomeCommitment } from '../../domain/income/income-commitment.js';
import {
    FinancialOccurrence,
    type OccurrenceFact,
} from '../../domain/recurrence/financial-occurrence.js';
import { RecurringCommitment } from '../../domain/recurrence/recurring-commitment.js';
import { RecurrenceRule } from '../../domain/recurrence/recurrence-rule.js';
import { FinancialCommitment } from '../../domain/shared-expense/financial-commitment.js';
import { ResponsibilitySplit } from '../../domain/shared-expense/responsibility-split.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import type { SettlementSelection } from '../../domain/shared-expense/settlement-selection.js';
import type {
    CreateRecurringCommitmentDto,
    SetRecurringValueDto,
    RecurringDisbursementDto,
    RecurringReceiptDto,
    RecurringExternalLiabilityDto,
    RecurringExternalSettlementDto,
} from '../../http/dto/recurring-commitment.dto.js';
import {
    DEFAULT_SETTLEMENT_RULE_REPOSITORY,
    type DefaultSettlementRuleRepository,
} from '../ports/private/default-settlement-rule.repository.js';
import {
    SETTLEMENT_ADJUSTMENT_REPOSITORY,
    type SettlementAdjustmentRepository,
} from '../ports/private/settlement-adjustment.repository.js';
import {
    RECURRING_COMMITMENT_REPOSITORY,
    type RecurringCommitmentRepository,
} from '../ports/private/recurring-commitment.repository.js';
import {
    FINANCES_CLOCK,
    SETTLEMENT_CYCLE_REPOSITORY,
    type FinancesClock,
    type SettlementCycleRepository,
} from '../ports/private/shared-expense.repositories.js';
import { SettlementRule } from '../../domain/settlement-rule/settlement-rule.js';
import { ReconcileFinancialOrigin } from './reconcile-financial-origin.js';

type Base = { actorId: PersonId; spaceId: SpaceId; idempotencyKey: string };
type Create = Base & CreateRecurringCommitmentDto;
type SetValue = Base &
    SetRecurringValueDto & { commitmentId: string; referenceDate: string };
type Fulfillment = Base & { commitmentId: string; referenceDate: string } & (
        | ({ kind: 'DISBURSEMENT' } & RecurringDisbursementDto)
        | ({ kind: 'RECEIPT' } & RecurringReceiptDto)
        | ({ kind: 'EXTERNAL_LIABILITY' } & RecurringExternalLiabilityDto)
        | ({
              kind: 'SETTLE_EXTERNAL_LIABILITY';
              liabilityId: string;
          } & RecurringExternalSettlementDto)
    );

function digest(operation: string, spaceId: string, payload: unknown): Buffer {
    const canonical = (value: unknown): unknown =>
        Array.isArray(value)
            ? value.map(canonical)
            : value && typeof value === 'object'
              ? Object.fromEntries(
                    Object.entries(value)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([k, v]) => [k, canonical(v)]),
                )
              : value;
    return createHash('sha256')
        .update(JSON.stringify([operation, spaceId, canonical(payload)]))
        .digest();
}

function view(
    root: RecurringCommitment,
    occurrence: FinancialOccurrence | null,
    referenceDate: string,
) {
    return {
        id: occurrence?.id ?? null,
        commitmentId: root.id,
        referenceDate,
        economicVersion: occurrence?.economicVersion ?? root.economicVersion,
        stateVersion: occurrence?.stateVersion ?? 1,
        amountInCents: occurrence
            ? occurrence.amountInCents
            : root.valueMode === 'FIXED'
              ? root.amountInCents
              : null,
        expectedAmountInCents: root.amountInCents,
        valuePending:
            root.valueMode === 'VARIABLE' && (occurrence?.valuePending ?? true),
        economicShares:
            occurrence?.amountInCents !== null &&
            occurrence?.amountInCents !== undefined
                ? (root.effectiveSplit(occurrence.amountInCents)?.shares ??
                  null)
                : root.valueMode === 'FIXED'
                  ? root.participation.type === 'SHARED'
                      ? (root.participation.split?.shares ?? null)
                      : null
                  : null,
        valueHistory: occurrence?.valueHistory ?? [],
        status: occurrence?.status ?? 'PENDING',
        fulfilledAmountInCents: occurrence?.fulfilledAmountInCents ?? 0,
        remainingAmountInCents: occurrence
            ? occurrence.remainingAmountInCents
            : root.valueMode === 'FIXED'
              ? root.amountInCents
              : null,
        materializedAt: occurrence?.materializedAt ?? null,
        facts: occurrence?.facts ?? [],
        externalSettlements: occurrence?.externalSettlements ?? [],
    };
}

function rootView(root: RecurringCommitment, today: string) {
    const p = root.participation;
    const nextOccurrenceDate = root.rule.firstOnOrAfter(today);
    return {
        id: root.id,
        spaceId: root.spaceId,
        kind: root.kind,
        modality: root.modality,
        description: root.description,
        valueMode: root.valueMode,
        amountInCents: root.valueMode === 'FIXED' ? root.amountInCents : null,
        expectedAmountInCents: root.amountInCents,
        recurrence: root.rule.pattern,
        startsOn: root.rule.startsOn,
        endsOn: root.rule.endsOn,
        createdByPersonId: root.createdByPersonId,
        registeredAt: root.registeredAt,
        economicVersion: root.economicVersion,
        version: root.version,
        scope: p.type,
        ...(p.type === 'PERSONAL'
            ? { ownerPersonId: p.ownerPersonId }
            : {
                  distribution: p.split
                      ? { ...p.distribution, calculatedShares: p.split.shares }
                      : p.distribution,
                  expectedMemberId: p.expectedMemberId,
                  settlementRuleSnapshot: p.settlementRuleSnapshot,
                  settlementRuleSourceVersion: p.settlementRuleSourceVersion,
              }),
        nextOccurrence: nextOccurrenceDate
            ? {
                  referenceDate: nextOccurrenceDate,
                  amountInCents:
                      root.valueMode === 'FIXED' ? root.amountInCents : null,
                  expectedAmountInCents: root.amountInCents,
              }
            : null,
    };
}

@Injectable()
export class RecurringCommitmentHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(DEFAULT_SETTLEMENT_RULE_REPOSITORY)
        private readonly rules: DefaultSettlementRuleRepository,
        @Inject(RECURRING_COMMITMENT_REPOSITORY)
        private readonly repository: RecurringCommitmentRepository,
        @Inject(SETTLEMENT_ADJUSTMENT_REPOSITORY)
        private readonly adjustments: SettlementAdjustmentRepository,
        @Inject(SETTLEMENT_CYCLE_REPOSITORY)
        private readonly cycles: SettlementCycleRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
        private readonly reconcile: ReconcileFinancialOrigin,
    ) {}

    async create(c: Create) {
        const operation = 'CREATE_RECURRING_COMMITMENT';
        const hash = digest(operation, c.spaceId.value, {
            ...c,
            actorId: undefined,
            spaceId: undefined,
            idempotencyKey: undefined,
        });
        const execute = async () =>
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
                const context =
                    c.scope === 'SHARED'
                        ? await this.context.lockForWrite(c.actorId, c.spaceId)
                        : null;
                if (!context)
                    await this.access.assertCanWrite(c.actorId, c.spaceId);
                if (
                    context &&
                    context.version !==
                        ('expectedSpaceVersion' in c
                            ? c.expectedSpaceVersion
                            : undefined)
                )
                    throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
                const participation =
                    context && c.scope === 'SHARED'
                        ? await (async () => {
                              const ids = context.members.map(
                                  (m) => m.memberId,
                              );
                              if (
                                  c.distribution.shares.length !== ids.length ||
                                  c.distribution.shares.some(
                                      (s) => !ids.includes(s.memberId),
                                  ) ||
                                  (c.expectedMemberId &&
                                      !ids.includes(c.expectedMemberId))
                              )
                                  throw new FinancesError('VALIDATION_ERROR', [
                                      'distribution',
                                  ]);
                              const rule = await this.rules.find(
                                  c.spaceId.value,
                              );
                              return {
                                  type: 'SHARED' as const,
                                  split:
                                      c.valueMode === 'FIXED'
                                          ? ResponsibilitySplit.create(
                                                c.amountInCents,
                                                ids,
                                                c.distribution,
                                            )
                                          : null,
                                  distribution: c.distribution,
                                  expectedMemberId: c.expectedMemberId ?? null,
                                  settlementRuleSnapshot:
                                      rule?.rule.snapshot ?? null,
                                  settlementRuleSourceVersion:
                                      rule?.version ?? 0,
                              };
                          })()
                        : {
                              type: 'PERSONAL' as const,
                              ownerPersonId: c.actorId.value,
                          };
                const now = this.clock.now().toISOString();
                const root = new RecurringCommitment(
                    randomUUID(),
                    c.spaceId.value,
                    c.kind,
                    c.description,
                    c.valueMode === 'FIXED'
                        ? c.amountInCents
                        : (c.expectedAmountInCents ?? null),
                    new RecurrenceRule(
                        c.recurrence,
                        c.startsOn ?? this.clock.today(),
                        c.endsOn ?? null,
                    ),
                    c.actorId.value,
                    now,
                    1,
                    1,
                    participation,
                    c.valueMode,
                );
                await this.repository.save(root);
                const result = {
                    commitment: rootView(root, this.clock.today()),
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

    async detail(actor: PersonId, space: SpaceId, id: string) {
        await this.access.assertCanRead(actor, space);
        const root = await this.repository.find(space.value, id);
        if (!root) throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        await this.access.assertCanRead(actor, space);
        return { commitment: rootView(root, this.clock.today()) };
    }

    async list(
        actor: PersonId,
        space: SpaceId,
        month: string,
        cursor?: string,
    ) {
        await this.access.assertCanRead(actor, space);
        if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month))
            throw new FinancesError('VALIDATION_ERROR', ['month']);
        let after: string | null = null;
        if (cursor)
            try {
                const value = JSON.parse(
                    Buffer.from(cursor, 'base64url').toString('utf8'),
                ) as [string, string, string, string];
                if (
                    !Array.isArray(value) ||
                    value.length !== 4 ||
                    value[0] !== actor.value ||
                    value[1] !== space.value ||
                    value[2] !== month ||
                    !/^[0-9a-f-]{36}$/.test(value[3]) ||
                    Buffer.from(JSON.stringify(value)).toString('base64url') !==
                        cursor
                )
                    throw new Error();
                after = value[3];
            } catch {
                throw new FinancesError('VALIDATION_ERROR', ['cursor']);
            }
        const result = await this.repository.list(space.value, month, after);
        await this.access.assertCanRead(actor, space);
        const items = result.items.slice(0, 20).map((root) => ({
            ...rootView(root, this.clock.today()),
            referenceDate: root.project(month)!.referenceDate,
        }));
        const last = result.items.length > 20 ? items.at(-1) : null;
        return {
            spaceId: space.value,
            month,
            items,
            totalCount: result.totalCount,
            totalAmountInCents: result.totalAmountInCents,
            unknownAmountCount: result.unknownAmountCount,
            nextCursor: last
                ? Buffer.from(
                      JSON.stringify([
                          actor.value,
                          space.value,
                          month,
                          last.id,
                      ]),
                  ).toString('base64url')
                : null,
        };
    }

    async occurrences(
        actor: PersonId,
        space: SpaceId,
        id: string,
        month: string,
    ) {
        await this.access.assertCanRead(actor, space);
        const root = await this.repository.find(space.value, id);
        if (!root) throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const projection = root.project(month);
        const materialized = projection
            ? await this.repository.occurrence(root, projection.referenceDate)
            : null;
        await this.access.assertCanRead(actor, space);
        return {
            commitmentId: id,
            month,
            items: projection
                ? [view(root, materialized, projection.referenceDate)]
                : [],
            totalCount: projection ? 1 : 0,
            totalAmountInCents: projection
                ? String(
                      materialized?.amountInCents ??
                          projection.amountInCents ??
                          0,
                  )
                : '0',
            unknownAmountCount:
                projection &&
                materialized?.amountInCents === undefined &&
                projection.amountInCents === null
                    ? 1
                    : projection &&
                        materialized?.amountInCents === null &&
                        projection.amountInCents === null
                      ? 1
                      : 0,
        };
    }

    async options(
        actor: PersonId,
        space: SpaceId,
        id: string,
        referenceDate: string,
        cursor?: string,
    ) {
        const access = await this.access.assertCanRead(actor, space);
        const root = await this.repository.find(space.value, id);
        if (!root || !root.rule.contains(referenceDate))
            throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const occurrence = await this.repository.occurrence(
            root,
            referenceDate,
        );
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
                    value[3] !== referenceDate
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
            root.participation.type === 'SHARED'
                ? await this.adjustments.effectiveRule(
                      space.value,
                      id,
                      root.participation.settlementRuleSnapshot,
                      root.participation.settlementRuleSourceVersion,
                  )
                : null;
        const cycles = context
            ? await this.cycles.listOpen(space.value, after)
            : [];
        const page = cycles.slice(0, 20),
            last = page.at(-1);
        await this.access.assertCanRead(actor, space);
        return {
            commitment: rootView(root, this.clock.today()),
            occurrence: view(root, occurrence, referenceDate),
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
                              referenceDate,
                              `${last.targetDate}:${last.id}`,
                          ]),
                      ).toString('base64url')
                    : null,
        };
    }

    async setValue(c: SetValue) {
        const operation = 'SET_RECURRING_OCCURRENCE_VALUE';
        const hash = digest(operation, c.spaceId.value, {
            ...c,
            actorId: undefined,
            spaceId: undefined,
            idempotencyKey: undefined,
        });
        const execute = async () =>
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
                if (!root || !root.rule.contains(c.referenceDate))
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                if (root.valueMode !== 'VARIABLE')
                    throw new FinancesError('VALIDATION_ERROR', ['valueMode']);
                if (
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
                const now = this.clock.now().toISOString();
                const existing = await this.repository.occurrence(
                    root,
                    c.referenceDate,
                );
                const occurrence =
                    existing ??
                    new FinancialOccurrence(
                        randomUUID(),
                        root.id,
                        root.spaceId,
                        c.referenceDate,
                        root.economicVersion,
                        1,
                        null,
                        [],
                        now,
                    );
                const next = occurrence.defineValue(
                    c.amountInCents,
                    c.expectedOccurrenceVersion,
                    c.actorId.value,
                    now,
                );
                const shares =
                    root.effectiveSplit(c.amountInCents)?.shares ?? null;
                await this.repository.defineValue(
                    root,
                    next,
                    shares,
                    existing === null,
                );
                const result = {
                    commitment: rootView(root, this.clock.today()),
                    occurrence: view(root, next, c.referenceDate),
                    replayed: false,
                };
                await this.repository.saveReceipt(
                    c.actorId.value,
                    c.spaceId.value,
                    root.id,
                    next.id,
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
                ? 'RECORD_RECURRING_DISBURSEMENT'
                : c.kind === 'RECEIPT'
                  ? 'RECORD_RECURRING_RECEIPT'
                  : c.kind === 'EXTERNAL_LIABILITY'
                    ? 'RECORD_RECURRING_EXTERNAL_LIABILITY'
                    : 'SETTLE_RECURRING_EXTERNAL_LIABILITY';
        const hash = digest(operation, c.spaceId.value, {
            ...c,
            actorId: undefined,
            spaceId: undefined,
            idempotencyKey: undefined,
        });
        const execute = async () =>
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
                    context &&
                    context.version !==
                        ('expectedSpaceVersion' in c
                            ? c.expectedSpaceVersion
                            : undefined)
                )
                    throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
                if ((context !== null) !== 'expectedSpaceVersion' in c)
                    throw new FinancesError('VALIDATION_ERROR', [
                        'expectedSpaceVersion',
                    ]);
                const root = await this.repository.find(
                    c.spaceId.value,
                    c.commitmentId,
                    true,
                );
                if (!root || !root.rule.contains(c.referenceDate))
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                if (
                    (root.participation.type === 'SHARED') !==
                    (context !== null)
                )
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                if (
                    root.kind === 'INCOME'
                        ? c.kind !== 'RECEIPT'
                        : c.kind === 'RECEIPT'
                )
                    throw new FinancesError('VALIDATION_ERROR', ['kind']);
                const replay = await this.repository.findReceipt(
                    c.actorId.value,
                    operation,
                    c.idempotencyKey,
                    hash,
                );
                if (replay) return { ...(replay as object), replayed: true };
                const now = this.clock.now().toISOString(),
                    today = this.clock.today();
                const existing = await this.repository.occurrence(
                    root,
                    c.referenceDate,
                );
                if (c.kind === 'SETTLE_EXTERNAL_LIABILITY') {
                    if (
                        !existing ||
                        existing.stateVersion !== c.expectedOccurrenceVersion
                    )
                        throw new FinancesError('CONCURRENT_MODIFICATION');
                    if (civilDate(c.factDate) > today)
                        throw new FinancesError('VALIDATION_ERROR', [
                            'factDate',
                        ]);
                    const liability = existing.facts.find(
                        (f) =>
                            f.kind === 'EXTERNAL_LIABILITY' &&
                            f.id === c.liabilityId,
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
                        existing,
                        c.liabilityId,
                        c.amountInCents,
                        c.factDate,
                        c.actorId.value,
                        c.idempotencyKey,
                        now,
                    );
                    const updated = await this.repository.occurrence(
                        root,
                        c.referenceDate,
                    );
                    const result = {
                        commitment: rootView(root, today),
                        occurrence: view(root, updated, c.referenceDate),
                        settlement,
                        replayed: false,
                    };
                    await this.repository.saveReceipt(
                        c.actorId.value,
                        c.spaceId.value,
                        root.id,
                        existing.id,
                        operation,
                        c.idempotencyKey,
                        hash,
                        result,
                        now,
                    );
                    return result;
                }
                if (root.version !== c.expectedCommitmentVersion)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const priorOccurrence =
                    existing ??
                    new FinancialOccurrence(
                        randomUUID(),
                        root.id,
                        root.spaceId,
                        c.referenceDate,
                        root.economicVersion,
                        1,
                        root.valueMode === 'FIXED' ? root.amountInCents : null,
                        [],
                        now,
                    );
                if (
                    priorOccurrence.stateVersion !== c.expectedOccurrenceVersion
                )
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const memberId =
                    c.kind === 'DISBURSEMENT'
                        ? 'payerMemberId' in c
                            ? c.payerMemberId
                            : null
                        : c.kind === 'RECEIPT'
                          ? 'recipientMemberId' in c
                              ? c.recipientMemberId
                              : null
                          : 'holderMemberId' in c
                            ? c.holderMemberId
                            : null;
                if (
                    context &&
                    (!memberId ||
                        !context.members.some((m) => m.memberId === memberId))
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
                        : c.kind === 'RECEIPT'
                          ? {
                                ...common,
                                kind: 'RECEIPT',
                                recipientMemberId: context ? memberId : null,
                                recipientPersonId: context
                                    ? null
                                    : c.actorId.value,
                            }
                          : {
                                ...common,
                                kind: 'EXTERNAL_LIABILITY',
                                holderMemberId: context ? memberId : null,
                                holderPersonId: context
                                    ? null
                                    : c.actorId.value,
                                remainingAmountInCents: c.amountInCents,
                            };
                const next = priorOccurrence.record(
                    fact,
                    c.expectedOccurrenceVersion,
                    today,
                );
                await this.repository.record(
                    root,
                    next,
                    fact,
                    existing === null,
                );
                if (context && root.participation.type === 'SHARED') {
                    const synthetic = this.synthetic(root, next, today);
                    await this.reconcile.execute(
                        synthetic,
                        ('settlement' in c
                            ? c.settlement
                            : undefined) as SettlementSelection,
                        c.actorId.value,
                        today,
                        now,
                        next.id,
                    );
                }
                const result = {
                    commitment: rootView(root, today),
                    occurrence: view(root, next, c.referenceDate),
                    replayed: false,
                };
                await this.repository.saveReceipt(
                    c.actorId.value,
                    c.spaceId.value,
                    root.id,
                    next.id,
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
        root: RecurringCommitment,
        occurrence: FinancialOccurrence,
        today: string,
    ) {
        const p = root.participation;
        if (p.type !== 'SHARED')
            throw new FinancesError('SHARED_SPACE_REQUIRED');
        if (root.kind === 'INCOME') {
            const receipts = occurrence.facts.filter(
                (f): f is Extract<OccurrenceFact, { kind: 'RECEIPT' }> =>
                    f.kind === 'RECEIPT',
            );
            return new IncomeCommitment(
                root.id,
                root.spaceId,
                root.description,
                occurrence.amountInCents!,
                occurrence.referenceDate,
                root.createdByPersonId,
                root.registeredAt,
                {
                    type: 'SHARED',
                    split: root.effectiveSplit(occurrence.amountInCents!)!,
                    expectedRecipientMemberId: p.expectedMemberId,
                    settlementRuleSnapshot: p.settlementRuleSnapshot,
                    settlementRuleSourceVersion: p.settlementRuleSourceVersion,
                },
                receipts.map((f) => ({
                    id: f.id,
                    amountInCents: f.amountInCents,
                    factDate: f.factDate,
                    registeredAt: f.registeredAt,
                    recordedByPersonId: f.recordedByPersonId,
                    recipientMemberId: f.recipientMemberId,
                    recipientPersonId: null,
                })),
                occurrence.stateVersion,
            );
        }
        const disbursements = occurrence.facts
            .filter(
                (f): f is Extract<OccurrenceFact, { kind: 'DISBURSEMENT' }> =>
                    f.kind === 'DISBURSEMENT',
            )
            .map((f) => ({
                id: f.id,
                sequence: occurrence.facts.indexOf(f) + 1,
                payerMemberId: f.payerMemberId!,
                method: f.method,
                amountInCents: f.amountInCents,
                factDate: f.factDate,
                registeredAt: f.registeredAt,
                recordedByPersonId: f.recordedByPersonId,
            }));
        const liabilities = occurrence.facts
            .filter(
                (
                    f,
                ): f is Extract<
                    OccurrenceFact,
                    { kind: 'EXTERNAL_LIABILITY' }
                > => f.kind === 'EXTERNAL_LIABILITY',
            )
            .map((f) => ({
                id: f.id,
                sequence: occurrence.facts.indexOf(f) + 1,
                holderMemberId: f.holderMemberId!,
                amountInCents: f.amountInCents,
                remainingAmountInCents: f.amountInCents,
                factDate: f.factDate,
                registeredAt: f.registeredAt,
                recordedByPersonId: f.recordedByPersonId,
            }));
        return new FinancialCommitment(
            root.id,
            root.spaceId,
            root.description,
            root.createdByPersonId,
            root.registeredAt,
            {
                version: 1,
                split: root.effectiveSplit(occurrence.amountInCents!)!,
                expectedPayerMemberId: p.expectedMemberId,
                factDate: null,
                expectedPaymentDate: occurrence.referenceDate,
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
}
