import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type { SettlementRuleSnapshot } from '../../domain/settlement-rule/settlement-rule.js';
import type { SplitInput } from '../../domain/shared-expense/responsibility-split.js';
import type { SettlementSelection } from '../../domain/shared-expense/settlement-selection.js';
import type { IncomeCommitment } from '../../domain/income/income-commitment.js';

export type RecordIncomeInput = {
    description: string;
    amountInCents: number;
    expectedReceiptDate: string;
} & (
    | { receipt: null | { factDate: string } }
    | {
          expectedSpaceVersion: number;
          participationSplit: SplitInput;
          expectedRecipientMemberId: string | null;
          receipt: null | {
              factDate: string;
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
    };
    receipt: null | NonNullable<IncomeCommitment['receipt']>;
    status: 'PENDING' | 'RECEIVED';
    receivedAmountInCents: number;
    obligation: null | {
        id: string;
        originCommitmentId: string;
        originReceiptId: string;
        debtorMemberId: string;
        creditorMemberId: string;
        originalAmountInCents: number;
        remainingAmountInCents: number;
        status: 'OPEN' | 'PARTIALLY_SETTLED' | 'SETTLED';
        cycleId: string | null;
    };
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
};
