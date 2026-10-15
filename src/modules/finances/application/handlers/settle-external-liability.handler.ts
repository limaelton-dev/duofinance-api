import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
    UNIT_OF_WORK,
    type UnitOfWork,
} from '../../../../shared/application/unit-of-work.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../../spaces/application/ports/public/space-access.port.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import {
    FINANCIAL_COMMITMENT_REPOSITORY,
    FINANCES_CLOCK,
    ExpenseReceiptRaceError,
    type FinancialCommitmentRepository,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import {
    EXTERNAL_LIABILITY_SETTLEMENT_RECEIPTS,
    EXTERNAL_LIABILITY_SETTLEMENT_REPOSITORY,
    type ExternalLiabilitySettlementReceipts,
    type ExternalLiabilitySettlementRepository,
} from '../ports/private/external-liability-settlement.ports.js';
import { personalExpenseView } from '../models/personal-expense.js';
import type {
    SettleExternalLiabilityCommand,
    ExternalLiabilitySettlementResult,
} from '../models/external-liability-settlement.js';
import type {
    FinancialCommitment,
    PersonalCommitmentVersion,
} from '../../domain/shared-expense/financial-commitment.js';
@Injectable()
export class SettleExternalLiabilityHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(FINANCIAL_COMMITMENT_REPOSITORY)
        private readonly commitments: FinancialCommitmentRepository,
        @Inject(EXTERNAL_LIABILITY_SETTLEMENT_REPOSITORY)
        private readonly settlements: ExternalLiabilitySettlementRepository,
        @Inject(EXTERNAL_LIABILITY_SETTLEMENT_RECEIPTS)
        private readonly receipts: ExternalLiabilitySettlementReceipts,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    private async authorized(c: SettleExternalLiabilityCommand) {
        const access = await this.access.assertCanRead(c.actorId, c.spaceId);
        const context =
            access.type === 'SHARED'
                ? await this.context.read(c.actorId, c.spaceId)
                : null;
        const liability = await this.settlements.findHolder(
            c.spaceId.value,
            c.commitmentId,
            c.externalLiabilityId,
        );
        if (
            !liability ||
            (access.type === 'PERSONAL') !==
                (liability.personalOwnerPersonId !== null)
        )
            throw new FinancesError('EXTERNAL_LIABILITY_NOT_FOUND');
        if (
            liability.holderMemberId
                ? liability.holderMemberId !== context?.actorMemberId
                : liability.holderPersonId !== c.actorId.value
        )
            throw new FinancesError('EXTERNAL_LIABILITY_HOLDER_REQUIRED');
        return access;
    }
    async execute(
        c: SettleExternalLiabilityCommand,
    ): Promise<ExternalLiabilitySettlementResult> {
        try {
            return await this.uow.execute(async () => {
                const access = await this.authorized(c);
                const previous = await this.receipts.find(c);
                if (previous) return { ...previous, replayed: true };
                const shared = access.type === 'SHARED';
                if (shared !== (c.expectedSpaceVersion !== undefined))
                    throw new FinancesError('VALIDATION_ERROR', [
                        'expectedSpaceVersion',
                    ]);
                const context = shared
                    ? await this.context.lockForFulfillment(
                          c.actorId,
                          c.spaceId,
                      )
                    : null;
                if (!shared)
                    await this.access.assertCanWrite(c.actorId, c.spaceId);
                if (context && context.version !== c.expectedSpaceVersion)
                    throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
                const existing = await this.commitments.find(
                    c.spaceId.value,
                    c.commitmentId,
                    true,
                );
                if (!existing)
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                const replay = await this.receipts.find(c);
                if (replay) return { ...replay, replayed: true };
                const liability = existing.externalLiabilities.find(
                    (f) => f.id === c.externalLiabilityId,
                );
                if (!liability)
                    throw new FinancesError('EXTERNAL_LIABILITY_NOT_FOUND');
                if (
                    'holderMemberId' in liability
                        ? liability.holderMemberId !== context?.actorMemberId
                        : liability.holderPersonId !== c.actorId.value
                )
                    throw new FinancesError(
                        'EXTERNAL_LIABILITY_HOLDER_REQUIRED',
                    );
                const now = this.clock.now().toISOString();
                const next = existing.settleExternalLiability(
                    c.externalLiabilityId,
                    {
                        id: randomUUID(),
                        amountInCents: c.amountInCents,
                        factDate: c.factDate,
                        registeredAt: now,
                        recordedByPersonId: c.actorId.value,
                    },
                    c.expectedCommitmentVersion,
                    this.clock.today(),
                );
                await this.settlements.saveExternalLiabilitySettlement(next, c);
                const detail = shared
                    ? await this.commitments.detail(
                          c.spaceId.value,
                          c.commitmentId,
                      )
                    : personalExpenseView(
                          next as FinancialCommitment<PersonalCommitmentVersion>,
                      );
                if (!detail) throw new Error('Persisted expense missing');
                const result = {
                    ...detail,
                    ...(context ? { members: context.members } : {}),
                    settlement: next.externalLiabilities
                        .find((f) => f.id === c.externalLiabilityId)!
                        .settlements!.at(-1)!,
                    replayed: false,
                };
                await this.receipts.save(c, result, now);
                return result;
            });
        } catch (error) {
            if (!(error instanceof ExpenseReceiptRaceError)) throw error;
            return this.uow.execute(async () => {
                await this.authorized(c);
                const previous = await this.receipts.find(c);
                if (!previous) throw error;
                return { ...previous, replayed: true };
            });
        }
    }
}
