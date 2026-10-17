import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type { SettlementRuleSnapshot } from '../../domain/settlement-rule/settlement-rule.js';
import type { SplitInput } from '../../domain/shared-expense/responsibility-split.js';
import type { SettlementSelection } from '../../domain/shared-expense/settlement-selection.js';
import type { IncomeCommitment } from '../../domain/income/income-commitment.js';
import type { FulfillmentObligationView } from './fulfillment-obligation.js';

export type RecordIncomeInput = {
    description: string;
    amountInCents: number;
    expectedReceiptDate: string;
} & (
    | { receipt: null | { factDate: string; amountInCents?: number } }
    | {
          expectedSpaceVersion: number;
          participationSplit: SplitInput;
          expectedRecipientMemberId: string | null;
          receipt: null | {
              factDate: string;
              amountInCents?: number;
              recipientMemberId: string;
              settlement: SettlementSelection;
          };
      }
);
export type RecordIncomeCommand = RecordIncomeInput & {
    actorId: PersonId;
    spaceId: SpaceId;
    idempotencyKey: string;
};
export type RecordIncomeReceiptInput = {
    expectedCommitmentVersion: number;
    amountInCents?: number;
    factDate: string;
} & (
    | {
          recipientMemberId?: never;
          settlement?: never;
          expectedSpaceVersion?: never;
      }
    | {
          expectedSpaceVersion: number;
          recipientMemberId: string;
          settlement: SettlementSelection;
      }
);
export type RecordIncomeReceiptCommand = RecordIncomeReceiptInput & {
    commitmentId: string;
    actorId: PersonId;
    spaceId: SpaceId;
    idempotencyKey: string;
};
export interface IncomeView {
    spaceId: string;
    spaceType: 'PERSONAL' | 'SHARED';
    commitment: {
        id: string;
        kind: 'INCOME';
        modality: 'ONE_TIME';
        version: number;
        description: string;
        amountInCents: number;
        expectedReceiptDate: string;
        createdByPersonId: string;
        registeredAt: string;
        ownerPersonId?: string;
        participationSplit?: SplitInput & {
            calculatedShares: { memberId: string; amountInCents: number }[];
        };
        expectedRecipientMemberId?: string | null;
        settlementRuleSnapshot?: SettlementRuleSnapshot | null;
        settlementRuleSourceVersion?: number;
        settlementRule?: import('./settlement-adjustment.js').EffectiveSettlementRule;
    };
    receipt: null | NonNullable<IncomeCommitment['receipt']>;
    receipts: IncomeCommitment['receipts'];
    reversals?: IncomeCommitment['reversals'];
    validReceipts?: IncomeCommitment['validReceipts'];
    status: 'PENDING' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED';
    receivedAmountInCents: number;
    remainingAmountInCents: number;
    obligation: FulfillmentObligationView | null;
    obligations: FulfillmentObligationView[];
    settlementCycle: null | {
        id: string;
        targetDate: string;
        status: 'OPEN' | 'FINALIZED';
    };
    members?: {
        memberId: string;
        personId: string;
        displayName: string;
    }[];
}
export type IncomeResult = IncomeView & { replayed: boolean };
export type IncomeSummary = Pick<
    IncomeView['commitment'],
    | 'id'
    | 'description'
    | 'amountInCents'
    | 'expectedReceiptDate'
    | 'registeredAt'
> & {
    status: IncomeView['status'];
    receivedAmountInCents: number;
    remainingAmountInCents: number;
};
