import { Inject, Injectable } from '@nestjs/common';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import {
    OBLIGATION_WAIVER_REPOSITORY,
    type ObligationWaiverRepository,
} from '../ports/private/obligation-waiver.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import {
    encodeSettlementDetailCursor,
    decodeSettlementDetailCursor,
} from './settlement-cycle.queries.js';
@Injectable()
export class ObligationWaiverQueries {
    constructor(
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly access: SpaceFinancialContextPort,
        @Inject(OBLIGATION_WAIVER_REPOSITORY)
        private readonly waivers: ObligationWaiverRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    async options(actor: PersonId, space: SpaceId, obligationId: string) {
        await this.access.read(actor, space);
        const data = await this.waivers.options(space.value, obligationId);
        const context = await this.access.read(actor, space);
        if (!data) throw new FinancesError('INTER_MEMBER_OBLIGATION_NOT_FOUND');
        const waiverBlockReason =
            context.actorMemberId !== data.obligation.creditorMemberId
                ? 'CREDITOR_REQUIRED'
                : context.status === 'CLOSED'
                  ? 'SPACE_CLOSED'
                  : data.settlementCycle?.status === 'FINALIZED'
                    ? 'SETTLEMENT_CYCLE_FINALIZED'
                    : data.obligation.remainingAmountInCents === 0
                      ? 'OBLIGATION_ALREADY_RESOLVED'
                      : null;
        return {
            spaceId: space.value,
            spaceStatus: context.status,
            spaceVersion: context.version,
            actorMemberId: context.actorMemberId,
            members: context.members,
            referenceDate: this.clock.today(),
            ...data,
            canWaive: waiverBlockReason === null,
            waiverBlockReason,
        };
    }
    async history(
        actor: PersonId,
        space: SpaceId,
        obligationId: string,
        cursor?: string,
    ) {
        await this.access.read(actor, space);
        if (!(await this.waivers.options(space.value, obligationId)))
            throw new FinancesError('INTER_MEMBER_OBLIGATION_NOT_FOUND');
        const key = 'WAIVERS:' + obligationId;
        const data = await this.waivers.history(
            space.value,
            obligationId,
            decodeSettlementDetailCursor(
                cursor,
                space.value,
                actor.value,
                key,
                'ALL',
            ),
        );
        await this.access.read(actor, space);
        const items = data.slice(0, 20),
            last = items.at(-1);
        return {
            spaceId: space.value,
            obligationId,
            items,
            page: {
                pageSize: 20 as const,
                nextCursor:
                    data.length > 20 && last
                        ? encodeSettlementDetailCursor(
                              space.value,
                              actor.value,
                              key,
                              'ALL',
                              last.waiver,
                          )
                        : null,
            },
        };
    }
}
