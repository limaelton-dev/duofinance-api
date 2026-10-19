import { Inject, Injectable } from '@nestjs/common';
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
import { SettlementRule } from '../../domain/settlement-rule/settlement-rule.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import {
    RECURRING_COMMITMENT_REPOSITORY,
    type RecurringCommitmentRepository,
} from '../ports/private/recurring-commitment.repository.js';
import {
    SETTLEMENT_ADJUSTMENT_REPOSITORY,
    type SettlementAdjustmentRepository,
} from '../ports/private/settlement-adjustment.repository.js';
import {
    FINANCES_CLOCK,
    SETTLEMENT_CYCLE_REPOSITORY,
    type FinancesClock,
    type SettlementCycleRepository,
} from '../ports/private/shared-expense.repositories.js';
import { assertRecurringClosureCutoff } from './assert-recurring-closure-cutoff.js';
import { rootView, view } from './recurring-commitment.models.js';

@Injectable()
export class RecurringCommitmentQueries {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(RECURRING_COMMITMENT_REPOSITORY)
        private readonly repository: RecurringCommitmentRepository,
        @Inject(SETTLEMENT_ADJUSTMENT_REPOSITORY)
        private readonly adjustments: SettlementAdjustmentRepository,
        @Inject(SETTLEMENT_CYCLE_REPOSITORY)
        private readonly cycles: SettlementCycleRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}

    async detail(actor: PersonId, space: SpaceId, id: string) {
        const access = await this.access.assertCanRead(actor, space);
        const result = await this.repository.readSnapshot(async () => {
            const root = await this.repository.find(space.value, id);
            if (!root)
                throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
            const context =
                access.type === 'SHARED'
                    ? await this.context.read(actor, space)
                    : null;

            return {
                commitment: rootView(
                    root,
                    this.clock.today(),
                    context?.closureCutoffDate,
                ),
            };
        });
        await this.access.assertCanRead(actor, space);
        return result;
    }

    async list(
        actor: PersonId,
        space: SpaceId,
        month: string,
        cursor?: string,
    ) {
        const access = await this.access.assertCanRead(actor, space);
        const context =
            access.type === 'SHARED'
                ? await this.context.read(actor, space)
                : null;
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
        const result = await this.repository.list(
            space.value,
            month,
            after,
            context?.closureCutoffDate,
        );
        if (context) {
            const current = await this.context.read(actor, space);
            if (current.closureCutoffDate !== context.closureCutoffDate)
                throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
        }
        await this.access.assertCanRead(actor, space);
        const items = result.items.slice(0, 20).map((row) => ({
            ...rootView(
                row.commitment,
                this.clock.today(),
                context?.closureCutoffDate,
            ),
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
        const access = await this.access.assertCanRead(actor, space);
        const result = await this.repository.readSnapshot(async () => {
            if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month))
                throw new FinancesError('VALIDATION_ERROR', ['month']);
            const root = await this.repository.find(space.value, id);
            if (!root)
                throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
            const materialized = await this.repository.occurrencesInMonth(
                root,
                month,
            );
            const context =
                access.type === 'SHARED'
                    ? await this.context.read(actor, space)
                    : null;
            const projections = materialized.length
                ? []
                : root.projections(month);
            const dates = [
                ...new Set([
                    ...projections.map((p) => p.referenceDate),
                    ...materialized.map((o) => o.referenceDate),
                ]),
            ]
                .filter((date) => {
                    const occurrence = materialized.find(
                        (item) => item.referenceDate === date,
                    );
                    return (
                        !context?.closureCutoffDate ||
                        date < context.closureCutoffDate ||
                        occurrence?.status === 'CANCELLED' ||
                        (occurrence?.facts.length ?? 0) > 0
                    );
                })
                .sort();
            const items = dates.map((date) => {
                const occurrence =
                    materialized.find((o) => o.referenceDate === date) ?? null;
                const config = occurrence
                    ? root.configurationForVersion(occurrence.economicVersion)
                    : root.projectedConfigurationAt(date);
                return view(config!, occurrence, date);
            });
            const active = items.filter((item) => item.status !== 'CANCELLED');

            return {
                commitmentId: id,
                month,
                items,
                totalCount: active.length,
                totalAmountInCents: active
                    .reduce(
                        (n, item) => n + BigInt(item.amountInCents ?? 0),
                        0n,
                    )
                    .toString(),
                unknownAmountCount: active.filter(
                    (item) => item.amountInCents === null,
                ).length,
            };
        });
        await this.access.assertCanRead(actor, space);
        return result;
    }

    async options(
        actor: PersonId,
        space: SpaceId,
        id: string,
        referenceDate: string,
        cursor?: string,
    ) {
        const access = await this.access.assertCanRead(actor, space);
        const result = await this.repository.readSnapshot(async () => {
            const root = await this.repository.find(space.value, id);
            if (!root)
                throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
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
            assertRecurringClosureCutoff(
                context,
                referenceDate,
                occurrence?.facts.length ?? 0,
            );
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
                        Buffer.from(JSON.stringify(value)).toString(
                            'base64url',
                        ) !== cursor
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
                          configuration.participation
                              .settlementRuleSourceVersion,
                      )
                    : null;
            const cycles = context
                ? await this.cycles.listOpen(space.value, after)
                : [];
            const page = cycles.slice(0, 20),
                last = page.at(-1);

            return {
                commitment: rootView(
                    root,
                    this.clock.today(),
                    context?.closureCutoffDate,
                ),
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
        });
        await this.access.assertCanRead(actor, space);
        return result;
    }
}
