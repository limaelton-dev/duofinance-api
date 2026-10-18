import { Inject, Injectable } from '@nestjs/common';
import { isPostgresqlUnavailable } from '../../../../shared/technical/database/postgresql-unavailable.js';
import { EntityManagerProvider } from '../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessContext,
    type SpaceAccessPort,
} from '../../../spaces/application/ports/public/space-access.port.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContext,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import { SpacesDomainError } from '../../../spaces/domain/errors/spaces-domain.error.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import { financeTodayBucketsSql } from '../../infrastructure/typeorm/queries/finance-today-buckets.sql.js';
import { nonRecurringReadQuery } from '../../infrastructure/typeorm/queries/non-recurring-version-selection.js';
import {
    FINANCIAL_CHANGE_REPOSITORY,
    type FinancialChangeRepository,
} from '../ports/private/financial-change.repository.js';
import {
    FINANCE_TODAY_QUERY_PORT,
    FinanceTodayUnavailableError,
    type FinanceTodayQueryPort,
    type FinanceTodaySettlementSummary,
} from '../ports/public/finance-today-query.port.js';
import {
    INCOME_TODAY_QUERY_PORT,
    type IncomeTodayQueryPort,
} from '../ports/public/income-today-query.port.js';
import {
    PLANNED_TODAY_QUERY_PORT,
    type PlannedTodayQueryPort,
} from '../ports/public/planned-today-query.port.js';
import type {
    FinanceTodayCompositionQueryPort,
    FinanceTodayCompositionRead,
    FinanceTodayPreview,
    FinancialTodayItem,
    IncomeTodayItem,
    PlannedTodayItem,
} from '../ports/public/finance-today-composition-query.port.js';

type BucketRow = {
    bucket: 'OVERDUE' | 'TODAY' | 'UPCOMING';
    totalCount: string;
    items: (Omit<
        FinancialTodayItem,
        | 'amountInCents'
        | 'expectedAmountInCents'
        | 'fulfilledAmountInCents'
        | 'remainingAmountInCents'
    > & {
        amountInCents: string | null;
        expectedAmountInCents: string | null;
        fulfilledAmountInCents: string;
        remainingAmountInCents: string | null;
    })[];
};

function boundedAmount(value: string): number {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount < 0)
        throw new Error('Invalid persisted financial amount');
    return amount;
}

function preview(
    rows: BucketRow[],
    bucket: BucketRow['bucket'],
): FinanceTodayPreview<FinancialTodayItem> {
    const row = rows.find((item) => item.bucket === bucket);
    return {
        items:
            row?.items.map((item) => ({
                ...item,
                amountInCents:
                    item.amountInCents === null
                        ? null
                        : boundedAmount(item.amountInCents),
                expectedAmountInCents:
                    item.expectedAmountInCents === null
                        ? null
                        : boundedAmount(item.expectedAmountInCents),
                fulfilledAmountInCents: boundedAmount(
                    item.fulfilledAmountInCents,
                ),
                remainingAmountInCents:
                    item.remainingAmountInCents === null
                        ? null
                        : boundedAmount(item.remainingAmountInCents),
            })) ?? [],
        totalCount: row ? boundedAmount(row.totalCount) : 0,
    };
}

function sameMembers(
    left: SpaceFinancialContext['members'],
    right: SpaceFinancialContext['members'],
): boolean {
    return (
        left.length === right.length &&
        left.every((member) =>
            right.some(
                (other) =>
                    member.memberId === other.memberId &&
                    member.personId === other.personId,
            ),
        )
    );
}

