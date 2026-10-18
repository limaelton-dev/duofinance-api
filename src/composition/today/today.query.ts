import { Inject, Injectable, Optional } from '@nestjs/common';
import {
    ROUTINE_ATTENTION_QUERY,
    RoutineAttentionUnavailableError,
    type RoutineAttentionQueryPort,
} from '../../modules/routine/application/ports/public/routine-attention-query.port.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../modules/spaces/application/ports/public/space-access.port.js';
import { SpacesDomainError } from '../../modules/spaces/domain/errors/spaces-domain.error.js';
import type { PersonId } from '../../modules/spaces/domain/person/person-id.js';
import type { SpaceId } from '../../modules/spaces/domain/space/space-id.js';
import {
    FINANCE_TODAY_QUERY_PORT,
    FinanceTodayUnavailableError,
    type FinanceTodayQueryPort,
} from '../../modules/finances/application/ports/public/finance-today-query.port.js';
import {
    INCOME_TODAY_QUERY_PORT,
    type IncomeTodayQueryPort,
} from '../../modules/finances/application/ports/public/income-today-query.port.js';
import {
    PLANNED_TODAY_QUERY_PORT,
    type PlannedTodayQueryPort,
} from '../../modules/finances/application/ports/public/planned-today-query.port.js';
import {
    TODAY_CLOCK,
    todayReferenceDate,
    type TodayClock,
} from './today.clock.js';
import type { TodayResponse } from './today.response.js';

@Injectable()
export class TodayQuery {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(FINANCE_TODAY_QUERY_PORT)
        private readonly finances: FinanceTodayQueryPort,
        @Inject(TODAY_CLOCK) private readonly clock: TodayClock,
        @Inject(INCOME_TODAY_QUERY_PORT)
        private readonly incomes: IncomeTodayQueryPort,
        @Optional()
        @Inject(PLANNED_TODAY_QUERY_PORT)
        private readonly planned?: PlannedTodayQueryPort,
        @Optional()
        @Inject(ROUTINE_ATTENTION_QUERY)
        private readonly routine?: RoutineAttentionQueryPort,
    ) {}

    async execute(actor: PersonId, space: SpaceId): Promise<TodayResponse> {
        const authorized = await this.access.assertCanRead(actor, space);
        const instant = this.clock.now();
        const referenceDate = todayReferenceDate(instant);
        let finance: TodayResponse['finance'] = {
            status: 'AVAILABLE',
            data: {
                upcomingCommitments: { items: [], totalCount: 0 },
                settlements: null,
            },
        };
        try {
            finance.data.upcomingCommitments = await this.incomes.readUpcoming(
                actor,
                space,
                referenceDate,
            );
            if (this.planned) {
                const planned = await this.planned.readUpcoming(
                    actor,
                    space,
                    referenceDate,
                );
                const income = finance.data.upcomingCommitments;
                finance.data.upcomingCommitments = {
                    items: [...income.items, ...planned.items]
                        .sort((a, b) => {
                            const left =
                                'expectedDate' in a
                                    ? a.expectedDate
                                    : a.expectedReceiptDate;
                            const right =
                                'expectedDate' in b
                                    ? b.expectedDate
                                    : b.expectedReceiptDate;
                            return (
                                left.localeCompare(right) ||
                                a.commitmentId.localeCompare(b.commitmentId)
                            );
                        })
                        .slice(0, 4),
                    totalCount: income.totalCount + planned.totalCount,
                };
            }
            if (authorized.type === 'SHARED') {
                const result = await this.finances.read(
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
                finance.data.settlements = {
                    actorMemberId: result.actorMemberId,
                    members: result.members,
                    nextCycle: result.nextCycle,
                    overdueCycles: result.overdueCycles,
                };
            }
        } catch (error) {
            if (!(error instanceof FinanceTodayUnavailableError)) throw error;
            finance = {
                status: 'UNAVAILABLE',
                error: {
                    code: 'FINANCE_TODAY_UNAVAILABLE',
                    message:
                        'Não foi possível carregar as finanças. Tente novamente.',
                },
            };
        }
        let routine: TodayResponse['routine'];
        try {
            if (!this.routine) throw new RoutineAttentionUnavailableError();
            const data = await this.routine.read(actor, space, instant);
            if (
                data.referenceDate !== referenceDate ||
                data.referenceInstant !== instant.toISOString()
            )
                throw new SpacesDomainError('SPACE_NOT_FOUND');
            routine = { status: 'AVAILABLE', data };
        } catch (error) {
            if (!(error instanceof RoutineAttentionUnavailableError))
                throw error;
            routine = {
                status: 'UNAVAILABLE',
                error: {
                    code: 'ROUTINE_TODAY_UNAVAILABLE',
                    message:
                        'Não foi possível carregar as tarefas. Tente novamente.',
                },
            };
        }
        const confirmed = await this.access.assertCanRead(actor, space);
        if (
            confirmed.spaceId !== authorized.spaceId ||
            confirmed.type !== authorized.type ||
            confirmed.actorMemberId !== authorized.actorMemberId
        )
            throw new SpacesDomainError('SPACE_NOT_FOUND');
        return {
            spaceId: confirmed.spaceId,
            spaceType: confirmed.type,
            spaceStatus: confirmed.status,
            referenceDate,
            finance,
            routine,
        };
    }
}
