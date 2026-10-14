import { Inject, Injectable } from '@nestjs/common';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import { SpacesDomainError } from '../../../spaces/domain/errors/spaces-domain.error.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import type { SettlementCycleSummary } from '../models/settlement-cycle.js';
import {
    SETTLEMENT_CYCLE_READER,
    type SettlementCycleRead,
    type SettlementCycleReader,
} from '../ports/private/settlement-cycle-reader.js';
import type {
    FinanceTodayQueryPort,
    FinanceTodayRead,
} from '../ports/public/finance-today-query.port.js';
import { settlementCycleSummary } from './settlement-cycle.queries.js';

function summary(
    row: SettlementCycleRead,
    referenceDate: string,
): SettlementCycleSummary {
    const { finalizedAt: _, ...result } = settlementCycleSummary(
        row,
        referenceDate,
    );
    return result;
}

@Injectable()
export class GetFinanceTodayQuery implements FinanceTodayQueryPort {
    constructor(
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly access: SpaceFinancialContextPort,
        @Inject(SETTLEMENT_CYCLE_READER)
        private readonly reader: SettlementCycleReader,
    ) {}

    async read(
        actor: PersonId,
        space: SpaceId,
        referenceDate: string,
    ): Promise<FinanceTodayRead> {
        const authorized = await this.access.read(actor, space);
        civilDate(referenceDate);
        let outcome:
            | {
                  status: 'AVAILABLE';
                  result: Awaited<ReturnType<SettlementCycleReader['today']>>;
              }
            | { status: 'FAILED'; error: unknown };
        try {
            const result = await this.reader.today(
                space.value,
                authorized.actorMemberId,
                referenceDate,
            );
            outcome = { status: 'AVAILABLE', result };
        } catch (error) {
            outcome = { status: 'FAILED', error };
        }
        const context = await this.access.read(actor, space);
        if (
            context.spaceId !== authorized.spaceId ||
            context.actorMemberId !== authorized.actorMemberId ||
            context.members.length !== authorized.members.length ||
            context.members.some(
                (member) =>
                    !authorized.members.some(
                        (previous) =>
                            previous.memberId === member.memberId &&
                            previous.personId === member.personId,
                    ),
            )
        )
            throw new SpacesDomainError('SPACE_NOT_FOUND');
        if (outcome.status === 'FAILED') throw outcome.error;
        const result = outcome.result;
        return {
            spaceId: space.value,
            spaceStatus: context.status,
            referenceDate,
            actorMemberId: context.actorMemberId,
            members: context.members,
            nextCycle: result.nextCycle
                ? summary(result.nextCycle, referenceDate)
                : null,
            overdueCycles: {
                items: result.overdueCycles.items.map((row) =>
                    summary(row, referenceDate),
                ),
                totalCount: result.overdueCycles.totalCount,
            },
        };
    }
}
