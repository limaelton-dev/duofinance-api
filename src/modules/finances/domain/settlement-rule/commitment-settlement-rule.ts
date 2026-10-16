import { FinancesError } from '../errors/finances.error.js';
import {
    SettlementRule,
    type SettlementRuleSnapshot,
} from './settlement-rule.js';

export class CommitmentSettlementRule {
    readonly rule: SettlementRule;
    constructor(
        readonly commitmentId: string,
        readonly commitmentVersion: number,
        rule: SettlementRuleSnapshot,
        readonly version: number,
    ) {
        this.rule = SettlementRule.from(rule);
        if (
            !Number.isSafeInteger(commitmentVersion) ||
            commitmentVersion < 1 ||
            !Number.isSafeInteger(version) ||
            version < 1
        )
            throw new FinancesError('VALIDATION_ERROR');
        Object.freeze(this);
    }
    static configure(
        commitmentId: string,
        currentCommitmentVersion: number,
        expectedCommitmentVersion: number,
        rule: SettlementRuleSnapshot,
        previousVersion: number,
    ) {
        if (currentCommitmentVersion !== expectedCommitmentVersion)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        if (!Number.isSafeInteger(previousVersion) || previousVersion < 0)
            throw new FinancesError('VALIDATION_ERROR');
        return new CommitmentSettlementRule(
            commitmentId,
            currentCommitmentVersion + 1,
            rule,
            currentCommitmentVersion + 1,
        );
    }
}
