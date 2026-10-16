import { Inject, Injectable, Optional } from '@nestjs/common';
import {
    SETTLEMENT_ADJUSTMENT_REPOSITORY,
    type SettlementAdjustmentRepository,
} from '../ports/private/settlement-adjustment.repository.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../../spaces/application/ports/public/space-access.port.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import { SettlementRule } from '../../domain/settlement-rule/settlement-rule.js';
import {
    FINANCIAL_COMMITMENT_REPOSITORY,
    FINANCES_CLOCK,
    SETTLEMENT_CYCLE_REPOSITORY,
    type FinancialCommitmentRepository,
    type FinancesClock,
    type SettlementCycleRepository,
} from '../ports/private/shared-expense.repositories.js';
import {
    decodeExpenseCursor,
    encodeExpenseCursor,
} from './shared-cash-expense.queries.js';
@Injectable()
export class GetExpenseDisbursementOptionsQuery {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(FINANCIAL_COMMITMENT_REPOSITORY)
        private readonly commitments: FinancialCommitmentRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
        @Inject(SETTLEMENT_CYCLE_REPOSITORY)
        private readonly cycles: SettlementCycleRepository,
        @Optional()
        @Inject(SETTLEMENT_ADJUSTMENT_REPOSITORY)
        private readonly adjustments?: SettlementAdjustmentRepository,
    ) {}
    async execute(
        actor: PersonId,
        space: SpaceId,
        commitmentId: string,
        cursor?: string,
    ) {
        await this.access.assertCanRead(actor, space);
        const result = await (this.adjustments
            ? this.adjustments.readSnapshot(() =>
                  this.inSnapshot(actor, space, commitmentId, cursor),
              )
            : this.inSnapshot(actor, space, commitmentId, cursor));
        const access = await this.access.assertCanRead(actor, space);
        if (access.type === 'SHARED') {
            const latest = await this.context.read(actor, space);
            return {
                ...result,
                expectedSpaceVersion: latest.version,
                canDisburse:
                    result.remainingAmountInCents > 0 &&
                    latest.status !== 'CLOSED',
            };
        }
        return {
            ...result,
            canDisburse:
                result.remainingAmountInCents > 0 && access.status === 'ACTIVE',
        };
    }
    private async inSnapshot(
        actor: PersonId,
        space: SpaceId,
        commitmentId: string,
        cursor?: string,
    ) {
        const access = await this.access.assertCanRead(actor, space);
        const c = await this.commitments.find(space.value, commitmentId);
        if (!c || (access.type === 'SHARED') !== 'split' in c.initialVersion)
            throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const common = {
            spaceId: space.value,
            spaceType: access.type,
            commitmentId,
            expectedCommitmentVersion: c.version,
            amountInCents: c.supportedAmountInCents + c.remainingAmountInCents,
            paidAmountInCents: c.paidAmountInCents,
            remainingAmountInCents: c.remainingAmountInCents,
            referenceDate: this.clock.today(),
            canDisburse:
                c.remainingAmountInCents > 0 &&
                (access.type === 'PERSONAL'
                    ? access.status === 'ACTIVE'
                    : access.status !== 'CLOSED'),
            disbursementMethods: ['PIX', 'DEBIT', 'CASH'],
        };
        if (access.type === 'PERSONAL') {
            if (cursor !== undefined)
                throw new FinancesError('VALIDATION_ERROR', ['cursor']);
            await this.access.assertCanRead(actor, space);
            return common;
        }
        const context = await this.context.read(actor, space);
        const p = c.initialVersion;
        if (!('split' in p))
            throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const settlementRule = this.adjustments
            ? await this.adjustments.effectiveRule(
                  space.value,
                  commitmentId,
                  p.settlementRuleSnapshot,
                  p.settlementRuleSourceVersion,
              )
            : {
                  source: 'INHERITED' as const,
                  rule: p.settlementRuleSnapshot,
                  version: p.settlementRuleSourceVersion,
              };
        const cycles = await this.cycles.listOpen(
            space.value,
            decodeExpenseCursor(cursor, space.value),
        );
        const page = cycles.slice(0, 20),
            last = page.at(-1);
        await this.context.read(actor, space);
        return {
            ...common,
            expectedSpaceVersion: context.version,
            members: context.members.filter((m) =>
                p.split.shares.some((s) => s.memberId === m.memberId),
            ),
            responsibilitySplit: {
                ...p.split.original,
                calculatedShares: p.split.shares.map((s) => ({ ...s })),
            },
            expectedPayerMemberId: p.expectedPayerMemberId,
            defaultSettlementRule: {
                rule: p.settlementRuleSnapshot,
                version: p.settlementRuleSourceVersion,
            },
            settlementRule,
            suggestedTargetDate: settlementRule.rule
                ? SettlementRule.from(settlementRule.rule).suggestTargetDate(
                      common.referenceDate,
                  )
                : null,
            openCycles: page.map((s) => ({
                id: s.id,
                targetDate: s.targetDate,
                version: s.version,
            })),
            nextCursor:
                cycles.length > 20 && last
                    ? encodeExpenseCursor(space.value, last.targetDate, last.id)
                    : null,
        };
    }
}
