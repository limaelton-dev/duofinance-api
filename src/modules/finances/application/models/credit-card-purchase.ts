import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type { SplitInput } from '../../domain/shared-expense/responsibility-split.js';
import type { SettlementSelection } from '../../domain/shared-expense/settlement-selection.js';
import type { SharedCashExpenseResult } from './shared-cash-expense.js';
import type { PersonalExpenseResult } from './personal-expense.js';
export interface RecordCreditCardPurchaseInput {
    description: string;
    amountInCents: number;
    factDate: string;
    externalLiability: { amountInCents?: number; holderMemberId?: string };
    expectedSpaceVersion?: number;
    responsibilitySplit?: SplitInput;
    expectedPayerMemberId?: string | null;
    settlement?: SettlementSelection;
}
export interface RecordExternalLiabilityInput {
    amountInCents: number;
    factDate: string;
    holderMemberId?: string;
    expectedCommitmentVersion: number;
    expectedSpaceVersion?: number;
    settlement?: SettlementSelection;
}
export type CreditCardCommandContext = {
    actorId: PersonId;
    spaceId: SpaceId;
    idempotencyKey: string;
};
export type RecordCreditCardPurchaseCommand = RecordCreditCardPurchaseInput &
    CreditCardCommandContext;
export type RecordExternalLiabilityCommand = RecordExternalLiabilityInput &
    CreditCardCommandContext & { commitmentId: string };
export type CreditCardResult = (
    SharedCashExpenseResult | PersonalExpenseResult
) & {
    externalLiability:
        | NonNullable<SharedCashExpenseResult['externalLiabilities']>[number]
        | NonNullable<PersonalExpenseResult['externalLiabilities']>[number];
};
export type CreditCardCommand =
    RecordCreditCardPurchaseCommand | RecordExternalLiabilityCommand;
