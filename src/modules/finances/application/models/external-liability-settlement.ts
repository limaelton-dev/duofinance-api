import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type {
    ExternalLiabilitySettlement,
    ExpenseExternalLiability,
    ExpenseVersion,
} from '../../domain/shared-expense/financial-commitment.js';
import type { ExpenseDisbursementResult } from './expense-disbursement.js';
export interface SettleExternalLiabilityInput {
    amountInCents: number;
    factDate: string;
    expectedCommitmentVersion: number;
    expectedSpaceVersion?: number;
}
export interface SettleExternalLiabilityCommand extends SettleExternalLiabilityInput {
    actorId: PersonId;
    spaceId: SpaceId;
    commitmentId: string;
    externalLiabilityId: string;
    idempotencyKey: string;
}
export type ExternalLiabilitySettlementResult = ExpenseDisbursementResult & {
    settlement: ExternalLiabilitySettlement;
};
export interface OpenExternalLiability {
    commitmentId: string;
    commitmentVersion: number;
    description: string;
    externalLiability: ExpenseExternalLiability<ExpenseVersion>;
}
