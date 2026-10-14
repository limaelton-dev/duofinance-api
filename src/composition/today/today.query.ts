import { Inject, Injectable } from '@nestjs/common';
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
    ) {}

    async execute(actor: PersonId, space: SpaceId): Promise<TodayResponse> {
        const authorized = await this.access.assertCanRead(actor, space);
        const referenceDate = todayReferenceDate(this.clock.now());
        let finance: TodayResponse['finance'] = {
            status: 'AVAILABLE',
            data: {
                upcomingCommitments: { items: [], totalCount: 0 },
                settlements: null,
            },
        };
        if (authorized.type === 'SHARED') {
            try {
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
            } catch (error) {
                if (!(error instanceof FinanceTodayUnavailableError))
                    throw error;
                finance = {
                    status: 'UNAVAILABLE',
                    error: {
                        code: 'FINANCE_TODAY_UNAVAILABLE',
                        message:
                            'Não foi possível carregar as finanças. Tente novamente.',
                    },
                };
            }
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
        };
    }
}
