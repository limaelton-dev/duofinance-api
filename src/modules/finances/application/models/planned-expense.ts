import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type { CreatePlannedExpenseDto } from '../../http/dto/create-planned-expense.dto.js';
import type { PersonalExpenseView } from './personal-expense.js';
import type { SharedCashExpenseView } from './shared-cash-expense.js';

export type CreatePlannedExpenseCommand = CreatePlannedExpenseDto & {
    actorId: PersonId;
    spaceId: SpaceId;
    idempotencyKey: string;
};

export type PlannedExpenseResult = (
    PersonalExpenseView | SharedCashExpenseView
) & { replayed: boolean };
