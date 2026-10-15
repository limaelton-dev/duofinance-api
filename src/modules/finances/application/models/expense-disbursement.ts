import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type { SettlementSelection } from '../../domain/shared-expense/settlement-selection.js';
import type { PersonalExpenseResult } from './personal-expense.js';
import type { SharedCashExpenseResult } from './shared-cash-expense.js';
export type RecordExpenseDisbursementInput = {
    amountInCents: number;
    factDate: string;
    method: 'PIX' | 'DEBIT' | 'CASH';
    expectedCommitmentVersion: number;
} & (
    | {
          payerMemberId?: never;
          expectedSpaceVersion?: never;
          settlement?: never;
      }
    | {
          payerMemberId: string;
          expectedSpaceVersion: number;
          settlement: SettlementSelection;
      }
);
export type RecordExpenseDisbursementCommand =
    RecordExpenseDisbursementInput & {
        actorId: PersonId;
        spaceId: SpaceId;
        commitmentId: string;
        idempotencyKey: string;
    };
export type ExpenseDisbursementResult =
    PersonalExpenseResult | SharedCashExpenseResult;
