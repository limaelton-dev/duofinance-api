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
import type { FulfillmentObligationView } from './fulfillment-obligation.js';
export interface RecordSharedCashExpenseInput {
    expectedSpaceVersion: number;
    description: string;
    amountInCents: number;
    factDate: string;
    responsibilitySplit: SplitInput;
    expectedPayerMemberId: string | null;
    disbursement: {
        payerMemberId: string;
        method: 'PIX' | 'DEBIT' | 'CASH';
        amountInCents?: number;
    };
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
        factDate: string | null;
        expectedPaymentDate?: string | null;
        registeredAt: string;
        createdByPersonId: string;
        expectedPayerMemberId: string | null;
        responsibilitySplit: SplitInput & {
            calculatedShares: { memberId: string; amountInCents: number }[];
        };
        settlementRuleSnapshot: SettlementRuleSnapshot | null;
        settlementRuleSourceVersion: number;
        settlementRule?: import('./settlement-adjustment.js').EffectiveSettlementRule;
        suggestedTargetDate: string | null;
    };
    disbursement: FinancialCommitment['disbursement'];
    disbursements: FinancialCommitment['disbursements'];
    externalLiabilities?: FinancialCommitment['externalLiabilities'];
    assumedAmountInCents?: number;
    externalOutstandingAmountInCents?: number;
    externalSettledAmountInCents?: number;
    supportedAmountInCents?: number;
    fulfillmentStatus?: 'PENDING' | 'PARTIALLY_FULFILLED' | 'FULFILLED';
    paidAmountInCents: number;
    remainingAmountInCents: number;
    status: FinancialCommitment['status'];
    overdue?: boolean;
    obligation: FulfillmentObligationView | null;
    obligations: FulfillmentObligationView[];
    settlementCycle: null | {
        id: string;
        targetDate: string;
        status: 'OPEN' | 'FINALIZED';
    };
}
export type InitialSharedCashExpenseView = Omit<
    SharedCashExpenseView,
    'obligation' | 'settlementCycle'
> & {
    obligation:
        | null
        | (NonNullable<SharedCashExpenseView['obligation']> & {
              status: 'OPEN';
          });
    settlementCycle:
        | null
        | (NonNullable<SharedCashExpenseView['settlementCycle']> & {
              status: 'OPEN';
          });
};
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
): InitialSharedCashExpenseView {
    const version = commitment.initialVersion;
    return {
        spaceId: commitment.spaceId,
        ...(commitment.adjustments.length || commitment.cancellation
            ? {
                  adjustments: commitment.adjustments,
                  cancellation: commitment.cancellation,
                  originalAmountInCents:
                      commitment.adjustments[0]?.previousAmountInCents ??
                      version.split.total.amountInCents,
              }
            : {}),
        commitment: {
            id: commitment.id,
            version: commitment.version,
            kind: 'EXPENSE',
            modality: 'ONE_TIME',
            description: commitment.description,
            amountInCents: version.split.total.amountInCents,
            factDate: version.factDate,
            ...(version.expectedPaymentDate
                ? { expectedPaymentDate: version.expectedPaymentDate }
                : {}),
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
        disbursement: commitment.disbursement
            ? { ...commitment.disbursement }
            : null,
        externalLiabilities: commitment.externalLiabilities,
        externalSettledAmountInCents: commitment.externalSettledAmountInCents,
        assumedAmountInCents: commitment.assumedAmountInCents,
        externalOutstandingAmountInCents:
            commitment.externalOutstandingAmountInCents,
        supportedAmountInCents: commitment.supportedAmountInCents,
        fulfillmentStatus: commitment.fulfillmentStatus,
        disbursements: commitment.disbursements,
        paidAmountInCents: commitment.paidAmountInCents,
        remainingAmountInCents: commitment.remainingAmountInCents,
        status: commitment.status,
        ...(version.expectedPaymentDate ? { overdue: commitment.overdue } : {}),
        obligations: [],
        obligation: obligation
            ? {
                  id: obligation.id,
                  originCommitmentId: obligation.originCommitmentId,
                  originDisbursementId: obligation.originDisbursementId,
                  debtorMemberId: obligation.debtorMemberId,
                  creditorMemberId: obligation.creditorMemberId,
                  originalAmountInCents: obligation.originalAmountInCents,
                  recognizedAmountInCents: obligation.recognizedAmountInCents,
                  transferredAmountInCents:
                      obligation.recognizedAmountInCents -
                      obligation.remainingAmountInCents,
                  history: [
                      {
                          version: 1,
                          type: 'CREATED',
                          actorId: obligation.history.actorId,
                          registeredAt: obligation.registeredAt,
                          snapshot: {},
                      },
                  ],
                  remainingAmountInCents: obligation.remainingAmountInCents,
                  status: 'OPEN',
                  cycleId: obligation.cycleId,
              }
            : null,
        settlementCycle: cycle
            ? { id: cycle.id, targetDate: cycle.targetDate, status: 'OPEN' }
            : null,
    };
}
