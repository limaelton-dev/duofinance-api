import { Inject, Injectable } from '@nestjs/common';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../../spaces/application/ports/public/space-access.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import {
    PERSONAL_EXPENSE_READER,
    type PersonalExpenseReader,
} from '../ports/private/personal-expense.ports.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import {
    decodeExpenseCursor,
    encodeExpenseCursor,
} from './shared-cash-expense.queries.js';
@Injectable()
export class GetPersonalExpenseOptionsQuery {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    async execute(actor: PersonId, space: SpaceId) {
        const context = await this.access.assertCanRead(actor, space);
        if (context.type !== 'PERSONAL')
            throw new FinancesError('PERSONAL_SPACE_REQUIRED');
        return {
            spaceId: space.value,
            referenceDate: this.clock.today(),
            disbursementMethods: ['PIX', 'DEBIT', 'CASH'] as const,
        };
    }
}
@Injectable()
export class ListPersonalExpensesQuery {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(PERSONAL_EXPENSE_READER)
        private readonly reader: PersonalExpenseReader,
    ) {}
    async execute(actor: PersonId, space: SpaceId, cursor?: string) {
        const context = await this.access.assertCanRead(actor, space);
        if (context.type !== 'PERSONAL')
            throw new FinancesError('PERSONAL_SPACE_REQUIRED');
        const decoded = decodeExpenseCursor(cursor, space.value);
        const rows = await this.reader.list(
            space.value,
            decoded ? { factDate: decoded.targetDate, id: decoded.id } : null,
        );
        await this.access.assertCanRead(actor, space);
        const items = rows.slice(0, 20),
            last = items.at(-1);
        return {
            spaceId: space.value,
            items,
            nextCursor:
                rows.length > 20 && last
                    ? encodeExpenseCursor(space.value, last.factDate, last.id)
                    : null,
        };
    }
}
