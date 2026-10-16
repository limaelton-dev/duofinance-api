import type { CommitmentSettlementRule } from '../../../domain/settlement-rule/commitment-settlement-rule.js';
import type { SettlementRuleSnapshot } from '../../../domain/settlement-rule/settlement-rule.js';
import type { InterMemberObligation } from '../../../domain/shared-expense/inter-member-obligation.js';
import type {
    AdjustmentCommand,
    AssignmentCycle,
    ConfigureCommitmentSettlementRuleResult,
    MoveObligationResult,
    EffectiveSettlementRule,
    FinalizeSettlementCycleResult,
} from '../../models/settlement-adjustment.js';

export const SETTLEMENT_ADJUSTMENT_REPOSITORY = Symbol(
    'SETTLEMENT_ADJUSTMENT_REPOSITORY',
);
export type AdjustmentResult =
    | ConfigureCommitmentSettlementRuleResult
    | MoveObligationResult
    | FinalizeSettlementCycleResult;
export type AdjustmentOperation =
    | 'CONFIGURE_COMMITMENT_SETTLEMENT_RULE'
    | 'MOVE_OBLIGATION'
    | 'FINALIZE_SETTLEMENT_CYCLE';
export class SettlementAdjustmentReceiptRaceError extends Error {}
export interface SettlementAdjustmentRepository {
    readSnapshot<T>(work: () => Promise<T>): Promise<T>;
    findReceipt<T extends AdjustmentResult>(
        operation: AdjustmentOperation,
        command: AdjustmentCommand,
    ): Promise<T | null>;
    saveReceipt(
        operation: AdjustmentOperation,
        command: AdjustmentCommand,
        result: AdjustmentResult,
        now: string,
    ): Promise<void>;
    commitment(
        spaceId: string,
        commitmentId: string,
        lock: boolean,
    ): Promise<{
        id: string;
        version: number;
        specificRuleVersion: number;
    } | null>;
    saveRule(
        spaceId: string,
        rule: CommitmentSettlementRule,
        actorId: string,
        now: string,
    ): Promise<void>;
    effectiveRule(
        spaceId: string,
        commitmentId: string,
        inherited: SettlementRuleSnapshot | null,
        version: number,
    ): Promise<EffectiveSettlementRule>;
    cycle(spaceId: string, id: string): Promise<AssignmentCycle | null>;
    cycleForDate(
        spaceId: string,
        date: string,
    ): Promise<AssignmentCycle | null>;
    createCycleForDate(spaceId: string, date: string): Promise<AssignmentCycle>;
    lockCycles(spaceId: string, ids: string[]): Promise<AssignmentCycle[]>;
    saveAssignment(
        before: InterMemberObligation,
        after: InterMemberObligation,
        actorId: string,
        now: string,
    ): Promise<void>;
    options(
        spaceId: string,
        obligationId: string,
        after: { targetDate: string; id: string } | null,
    ): Promise<{
        obligation: {
            id: string;
            version: number;
            remainingAmountInCents: number;
            cycleId: string | null;
        };
        currentCycle: AssignmentCycle | null;
        cycles: AssignmentCycle[];
    } | null>;
}
