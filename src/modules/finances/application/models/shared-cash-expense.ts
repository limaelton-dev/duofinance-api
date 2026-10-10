import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type { SpaceFinancialContext } from '../../../spaces/application/ports/public/space-financial-context.port.js';
import type {
    SplitInput,
    SettlementSelection,
    FinancialCommitment,
    InterMemberObligation,
    SettlementCycle,
} from '../../domain/shared-expense/shared-expense.js';
import type { SettlementRuleSnapshot } from '../../domain/settlement-rule/settlement-rule.js';
export interface RecordSharedCashExpenseInput {
    expectedSpaceVersion: number;
    description: string;
    amountInCents: number;
    factDate: string;
    responsibilitySplit: SplitInput;
    expectedPayerMemberId: string;
    disbursement: { payerMemberId: string; method: 'PIX' | 'DEBIT' | 'CASH' };
    settlement: SettlementSelection;
}
export interface RecordSharedCashExpenseCommand extends RecordSharedCashExpenseInput {
    actorId: PersonId;
    spaceId: SpaceId;
    idempotencyKey: string;
}
export interface SharedCashExpenseView {
    spaceId: string;
    commitment: {
        id: string;
        version: number;
        kind: 'EXPENSE';
        modality: 'ONE_TIME';
        description: string;
        amountInCents: number;
        factDate: string;
        registeredAt: string;
        createdByPersonId: string;
        expectedPayerMemberId: string;
        responsibilitySplit: SplitInput & {
            calculatedShares: { memberId: string; amountInCents: number }[];
        };
        settlementRuleSnapshot: SettlementRuleSnapshot | null;
        settlementRuleSourceVersion: number;
        suggestedTargetDate: string | null;
    };
    disbursement: FinancialCommitment['disbursement'];
    obligation: null | {
        id: string;
        originCommitmentId: string;
        originDisbursementId: string;
        debtorMemberId: string;
        creditorMemberId: string;
        originalAmountInCents: number;
        remainingAmountInCents: number;
        status: 'OPEN';
        cycleId: string | null;
    };
    settlementCycle: null | { id: string; targetDate: string; status: 'OPEN' };
}
export interface SharedCashExpenseResult extends SharedCashExpenseView {
    replayed: boolean;
}
export interface SharedCashExpenseOptions extends SpaceFinancialContext {
    referenceDate: string;
    defaultSettlementRule: {
        rule: SettlementRuleSnapshot | null;
        version: number;
    };
    suggestedTargetDate: string | null;
    openCycles: { id: string; targetDate: string; version: number }[];
    nextCursor: string | null;
}
export function expenseView(
    commitment: FinancialCommitment,
    obligation: InterMemberObligation | null,
    cycle: SettlementCycle | null,
): SharedCashExpenseView {
    const version = commitment.initialVersion;
    return {
        spaceId: commitment.spaceId,
        commitment: {
            id: commitment.id,
            version: 1,
            kind: 'EXPENSE',
            modality: 'ONE_TIME',
            description: commitment.description,
            amountInCents: version.split.total.amountInCents,
            factDate: version.factDate,
            registeredAt: commitment.registeredAt,
            createdByPersonId: commitment.createdByPersonId,
            expectedPayerMemberId: version.expectedPayerMemberId,
            responsibilitySplit: {
                ...version.split.original,
                calculatedShares: version.split.shares.map((s) => ({ ...s })),
            },
            settlementRuleSnapshot: version.settlementRuleSnapshot,
            settlementRuleSourceVersion: version.settlementRuleSourceVersion,
            suggestedTargetDate: version.suggestedTargetDate,
        },
        disbursement: { ...commitment.disbursement },
        obligation: obligation
            ? {
                  id: obligation.id,
                  originCommitmentId: obligation.originCommitmentId,
                  originDisbursementId: obligation.originDisbursementId,
                  debtorMemberId: obligation.debtorMemberId,
                  creditorMemberId: obligation.creditorMemberId,
                  originalAmountInCents: obligation.originalAmountInCents,
                  remainingAmountInCents: obligation.remainingAmountInCents,
                  status: obligation.status,
                  cycleId: obligation.cycleId,
              }
            : null,
        settlementCycle: cycle
            ? { id: cycle.id, targetDate: cycle.targetDate, status: 'OPEN' }
            : null,
    };
}
