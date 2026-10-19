import { Inject, Injectable } from '@nestjs/common';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import {
    planSettlementReversal,
    settlementReversalSourceKey,
} from '../../domain/settlement-reversal/settlement-reversal.js';
import type { SettlementResolutionKind } from '../models/settlement-reversal.js';
import {
    SETTLEMENT_REVERSAL_REPOSITORY,
    type SettlementReversalRepository,
} from '../ports/private/settlement-reversal.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import { requiresReversalCorrection } from '../handlers/reverse-settlement.handler.js';
@Injectable()
export class SettlementReversalOptionsQuery {
    constructor(
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly access: SpaceFinancialContextPort,
        @Inject(SETTLEMENT_REVERSAL_REPOSITORY)
        private readonly reversals: SettlementReversalRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    async execute(
        actor: PersonId,
        space: SpaceId,
        kind: SettlementResolutionKind,
        id: string,
    ) {
        await this.access.read(actor, space);
        const state = await this.reversals.state(space.value, kind, id);
        const context = await this.access.read(actor, space);
        if (!state)
            throw new FinancesError(
                kind === 'TRANSFER'
                    ? 'SETTLEMENT_TRANSFER_NOT_FOUND'
                    : 'SETTLEMENT_OFFSET_NOT_FOUND',
            );
        const requiresCorrectionCycle = requiresReversalCorrection(state);
        const reversalBlockReason =
            context.status === 'CLOSED'
                ? 'SPACE_CLOSED'
                : state.previousReversals.length
                  ? 'ALREADY_REVERSED'
                  : requiresCorrectionCycle
                    ? 'CORRECTION_CYCLE_REQUIRED'
                    : null;
        const finalizedIds = state.cycles
            .filter((c) => c.status === 'FINALIZED')
            .map((c) => c.id);
        const impact = state.previousReversals.length
            ? []
            : [
                  ...new Set(
                      state.obligations.map(settlementReversalSourceKey),
                  ),
              ].map((sourceKey) => {
                  const origins = state.obligations
                      .filter(
                          (o) => settlementReversalSourceKey(o) === sourceKey,
                      )
                      .map((o) => ({ ...o, spaceId: space.value }));
                  const applications = state.allocations.filter((a) =>
                      origins.some((o) => o.id === a.obligationId),
                  );
                  const plan = planSettlementReversal(
                      origins,
                      applications,
                      finalizedIds,
                  );
                  const target = plan.reusedObligation;
                  const remaining = target
                      ? (plan.changes.find((c) => c.obligation.id === target.id)
                            ?.remainingAmountInCents ??
                        target.remainingAmountInCents)
                      : (plan.newDifference?.amountInCents ?? 0);
                  const correction = applications.some(
                      (a) =>
                          (a.cycleId !== null &&
                              finalizedIds.includes(a.cycleId)) ||
                          origins.some(
                              (o) =>
                                  o.id === a.obligationId &&
                                  o.cycleId !== null &&
                                  finalizedIds.includes(o.cycleId),
                          ),
                  );
                  return {
                      originCommitmentId: origins[0].originCommitmentId,
                      occurrenceId: origins[0].occurrenceId,
                      originClosureAgreementId:
                          origins[0].originClosureAgreementId,
                      debtorMemberId:
                          target?.debtorMemberId ??
                          plan.newDifference?.debtorMemberId ??
                          null,
                      creditorMemberId:
                          target?.creditorMemberId ??
                          plan.newDifference?.creditorMemberId ??
                          null,
                      remainingAmountInCents: remaining,
                      requiresCorrectionCycle: correction,
                      affectedCurrentCycleIds: [
                          ...new Set(
                              plan.changes
                                  .map((c) => c.obligation.cycleId)
                                  .filter((id): id is string => id !== null),
                          ),
                      ],
                      newCorrectionObligation:
                          correction && plan.newDifference !== null,
                  };
              });
        return {
            spaceId: space.value,
            spaceStatus: context.status,
            spaceVersion: context.version,
            actorMemberId: context.actorMemberId,
            members: context.members,
            referenceDate: this.clock.today(),
            ...state,
            reversibleAmountInCents: state.previousReversals.length
                ? 0
                : state.original.amountInCents,
            requiresCorrectionCycle,
            canReverse: reversalBlockReason === null,
            reversalBlockReason,
            impact,
        };
    }
}
