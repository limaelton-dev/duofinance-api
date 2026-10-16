import { Inject, Injectable } from '@nestjs/common';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import {
    SETTLEMENT_ADJUSTMENT_REPOSITORY,
    type SettlementAdjustmentRepository,
} from '../ports/private/settlement-adjustment.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import {
    decodeExpenseCursor,
    encodeExpenseCursor,
} from './shared-cash-expense.queries.js';

@Injectable()
export class SettlementAssignmentOptionsQuery {
    constructor(
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(SETTLEMENT_ADJUSTMENT_REPOSITORY)
        private readonly adjustments: SettlementAdjustmentRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    async execute(
        actor: PersonId,
        space: SpaceId,
        obligationId: string,
        cursor?: string,
    ) {
        await this.context.read(actor, space);
        const binding = [actor.value, space.value, obligationId].join(':');
        const data = await this.adjustments.options(
            space.value,
            obligationId,
            decodeExpenseCursor(cursor, binding),
        );
        if (!data) throw new FinancesError('INTER_MEMBER_OBLIGATION_NOT_FOUND');
        const context = await this.context.read(actor, space);
        const cycles = data.cycles.slice(0, 20),
            last = cycles.at(-1);
        const blockingReason =
            context.status === 'CLOSED'
                ? 'SPACE_CLOSED'
                : data.currentCycle?.status === 'FINALIZED'
                  ? 'SETTLEMENT_CYCLE_FINALIZED'
                  : data.obligation.remainingAmountInCents === 0
                    ? 'OBLIGATION_ALREADY_RESOLVED'
                    : null;
        return {
            spaceId: space.value,
            spaceVersion: context.version,
            obligation: data.obligation,
            currentCycle: data.currentCycle,
            cycles,
            nextCursor:
                data.cycles.length > 20 && last
                    ? encodeExpenseCursor(binding, last.targetDate, last.id)
                    : null,
            eligible: blockingReason === null,
            blockingReason,
            today: this.clock.today(),
        };
    }
}
