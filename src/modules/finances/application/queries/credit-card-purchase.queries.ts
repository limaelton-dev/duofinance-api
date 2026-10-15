import { Inject, Injectable } from '@nestjs/common';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../../spaces/application/ports/public/space-access.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { GetSharedCashExpenseOptionsQuery } from './shared-cash-expense.queries.js';
import { GetExpenseDisbursementOptionsQuery } from './expense-disbursement.queries.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
@Injectable()
export class CreditCardPurchaseQueries {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        private readonly shared: GetSharedCashExpenseOptionsQuery,
        private readonly additional: GetExpenseDisbursementOptionsQuery,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    async options(actor: PersonId, space: SpaceId, cursor?: string) {
        const context = await this.access.assertCanRead(actor, space);
        if (context.type === 'SHARED')
            return {
                ...(await this.shared.execute(actor, space, cursor)),
                spaceType: 'SHARED' as const,
            };
        if (cursor !== undefined)
            throw new FinancesError('VALIDATION_ERROR', ['cursor']);
        return {
            spaceId: space.value,
            spaceType: 'PERSONAL' as const,
            referenceDate: this.clock.today(),
        };
    }
    async externalOptions(
        actor: PersonId,
        space: SpaceId,
        commitmentId: string,
        cursor?: string,
    ) {
        const {
            canDisburse,
            disbursementMethods: _disbursementMethods,
            ...options
        } = await this.additional.execute(actor, space, commitmentId, cursor);
        return { ...options, canAssume: canDisburse };
    }
}
