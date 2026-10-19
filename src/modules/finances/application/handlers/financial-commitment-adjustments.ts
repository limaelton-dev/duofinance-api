import { Inject, Injectable } from '@nestjs/common';
import { assertRecurringClosureCutoff } from './assert-recurring-closure-cutoff.js';
import { randomUUID } from 'node:crypto';
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
import {
    assessFinancialAdjustment,
    type FinancialAdjustment,
    type FinancialCorrectionState,
} from '../../domain/corrections/financial-correction.js';
import { FinancesError } from '../../domain/errors/finances.error.js';

import { financialCorrectionOrigin } from './financial-correction-origin.js';
import type { AdjustmentDto } from '../../http/dto/financial-correction.dto.js';
import {
    FINANCIAL_CORRECTION_REPOSITORY,
    type FinancialCorrectionRepository,
} from '../ports/private/financial-correction.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import type { FinancialIntegrityCommand } from './financial-integrity-commands.js';
import { ReconcileFinancialOrigin } from './reconcile-financial-origin.js';

@Injectable()
export class FinancialCommitmentAdjustments {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly contexts: SpaceFinancialContextPort,
        @Inject(FINANCIAL_CORRECTION_REPOSITORY)
        private readonly repository: FinancialCorrectionRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
        private readonly reconcile: ReconcileFinancialOrigin,
    ) {}
    preview(actor: PersonId, space: SpaceId, id: string, input: AdjustmentDto) {
        return this.repository.snapshot(async () => {
            const { preview } = await this.assess(
                actor,
                space,
                id,
                input,
                false,
            );
            await this.access.assertCanRead(actor, space);
            return preview;
        });
    }
    async applyApproved(
        command: FinancialIntegrityCommand,
        input: AdjustmentDto,
        approval?: {
            proposedByMemberId: string;
            acceptedByMemberId: string;
            proposalId?: string;
        },
    ) {
        const { state, impact, preview } = await this.assess(
            command.actorId,
            command.spaceId,
            command.commitmentId,
            input,
            true,
            approval,
        );
        if (
            impact.requiresAcceptance &&
            (!approval ||
                approval.acceptedByMemberId !== impact.recipientMemberId)
        )
            throw new FinancesError('RECURRENCE_ACCEPTANCE_REQUIRED');
        const adjustment: FinancialAdjustment = {
            id: randomUUID(),
            spaceId: state.spaceId,
            commitmentId: state.id,
            targetId: state.targetId,
            occurrenceId: state.occurrenceId,
            installmentId: state.installmentId,
            commitmentVersion: state.version + 1,
            direction: input.direction,
            amountInCents: input.amountInCents,
            reason: input.reason,
            factDate: input.factDate,
            actorId: command.actorId.value,
            registeredAt: this.clock.now().toISOString(),
            previousAmountInCents: state.amountInCents!,
            resultingAmountInCents: impact.proposedAmountInCents,
            economicShares: impact.economicShares,
            shareChanges: impact.shareChanges,
            proposalId: approval?.proposalId ?? null,
        };
        await this.repository.adjust(state, adjustment);
        if (!state.personal && state.fulfilledAmountInCents > 0) {
            const synthetic = this.synthetic(state, adjustment);
            await this.reconcile.execute(
                synthetic,
                input.settlement ?? { mode: 'NONE' },
                command.actorId.value,
                this.clock.today(),
                adjustment.registeredAt,
                state.occurrenceId,
                {
                    id: adjustment.id,
                    factDate: adjustment.factDate,
                    kind: 'ADJUSTMENT',
                    preserveSettlementEffects: state.reversals.length > 0,
                },
            );
        }
        return { ...preview, adjustment, version: state.version + 1 };
    }
    private async assess(
        actor: PersonId,
        space: SpaceId,
        id: string,
        input: AdjustmentDto,
        lock: boolean,
        approval?: { proposedByMemberId: string; acceptedByMemberId: string },
    ) {
        const access = await this.access.assertCanRead(actor, space);
        const context =
            access.type === 'SHARED'
                ? lock
                    ? await this.contexts.lockForFulfillment(actor, space)
                    : await this.contexts.read(actor, space)
                : null;
        if (lock && !context) await this.access.assertCanWrite(actor, space);
        if ((context !== null) !== (input.expectedSpaceVersion !== undefined))
            throw new FinancesError('VALIDATION_ERROR', [
                'expectedSpaceVersion',
            ]);
        if (context && context.version !== input.expectedSpaceVersion)
            throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
        if (input.factDate > this.clock.today())
            throw new FinancesError('VALIDATION_ERROR', ['factDate']);
        const state = await this.repository.read(
            space.value,
            id,
            input,
            this.clock.now().toISOString(),
            lock,
        );
        if (!state) throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        if (state.modality === 'RECURRING' && state.referenceDate)
            assertRecurringClosureCutoff(
                context,
                state.referenceDate,
                state.facts.length,
            );
        if (state.version !== input.expectedCommitmentVersion)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        if (
            state.modality !== 'ONE_TIME' &&
            input.expectedOccurrenceVersion === undefined
        )
            throw new FinancesError('VALIDATION_ERROR', [
                'expectedOccurrenceVersion',
            ]);
        if (
            state.modality === 'ONE_TIME' &&
            input.expectedOccurrenceVersion !== undefined
        )
            throw new FinancesError('VALIDATION_ERROR', [
                'expectedOccurrenceVersion',
            ]);
        if (
            input.expectedOccurrenceVersion !== undefined &&
            state.occurrenceVersion !== input.expectedOccurrenceVersion
        )
            throw new FinancesError('CONCURRENT_MODIFICATION');
        if (state.cancelled)
            throw new FinancesError('FINANCIAL_COMMITMENT_CANCELLED');
        if (
            approval &&
            (!context ||
                context.actorMemberId !== approval.acceptedByMemberId ||
                !context.members.some(
                    (member) => member.memberId === approval.proposedByMemberId,
                ))
        )
            throw new FinancesError('VALIDATION_ERROR', ['approval']);
        const impact = assessFinancialAdjustment(
            state,
            input.direction,
            input.amountInCents,
            input.distribution,
            approval?.proposedByMemberId ?? context?.actorMemberId ?? null,
        );
        return {
            state,
            impact,
            preview: {
                commitmentId: id,
                kind: state.kind,
                modality: state.modality,
                target: {
                    type:
                        state.modality === 'ONE_TIME'
                            ? 'COMMITMENT'
                            : state.modality === 'RECURRING'
                              ? 'OCCURRENCE'
                              : 'INSTALLMENT',
                    id: state.projected ? null : state.targetId,
                    referenceDate: state.referenceDate,
                    occurrenceId: state.projected ? null : state.occurrenceId,
                    installmentId: state.installmentId,
                },
                currentVersion: state.version,
                expectedOccurrenceVersion:
                    state.modality === 'ONE_TIME'
                        ? undefined
                        : state.occurrenceVersion,
                originalAmountInCents: state.originalAmountInCents,
                previousAdjustments: state.adjustments,
                amountInCents: state.amountInCents,
                fulfilledAmountInCents: state.fulfilledAmountInCents,
                remainingAmountInCents:
                    state.amountInCents === null
                        ? null
                        : state.amountInCents - state.fulfilledAmountInCents,
                proposedAmountInCents: impact.proposedAmountInCents,
                proposedRemainingAmountInCents:
                    impact.proposedAmountInCents - state.fulfilledAmountInCents,
                economicShares: impact.economicShares,
                impactByMember: impact.impactByMember,
                requiresAcceptance: impact.requiresAcceptance,
                recipientMemberId: impact.recipientMemberId,
                cashImpactInCents: '0',
                supportedImpactInCents: '0',
                eligible: true,
            },
        };
    }
    private synthetic(
        state: FinancialCorrectionState,
        adjustment: FinancialAdjustment,
    ) {
        return financialCorrectionOrigin(
            {
                ...state,
                version: state.version + 1,
                amountInCents: adjustment.resultingAmountInCents,
                shares: adjustment.economicShares,
                adjustments: state.adjustments.concat(adjustment),
            },
            this.clock.today(),
        );
    }
}
