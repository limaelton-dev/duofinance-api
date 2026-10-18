import { Inject, Injectable } from '@nestjs/common';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../modules/spaces/application/ports/public/space-access.port.js';
import { SpacesDomainError } from '../../modules/spaces/domain/errors/spaces-domain.error.js';
import type { PersonId } from '../../modules/spaces/domain/person/person-id.js';
import type { SpaceId } from '../../modules/spaces/domain/space/space-id.js';
import {
    FINANCE_TODAY_COMPOSITION_QUERY_PORT,
    type FinanceTodayCompositionQueryPort,
} from '../../modules/finances/application/ports/public/finance-today-composition-query.port.js';
import { FinanceTodayUnavailableError } from '../../modules/finances/application/ports/public/finance-today-query.port.js';
import {
    ROUTINE_TODAY_QUERY_PORT,
    type RoutineTodayQueryPort,
} from '../../modules/routine/application/ports/public/routine-today-query.port.js';
import { RoutineAttentionUnavailableError } from '../../modules/routine/application/ports/public/routine-attention-query.port.js';
import {
    SHOPPING_ATTENTION_QUERY_PORT,
    ShoppingAttentionUnavailableError,
    type ShoppingAttentionQueryPort,
} from '../../modules/shopping/application/ports/public/shopping-attention-query.port.js';
import {
    TODAY_CLOCK,
    todayReferenceDate,
    type TodayClock,
} from './today.clock.js';
import { todayBlocks } from './today.blocks.js';
import type { TodayResponse, TodaySource } from './today.response.js';

async function readSource<T, Code extends string>(
    work: () => Promise<T>,
    unavailable: new (...args: never[]) => Error,
    code: Code,
    message: string,
): Promise<TodaySource<T, Code>> {
    try {
        return { status: 'AVAILABLE', data: await work() };
    } catch (error) {
        if (!(error instanceof unavailable)) throw error;
        return { status: 'UNAVAILABLE', error: { code, message } };
    }
}

function sourceResult<T>(outcome: PromiseSettledResult<T>): T {
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
}

@Injectable()
export class TodayQuery {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(FINANCE_TODAY_COMPOSITION_QUERY_PORT)
        private readonly finances: FinanceTodayCompositionQueryPort,
        @Inject(TODAY_CLOCK) private readonly clock: TodayClock,
        @Inject(ROUTINE_TODAY_QUERY_PORT)
        private readonly routine: RoutineTodayQueryPort,
        @Inject(SHOPPING_ATTENTION_QUERY_PORT)
        private readonly shopping: ShoppingAttentionQueryPort,
    ) {}

    async execute(actor: PersonId, space: SpaceId): Promise<TodayResponse> {
        const authorized = await this.access.assertCanRead(actor, space);
        const instant = this.clock.now();
        const referenceDate = todayReferenceDate(instant);
        const outcomes = await Promise.allSettled([
            readSource(
                () => this.finances.read(actor, space, referenceDate),
                FinanceTodayUnavailableError,
                'FINANCE_TODAY_UNAVAILABLE',
                'Não foi possível carregar as finanças. Tente novamente.',
            ),
            readSource(
                () => this.routine.read(actor, space, instant),
                RoutineAttentionUnavailableError,
                'ROUTINE_TODAY_UNAVAILABLE',
                'Não foi possível carregar as tarefas. Tente novamente.',
            ),
            readSource(
                () => this.shopping.read(actor, space, instant),
                ShoppingAttentionUnavailableError,
                'SHOPPING_TODAY_UNAVAILABLE',
                'Não foi possível carregar suas listas agora. Tente novamente.',
            ),
        ]);
        const financial = sourceResult(outcomes[0]);
        const tasks = sourceResult(outcomes[1]);
        const shopping = sourceResult(outcomes[2]);
        for (const source of [financial, tasks, shopping]) {
            if (source.status !== 'AVAILABLE') continue;
            if (
                source.data.spaceId !== authorized.spaceId ||
                source.data.actorMemberId !== authorized.actorMemberId ||
                source.data.referenceDate !== referenceDate
            )
                throw new SpacesDomainError('SPACE_NOT_FOUND');
        }
        for (const source of [tasks, shopping]) {
            if (
                source.status === 'AVAILABLE' &&
                source.data.referenceInstant !== instant.toISOString()
            )
                throw new SpacesDomainError('SPACE_NOT_FOUND');
        }
        if (financial.status === 'AVAILABLE') {
            const settlements = financial.data.legacy.settlements;
            if (
                (authorized.type === 'PERSONAL' && settlements !== null) ||
                (authorized.type === 'SHARED' &&
                    settlements?.actorMemberId !== authorized.actorMemberId)
            )
                throw new SpacesDomainError('SPACE_NOT_FOUND');
        }
        if (
            tasks.status === 'AVAILABLE' &&
            (tasks.data.legacy.referenceDate !== referenceDate ||
                tasks.data.legacy.referenceInstant !== instant.toISOString())
        )
            throw new SpacesDomainError('SPACE_NOT_FOUND');
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
            finance:
                financial.status === 'AVAILABLE'
                    ? { status: 'AVAILABLE', data: financial.data.legacy }
                    : financial,
            routine:
                tasks.status === 'AVAILABLE'
                    ? { status: 'AVAILABLE', data: tasks.data.legacy }
                    : tasks,
            shopping,
            blocks: todayBlocks(confirmed.type, financial, tasks, shopping),
            capabilities: { spaceClosureAttention: 'NOT_SUPPORTED' },
        };
    }
}