@Injectable()
export class FinanceTodayCompositionQuery implements FinanceTodayCompositionQueryPort {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        private readonly managers: EntityManagerProvider,
        @Inject(INCOME_TODAY_QUERY_PORT)
        private readonly incomes: IncomeTodayQueryPort,
        @Inject(PLANNED_TODAY_QUERY_PORT)
        private readonly planned: PlannedTodayQueryPort,
        @Inject(FINANCE_TODAY_QUERY_PORT)
        private readonly settlements: FinanceTodayQueryPort,
        @Inject(FINANCIAL_CHANGE_REPOSITORY)
        private readonly changes: FinancialChangeRepository,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly financialContexts: SpaceFinancialContextPort,
    ) {}

    async read(
        actor: PersonId,
        space: SpaceId,
        referenceDate: string,
    ): Promise<FinanceTodayCompositionRead> {
        const authorized = await this.access.assertCanRead(actor, space);
        civilDate(referenceDate);
        const financialContext =
            authorized.type === 'SHARED'
                ? await this.financialContexts.read(actor, space)
                : null;
        if (
            financialContext &&
            (financialContext.spaceId !== authorized.spaceId ||
                financialContext.actorMemberId !== authorized.actorMemberId)
        )
            throw new SpacesDomainError('SPACE_NOT_FOUND');
        let outcome:
            | { ok: true; result: FinanceTodayCompositionRead }
            | { ok: false; error: unknown };
        try {
            outcome = {
                ok: true,
                result: await this.managers.readSnapshot(() =>
                    this.readInSnapshot(
                        actor,
                        space,
                        referenceDate,
                        authorized,
                    ),
                ),
            };
        } catch (error) {
            outcome = { ok: false, error };
        }
        const confirmed = await this.access.assertCanRead(actor, space);
        if (
            confirmed.spaceId !== authorized.spaceId ||
            confirmed.type !== authorized.type ||
            confirmed.actorMemberId !== authorized.actorMemberId
        )
            throw new SpacesDomainError('SPACE_NOT_FOUND');
        if (financialContext) {
            const current = await this.financialContexts.read(actor, space);
            if (
                current.spaceId !== financialContext.spaceId ||
                current.actorMemberId !== financialContext.actorMemberId ||
                !sameMembers(current.members, financialContext.members)
            )
                throw new SpacesDomainError('SPACE_NOT_FOUND');
            if (outcome.ok) {
                const settlements = outcome.result.legacy.settlements;
                if (
                    !settlements ||
                    !sameMembers(settlements.members, financialContext.members)
                )
                    throw new SpacesDomainError('SPACE_NOT_FOUND');
            }
        }
        if (!outcome.ok) {
            if (isPostgresqlUnavailable(outcome.error))
                throw new FinanceTodayUnavailableError();
            throw outcome.error;
        }
        return outcome.result;
    }

    private async readInSnapshot(
        actor: PersonId,
        space: SpaceId,
        referenceDate: string,
        authorized: SpaceAccessContext,
    ): Promise<FinanceTodayCompositionRead> {
        const income = await this.incomes.readUpcoming(
            actor,
            space,
            referenceDate,
        );
        const planned = await this.planned.readUpcoming(
            actor,
            space,
            referenceDate,
        );
        const items: (IncomeTodayItem | PlannedTodayItem)[] = [
            ...income.items,
            ...planned.items,
        ];
        items.sort((left, right) => {
            const leftDate =
                'expectedDate' in left
                    ? left.expectedDate
                    : left.expectedReceiptDate;
            const rightDate =
                'expectedDate' in right
                    ? right.expectedDate
                    : right.expectedReceiptDate;
            return (
                leftDate.localeCompare(rightDate) ||
                left.commitmentId.localeCompare(right.commitmentId)
            );
        });
        let settlements: FinanceTodaySettlementSummary | null = null;
        let proposals: FinanceTodayCompositionRead['proposals'] = {
            items: [],
            totalCount: 0,
        };
        if (authorized.type === 'SHARED') {
            const result = await this.settlements.read(
                actor,
                space,
                referenceDate,
            );
            if (
                result.spaceId !== authorized.spaceId ||
                result.actorMemberId !== authorized.actorMemberId ||
                result.referenceDate !== referenceDate
            )
                throw new SpacesDomainError('SPACE_NOT_FOUND');
            settlements = {
                actorMemberId: result.actorMemberId,
                members: result.members,
                nextCycle: result.nextCycle,
                overdueCycles: result.overdueCycles,
            };
            const proposed = await this.changes.list(
                space.value,
                null,
                result.actorMemberId,
                'PROPOSED',
                null,
            );
            proposals = {
                items: proposed.items.slice(0, 4).map(({ state }) => ({
                    proposalId: state.id,
                    commitmentId: state.commitmentId,
                    registeredAt: state.registeredAt,
                    effectiveFrom: state.effectiveFrom,
                })),
                totalCount: proposed.totalCount,
            };
        }
        const rows = await nonRecurringReadQuery<BucketRow[]>(
            this.managers.get(),
            financeTodayBucketsSql,
            [space.value, referenceDate],
            referenceDate,
        );
        return {
            spaceId: authorized.spaceId,
            actorMemberId: authorized.actorMemberId,
            referenceDate,
            legacy: {
                upcomingCommitments: {
                    items: items.slice(0, 4),
                    totalCount: income.totalCount + planned.totalCount,
                },
                settlements,
            },
            overdue: preview(rows, 'OVERDUE'),
            today: preview(rows, 'TODAY'),
            upcoming: preview(rows, 'UPCOMING'),
            proposals,
        };
    }
}
