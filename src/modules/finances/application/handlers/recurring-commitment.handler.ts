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
    ChangeRecurringCommitmentDto,
    TerminateRecurringCommitmentDto,
    CancelRecurringOccurrenceDto,
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
                ? (occurrence.economicShares ??
                  root.effectiveSplit(occurrence.amountInCents)?.shares ??
                  null)
                : root.valueMode === 'FIXED'
                  ? root.participation.type === 'SHARED'
                      ? (root.participation.split?.shares ?? null)
                      : null
                  : null,
        valueHistory: occurrence?.valueHistory ?? [],
        ...(occurrence?.adjustments.length
            ? {
                  adjustments: occurrence.adjustments,
                  originalAmountInCents:
                      occurrence.adjustments[0].previousAmountInCents,
              }
            : {}),
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
        cancellation: occurrence?.cancellation ?? null,
    };
}

function rootView(root: RecurringCommitment, today: string) {
    const displayed =
        root.effectiveVersionAt(today) ??
        root.versions[0]?.configuration ??
        root;
    const p = displayed.participation;
    const next = Array.from({ length: 13 }, (_, i) => {
        const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() + i);
        return root.projections(d.toISOString().slice(0, 7));
    })
        .flat()
        .find((projected) => projected.referenceDate >= today);
    const nextConfiguration = next
        ? root.configurationAt(next.referenceDate)
        : null;
    return {
        id: root.id,
        spaceId: root.spaceId,
        kind: root.kind,
        modality: root.modality,
        description: displayed.description,
        valueMode: displayed.valueMode,
        amountInCents:
            displayed.valueMode === 'FIXED' ? displayed.amountInCents : null,
        expectedAmountInCents: displayed.amountInCents,
        recurrence: displayed.rule.pattern,
        startsOn: displayed.rule.startsOn,
        endsOn: displayed.rule.endsOn,
        createdByPersonId: root.createdByPersonId,
        registeredAt: root.registeredAt,
        economicVersion: root.economicVersion,
        currentEconomicVersion:
            root.effectiveVersionAt(today)?.economicVersion ?? null,
        effectiveFrom: root.effectiveFrom,
        terminatedOn: root.terminatedOn,
        versions: (root.versions.length
            ? root.versions
            : [{ effectiveFrom: root.effectiveFrom, configuration: root }]
        ).map((v) => ({
            version: v.configuration.economicVersion,
            effectiveFrom: v.effectiveFrom,
            description: v.configuration.description,
            valueMode: v.configuration.valueMode,
            amountInCents:
                v.configuration.valueMode === 'FIXED'
                    ? v.configuration.amountInCents
                    : null,
            expectedAmountInCents: v.configuration.amountInCents,
            recurrence: v.configuration.rule.pattern,
            endsOn: v.configuration.rule.endsOn,
        })),
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
        nextOccurrence:
            next && nextConfiguration
                ? {
                      referenceDate: next.referenceDate,
                      economicVersion: nextConfiguration.economicVersion,
                      amountInCents:
                          nextConfiguration.valueMode === 'FIXED'
                              ? nextConfiguration.amountInCents
                              : null,
                      expectedAmountInCents: nextConfiguration.amountInCents,
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
        const items = result.items.slice(0, 20).map((row) => ({
            ...rootView(row.commitment, this.clock.today()),
            referenceDate: row.referenceDate,
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
        const materialized = await this.repository.occurrencesInMonth(
            root,
            month,
        );
        const projections = materialized.length ? [] : root.projections(month);
        const dates = [
            ...new Set([
                ...projections.map((p) => p.referenceDate),
                ...materialized.map((o) => o.referenceDate),
            ]),
        ].sort();
        const items = dates.map((date) => {
            const occurrence =
                materialized.find((o) => o.referenceDate === date) ?? null;
            const config = occurrence
                ? root.configurationForVersion(occurrence.economicVersion)
                : root.projectedConfigurationAt(date);
            return view(config!, occurrence, date);
        });
        const active = items.filter((item) => item.status !== 'CANCELLED');
        await this.access.assertCanRead(actor, space);
        return {
            commitmentId: id,
            month,
            items,
            totalCount: active.length,
            totalAmountInCents: active
                .reduce((n, item) => n + BigInt(item.amountInCents ?? 0), 0n)
                .toString(),
            unknownAmountCount: active.filter(
                (item) => item.amountInCents === null,
            ).length,
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
        if (!root) throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const occurrence = await this.repository.occurrence(
            root,
            referenceDate,
        );
        if (
            !occurrence &&
            (
                await this.repository.occurrencesInMonth(
                    root,
                    referenceDate.slice(0, 7),
                )
            ).length
        )
            throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const configuration = occurrence
            ? root.configurationForVersion(occurrence.economicVersion)
            : root.projectedConfigurationAt(referenceDate);
        if (!configuration)
            throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
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
            configuration.participation.type === 'SHARED'
                ? await this.adjustments.effectiveRule(
                      space.value,
                      id,
                      configuration.participation.settlementRuleSnapshot,
                      configuration.participation.settlementRuleSourceVersion,
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
            occurrence: view(configuration, occurrence, referenceDate),
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

    private async candidate(
        c: ChangeRecurringCommitmentDto,
        root: RecurringCommitment,
        memberIds: string[] | null,
    ) {
        const today = this.clock.today();
        if (root.version !== c.expectedCommitmentVersion)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        if (root.terminatedOn)
            throw new FinancesError('RECURRENCE_ALREADY_TERMINATED');
        if (c.effectiveFrom <= today || c.effectiveFrom <= root.effectiveFrom)
            throw new FinancesError('VALIDATION_ERROR', ['effectiveFrom']);
        if (root.kind !== c.kind || root.participation.type !== c.scope)
            throw new FinancesError('VALIDATION_ERROR', ['kind', 'scope']);
        let participation: RecurringCommitment['participation'];
        if (c.scope === 'PERSONAL') {
            participation = {
                type: 'PERSONAL',
                ownerPersonId: root.createdByPersonId,
            };
        } else {
            if (
                !memberIds ||
                c.distribution.shares.length !== memberIds.length ||
                c.distribution.shares.some(
                    (share) => !memberIds.includes(share.memberId),
                ) ||
                (c.expectedMemberId && !memberIds.includes(c.expectedMemberId))
            )
                throw new FinancesError('VALIDATION_ERROR', ['distribution']);
            const rule = await this.rules.find(root.spaceId);
            participation = {
                type: 'SHARED',
                split:
                    c.valueMode === 'FIXED'
                        ? ResponsibilitySplit.create(
                              c.amountInCents,
                              memberIds,
                              c.distribution,
                          )
                        : null,
                distribution: c.distribution,
                expectedMemberId: c.expectedMemberId ?? null,
                settlementRuleSnapshot: rule?.rule.snapshot ?? null,
                settlementRuleSourceVersion: rule?.version ?? 0,
            };
        }
        return new RecurringCommitment(
            root.id,
            root.spaceId,
            root.kind,
            c.description,
            c.valueMode === 'FIXED'
                ? c.amountInCents
                : (c.expectedAmountInCents ?? null),
            new RecurrenceRule(c.recurrence, c.effectiveFrom, c.endsOn ?? null),
            root.createdByPersonId,
            this.clock.now().toISOString(),
            root.economicVersion + 1,
            root.version + 1,
            participation,
            c.valueMode,
            c.effectiveFrom,
        );
    }

    private withCandidate(
        root: RecurringCommitment,
        candidate: RecurringCommitment,
    ) {
        const existing = root.versions.length
            ? root.versions
            : [{ effectiveFrom: root.effectiveFrom, configuration: root }];
        return new RecurringCommitment(
            candidate.id,
            candidate.spaceId,
            candidate.kind,
            candidate.description,
            candidate.amountInCents,
            candidate.rule,
            candidate.createdByPersonId,
            candidate.registeredAt,
            candidate.economicVersion,
            candidate.version,
            candidate.participation,
            candidate.valueMode,
            candidate.effectiveFrom,
            [
                ...existing,
                {
                    effectiveFrom: candidate.effectiveFrom,
                    configuration: candidate,
                },
            ],
        );
    }

    private async changeImpact(
        root: RecurringCommitment,
        candidate: RecurringCommitment,
        actorMemberId: string | null,
    ) {
        const proposed = this.withCandidate(root, candidate);
        const start = new Date(
            `${candidate.effectiveFrom.slice(0, 7)}-01T00:00:00Z`,
        );
        const allMaterialized = await this.repository.materializedAfter(
            root,
            candidate.effectiveFrom.slice(0, 7) + '-01',
        );
        const materializedMonths = new Set(
            allMaterialized.map((item) => item.referenceDate.slice(0, 7)),
        );
        const before: {
            referenceDate: string;
            configuration: RecurringCommitment;
        }[] = [];
        const after: {
            referenceDate: string;
            configuration: RecurringCommitment;
        }[] = [];
        for (let i = 0; i < 25; i += 1) {
            const month = new Date(
                Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1),
            )
                .toISOString()
                .slice(0, 7);
            for (const p of materializedMonths.has(month)
                ? []
                : root.projections(month))
                if (p.referenceDate >= candidate.effectiveFrom)
                    before.push({
                        referenceDate: p.referenceDate,
                        configuration: root.configurationAt(p.referenceDate)!,
                    });
            for (const p of materializedMonths.has(month)
                ? []
                : proposed.projections(month))
                if (p.referenceDate >= candidate.effectiveFrom)
                    after.push({
                        referenceDate: p.referenceDate,
                        configuration: proposed.configurationAt(
                            p.referenceDate,
                        )!,
                    });
        }
        const totals = (items: typeof before) => {
            const rows = new Map<
                string,
                { fixed: bigint; variableWeight: number; occurrences: number }
            >();
            for (const item of items) {
                const p = item.configuration.participation;
                if (p.type !== 'SHARED') continue;
                for (const share of p.distribution.shares) {
                    const row = rows.get(share.memberId) ?? {
                        fixed: 0n,
                        variableWeight: 0,
                        occurrences: 0,
                    };
                    if (item.configuration.valueMode === 'FIXED')
                        row.fixed += BigInt(
                            item.configuration
                                .effectiveSplit(
                                    item.configuration.amountInCents!,
                                )!
                                .shares.find(
                                    (s) => s.memberId === share.memberId,
                                )!.amountInCents,
                        );
                    else if ('basisPoints' in share)
                        row.variableWeight += share.basisPoints;
                    row.occurrences += 1;
                    rows.set(share.memberId, row);
                }
            }
            return rows;
        };
        const previous = totals(before),
            next = totals(after);
        const ids = [...new Set([...previous.keys(), ...next.keys()])].sort();
        const impactByMember = ids.map((memberId) => {
            const a = previous.get(memberId) ?? {
                fixed: 0n,
                variableWeight: 0,
                occurrences: 0,
            };
            const b = next.get(memberId) ?? {
                fixed: 0n,
                variableWeight: 0,
                occurrences: 0,
            };
            const fixedDelta = b.fixed - a.fixed;
            const variableDelta = b.variableWeight - a.variableWeight;
            const uncertain =
                (a.fixed > 0n && b.variableWeight > 0) ||
                (a.variableWeight > 0 && b.fixed > 0n);
            const monthlyOnerous = [
                ...new Set(
                    [...before, ...after].map((item) =>
                        item.referenceDate.slice(0, 7),
                    ),
                ),
            ].some((month) => {
                const prior = before.find((item) =>
                    item.referenceDate.startsWith(month),
                )?.configuration;
                const proposed = after.find((item) =>
                    item.referenceDate.startsWith(month),
                )?.configuration;
                const exposure = (
                    configuration: RecurringCommitment | undefined,
                ) => {
                    if (
                        !configuration ||
                        configuration.participation.type !== 'SHARED'
                    )
                        return { amount: 0, numerator: 0n, denominator: 1n };
                    const participation = configuration.participation;
                    const amount =
                        configuration.valueMode === 'FIXED'
                            ? (configuration
                                  .effectiveSplit(configuration.amountInCents!)!
                                  .shares.find(
                                      (share) => share.memberId === memberId,
                                  )?.amountInCents ?? 0)
                            : 0;
                    const share = participation.distribution.shares.find(
                        (share) => share.memberId === memberId,
                    );
                    const numerator = BigInt(
                        share
                            ? 'basisPoints' in share
                                ? share.basisPoints
                                : share.amountInCents
                            : 0,
                    );
                    const denominator = BigInt(
                        share && 'basisPoints' in share
                            ? 10000
                            : (configuration.amountInCents ?? 1),
                    );
                    return { amount, numerator, denominator };
                };
                const p = exposure(prior),
                    n = exposure(proposed);
                return root.kind === 'EXPENSE'
                    ? n.amount > p.amount ||
                          n.numerator * p.denominator >
                              p.numerator * n.denominator
                    : n.amount < p.amount ||
                          n.numerator * p.denominator <
                              p.numerator * n.denominator;
            });
            const onerous =
                memberId !== actorMemberId &&
                (root.kind === 'EXPENSE'
                    ? fixedDelta > 0n ||
                      variableDelta > 0 ||
                      uncertain ||
                      monthlyOnerous
                    : fixedDelta < 0n ||
                      variableDelta < 0 ||
                      uncertain ||
                      monthlyOnerous);
            return {
                memberId,
                currentFixedAmountInCents: a.fixed.toString(),
                proposedFixedAmountInCents: b.fixed.toString(),
                fixedDeltaInCents: fixedDelta.toString(),
                currentVariableWeight: a.variableWeight,
                proposedVariableWeight: b.variableWeight,
                variableWeightDelta: variableDelta,
                currentOccurrenceCount: a.occurrences,
                proposedOccurrenceCount: b.occurrences,
                requiresAcceptance: onerous,
            };
        });
        const materialized = allMaterialized.filter(
            (item) => item.referenceDate >= candidate.effectiveFrom,
        );
        return {
            effectiveFrom: candidate.effectiveFrom,
            assessmentThrough: new Date(
                Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 25, 0),
            )
                .toISOString()
                .slice(0, 10),
            currentVersion: root.economicVersion,
            proposedVersion: candidate.economicVersion,
            currentOccurrences: before.map((item) => item.referenceDate),
            proposedOccurrences: after.map((item) => item.referenceDate),
            impactByMember,
            requiresAcceptance: impactByMember.some(
                (row) => row.requiresAcceptance,
            ),
            materializedOccurrencesPreserved: materialized,
        };
    }

    async changePreview(
        actor: PersonId,
        space: SpaceId,
        id: string,
        input: ChangeRecurringCommitmentDto,
    ) {
        const access = await this.access.assertCanRead(actor, space);
        const root = await this.repository.find(space.value, id);
        if (!root) throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const context =
            access.type === 'SHARED'
                ? await this.context.read(actor, space)
                : null;
        if ((context !== null) !== 'expectedSpaceVersion' in input)
            throw new FinancesError('VALIDATION_ERROR', [
                'expectedSpaceVersion',
            ]);
        if (
            context &&
            context.version !==
                ('expectedSpaceVersion' in input
                    ? input.expectedSpaceVersion
                    : undefined)
        )
            throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
        const candidate = await this.candidate(
            input,
            root,
            context?.members.map((m) => m.memberId) ?? null,
        );
        const impact = await this.changeImpact(
            root,
            candidate,
            context?.actorMemberId ?? null,
        );
        await this.access.assertCanRead(actor, space);
        return { commitmentId: id, ...impact };
    }

    private async mutation<T extends object>(
        operation: string,
        c: Base & { commitmentId: string },
        work: (hash: Buffer) => Promise<T>,
    ) {
        const hash = digest(operation, c.spaceId.value, {
            ...c,
            actorId: undefined,
            spaceId: undefined,
            idempotencyKey: undefined,
        });
        const execute = () =>
            this.uow.execute(async () => {
                await this.access.assertCanRead(c.actorId, c.spaceId);
                const prior = await this.repository.findReceipt(
                    c.actorId.value,
                    operation,
                    c.idempotencyKey,
                    hash,
                );
                if (prior)
                    return { ...(prior as object), replayed: true } as T & {
                        replayed: boolean;
                    };
                return work(hash);
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
                return { ...(prior as object), replayed: true } as T & {
                    replayed: boolean;
                };
            });
        }
    }

    changeVersion(
        c: Base & { commitmentId: string } & ChangeRecurringCommitmentDto,
    ) {
        return this.mutation('CHANGE_RECURRING_COMMITMENT', c, async (hash) => {
            const access = await this.access.assertCanRead(
                c.actorId,
                c.spaceId,
            );
            if (access.type === 'SHARED')
                await this.context.lockForWrite(c.actorId, c.spaceId);
            else await this.access.assertCanWrite(c.actorId, c.spaceId);
            const replay = await this.repository.findReceipt(
                c.actorId.value,
                'CHANGE_RECURRING_COMMITMENT',
                c.idempotencyKey,
                hash,
            );
            if (replay) return { ...(replay as object), replayed: true };
            const result = await this.applyVersion(c);
            await this.repository.saveReceipt(
                c.actorId.value,
                c.spaceId.value,
                c.commitmentId,
                null,
                'CHANGE_RECURRING_COMMITMENT',
                c.idempotencyKey,
                hash,
                result,
                this.clock.now().toISOString(),
            );
            return result;
        });
    }

    async applyVersion(
        c: Base & { commitmentId: string } & ChangeRecurringCommitmentDto,
        acceptance?: { proposedByMemberId: string; acceptedByMemberId: string },
    ) {
        const access = await this.access.assertCanRead(c.actorId, c.spaceId);
        const context =
            access.type === 'SHARED'
                ? await this.context.lockForWrite(c.actorId, c.spaceId)
                : null;
        if (!context) await this.access.assertCanWrite(c.actorId, c.spaceId);
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
        if (!root) throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const candidate = await this.candidate(
            c,
            root,
            context?.members.map((m) => m.memberId) ?? null,
        );
        const impact = await this.changeImpact(
            root,
            candidate,
            acceptance?.proposedByMemberId ?? context?.actorMemberId ?? null,
        );
        if (
            impact.requiresAcceptance &&
            (!acceptance ||
                acceptance.acceptedByMemberId !== context?.actorMemberId ||
                impact.impactByMember.some(
                    (member) =>
                        member.requiresAcceptance &&
                        member.memberId !== acceptance.acceptedByMemberId,
                ))
        )
            throw new FinancesError('RECURRENCE_ACCEPTANCE_REQUIRED');
        await this.repository.saveVersion(root, candidate, c.effectiveFrom);
        const result = {
            commitment: rootView(
                this.withCandidate(root, candidate),
                this.clock.today(),
            ),
            impact,
            replayed: false,
        };
        return result;
    }

    async terminationPreview(
        actor: PersonId,
        space: SpaceId,
        id: string,
        input: TerminateRecurringCommitmentDto,
    ) {
        const access = await this.access.assertCanRead(actor, space);
        const context =
            access.type === 'SHARED'
                ? await this.context.read(actor, space)
                : null;
        if ((context !== null) !== (input.expectedSpaceVersion !== undefined))
            throw new FinancesError('VALIDATION_ERROR', [
                'expectedSpaceVersion',
            ]);
        if (context && context.version !== input.expectedSpaceVersion)
            throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
        const root = await this.repository.find(space.value, id);
        if (!root) throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        if (root.version !== input.expectedCommitmentVersion)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        if (root.terminatedOn)
            throw new FinancesError('RECURRENCE_ALREADY_TERMINATED');
        if (input.endsOn < this.clock.today())
            throw new FinancesError('VALIDATION_ERROR', ['endsOn']);
        const next = new Date(`${input.endsOn}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        const preserved = await this.repository.materializedAfter(
            root,
            next.toISOString().slice(0, 10),
        );
        await this.access.assertCanRead(actor, space);
        return {
            commitmentId: id,
            currentVersion: root.version,
            endsOn: input.endsOn,
            materializedOccurrencesPreserved: preserved,
        };
    }

    terminate(
        c: Base & { commitmentId: string } & TerminateRecurringCommitmentDto,
    ) {
        return this.mutation(
            'TERMINATE_RECURRING_COMMITMENT',
            c,
            async (hash) => {
                const access = await this.access.assertCanRead(
                    c.actorId,
                    c.spaceId,
                );
                const context =
                    access.type === 'SHARED'
                        ? await this.context.lockForWrite(c.actorId, c.spaceId)
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
                if (!root)
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                if (root.version !== c.expectedCommitmentVersion)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                if (root.terminatedOn)
                    throw new FinancesError('RECURRENCE_ALREADY_TERMINATED');
                if (c.endsOn < this.clock.today())
                    throw new FinancesError('VALIDATION_ERROR', ['endsOn']);
                const firstAfter = new Date(`${c.endsOn}T00:00:00Z`);
                firstAfter.setUTCDate(firstAfter.getUTCDate() + 1);
                const preserved = await this.repository.materializedAfter(
                    root,
                    firstAfter.toISOString().slice(0, 10),
                );
                const now = this.clock.now().toISOString();
                await this.repository.terminate(
                    root,
                    c.endsOn,
                    c.actorId.value,
                    now,
                );
                const latest = new RecurringCommitment(
                    root.id,
                    root.spaceId,
                    root.kind,
                    root.description,
                    root.amountInCents,
                    root.rule,
                    root.createdByPersonId,
                    root.registeredAt,
                    root.economicVersion,
                    root.version + 1,
                    root.participation,
                    root.valueMode,
                    root.effectiveFrom,
                    root.versions,
                    c.endsOn,
                );
                const result = {
                    commitment: rootView(latest, this.clock.today()),
                    materializedOccurrencesPreserved: preserved,
                    replayed: false,
                };
                await this.repository.saveReceipt(
                    c.actorId.value,
                    c.spaceId.value,
                    root.id,
                    null,
                    'TERMINATE_RECURRING_COMMITMENT',
                    c.idempotencyKey,
                    hash,
                    result,
                    now,
                );
                return result;
            },
        );
    }

    cancelOccurrence(
        c: Base & {
            commitmentId: string;
            referenceDate: string;
        } & CancelRecurringOccurrenceDto,
    ) {
        return this.mutation('CANCEL_RECURRING_OCCURRENCE', c, async (hash) => {
            const access = await this.access.assertCanRead(
                c.actorId,
                c.spaceId,
            );
            const context =
                access.type === 'SHARED'
                    ? await this.context.lockForWrite(c.actorId, c.spaceId)
                    : null;
            if (!context)
                await this.access.assertCanWrite(c.actorId, c.spaceId);
            if ((context !== null) !== (c.expectedSpaceVersion !== undefined))
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
            if (!root)
                throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
            if (root.version !== c.expectedCommitmentVersion)
                throw new FinancesError('CONCURRENT_MODIFICATION');
            const existing = await this.repository.occurrence(
                root,
                c.referenceDate,
            );
            if (
                !existing &&
                (
                    await this.repository.occurrencesInMonth(
                        root,
                        c.referenceDate.slice(0, 7),
                    )
                ).length
            )
                throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
            const configuration = existing
                ? root.configurationForVersion(existing.economicVersion)
                : root.projectedConfigurationAt(c.referenceDate);
            if (!configuration)
                throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
            const now = this.clock.now().toISOString();
            const pending =
                existing ??
                new FinancialOccurrence(
                    randomUUID(),
                    root.id,
                    root.spaceId,
                    c.referenceDate,
                    configuration.economicVersion,
                    1,
                    configuration.valueMode === 'FIXED'
                        ? configuration.amountInCents
                        : null,
                    [],
                    now,
                );
            const canceled = pending.cancel(
                c.expectedOccurrenceVersion,
                c.actorId.value,
                now,
            );
            await this.repository.cancel(root, canceled, existing === null);
            const result = {
                commitment: rootView(root, this.clock.today()),
                occurrence: view(configuration, canceled, c.referenceDate),
                replayed: false,
            };
            await this.repository.saveReceipt(
                c.actorId.value,
                c.spaceId.value,
                root.id,
                canceled.id,
                'CANCEL_RECURRING_OCCURRENCE',
                c.idempotencyKey,
                hash,
                result,
                now,
            );
            return result;
        });
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
                if (!root)
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
                if (
                    !existing &&
                    (
                        await this.repository.occurrencesInMonth(
                            root,
                            c.referenceDate.slice(0, 7),
                        )
                    ).length
                )
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                const configuration = existing
                    ? root.configurationForVersion(existing.economicVersion)
                    : root.projectedConfigurationAt(c.referenceDate);
                if (!configuration)
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                if (configuration.valueMode !== 'VARIABLE')
                    throw new FinancesError('VALIDATION_ERROR', ['valueMode']);
                if (
                    (configuration.participation.type === 'SHARED') !==
                    (context !== null)
                )
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                const occurrence =
                    existing ??
                    new FinancialOccurrence(
                        randomUUID(),
                        root.id,
                        root.spaceId,
                        c.referenceDate,
                        configuration.economicVersion,
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
                    configuration.effectiveSplit(c.amountInCents)?.shares ??
                    null;
                await this.repository.defineValue(
                    root,
                    next,
                    shares,
                    existing === null,
                );
                const result = {
                    commitment: rootView(root, this.clock.today()),
                    occurrence: view(configuration, next, c.referenceDate),
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
                if (!root)
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
                if (
                    !existing &&
                    (
                        await this.repository.occurrencesInMonth(
                            root,
                            c.referenceDate.slice(0, 7),
                        )
                    ).length
                )
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                const configuration = existing
                    ? root.configurationForVersion(existing.economicVersion)
                    : root.projectedConfigurationAt(c.referenceDate);
                if (!configuration)
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                if (
                    (configuration.participation.type === 'SHARED') !==
                    (context !== null)
                )
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
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
                        occurrence: view(
                            configuration,
                            updated,
                            c.referenceDate,
                        ),
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
                        configuration.economicVersion,
                        1,
                        configuration.valueMode === 'FIXED'
                            ? configuration.amountInCents
                            : null,
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
                if (context && configuration.participation.type === 'SHARED') {
                    const synthetic = this.synthetic(
                        configuration,
                        next,
                        today,
                    );
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
                    occurrence: view(configuration, next, c.referenceDate),
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
                    split: occurrence.economicShares
                        ? ResponsibilitySplit.fromEffectiveShares(
                              occurrence.amountInCents!,
                              occurrence.economicShares,
                          )
                        : root.effectiveSplit(occurrence.amountInCents!)!,
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
                split: occurrence.economicShares
                    ? ResponsibilitySplit.fromEffectiveShares(
                          occurrence.amountInCents!,
                          occurrence.economicShares,
                      )
                    : root.effectiveSplit(occurrence.amountInCents!)!,
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
