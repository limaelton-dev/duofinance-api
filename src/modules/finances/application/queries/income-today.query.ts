import { Inject, Injectable } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../../spaces/application/ports/public/space-access.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import {
    INCOME_REPOSITORY,
    type IncomeRepository,
} from '../ports/private/income.ports.js';
import { FinanceTodayUnavailableError } from '../ports/public/finance-today-query.port.js';
import type { IncomeTodayQueryPort } from '../ports/public/income-today-query.port.js';

@Injectable()
export class GetIncomeTodayQuery implements IncomeTodayQueryPort {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(INCOME_REPOSITORY) private readonly incomes: IncomeRepository,
    ) {}

    async readUpcoming(actor: PersonId, space: SpaceId, referenceDate: string) {
        await this.access.assertCanRead(actor, space);
        civilDate(referenceDate);
        let result;
        try {
            result = await this.incomes.upcoming(space.value, referenceDate);
        } catch (error) {
            if (error instanceof QueryFailedError)
                throw new FinanceTodayUnavailableError();
            throw error;
        }
        await this.access.assertCanRead(actor, space);
        return {
            items: result.items.map((item) => ({
                commitmentId: item.id,
                kind: 'INCOME' as const,
                description: item.description,
                expectedReceiptDate: item.expectedReceiptDate,
                amountInCents: item.amountInCents,
            })),
            totalCount: result.totalCount,
        };
    }
}
