import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type { SettlementRuleSnapshot } from '../../domain/settlement-rule/settlement-rule.js';
import type { SettlementSelection } from '../../domain/shared-expense/settlement-selection.js';

export interface AdjustmentCommand {
    actorId: PersonId;
    spaceId: SpaceId;
    idempotencyKey: string;
    expectedSpaceVersion: number;
}
export interface ConfigureCommitmentSettlementRuleCommand extends AdjustmentCommand {
    commitmentId: string;
    rule: SettlementRuleSnapshot;
    expectedCommitmentVersion: number;
}
export interface MoveObligationCommand extends AdjustmentCommand {
    obligationId: string;
    settlement: Exclude<SettlementSelection, { mode: 'SUGGESTED' }>;
    expectedObligationVersion: number;
    expectedCycleVersions: { cycleId: string; version: number }[];
}
export interface AssignmentCycle {
    id: string;
    targetDate: string;
    status: 'OPEN' | 'FINALIZED';
    version: number;
}
export interface EffectiveSettlementRule {
    source: 'SPECIFIC' | 'INHERITED';
    rule: SettlementRuleSnapshot | null;
    version: number;
}
export interface ConfigureCommitmentSettlementRuleResult {
    spaceId: string;
    commitmentId: string;
    commitmentVersion: number;
    settlementRule: EffectiveSettlementRule & {
        referenceDate: string;
        suggestedTargetDate: string | null;
    };
    affectedCycleIds: string[];
    replayed: boolean;
}
export interface MoveObligationResult {
    spaceId: string;
    obligation: {
        id: string;
        version: number;
        cycleId: string | null;
        remainingAmountInCents: number;
    };
    settlementCycle: AssignmentCycle | null;
    affectedCycleIds: string[];
    replayed: boolean;
}
export interface FinalizeSettlementCycleCommand extends AdjustmentCommand {
    cycleId: string;
    expectedCycleVersion: number;
}
export interface FinalizeSettlementCycleResult {
    spaceId: string;
    cycle: AssignmentCycle & {
        status: 'FINALIZED';
        finalizedAt: string;
        finalizedByPersonId: string;
    };
    affectedCycleIds: string[];
    replayed: boolean;
}
