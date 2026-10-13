import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
    UNIT_OF_WORK,
    type UnitOfWork,
} from '../../../../shared/application/unit-of-work.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import { SettlementTransfer } from '../../domain/settlement-transfer/settlement-transfer.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import type {
    RecordSettlementTransferCommand,
    SettlementTransferResult,
} from '../models/settlement-transfer.js';
import {
    SETTLEMENT_TRANSFER_RECEIPTS,
    SETTLEMENT_TRANSFER_REPOSITORY,
    SettlementTransferReceiptRaceError,
    type SettlementTransferReceipts,
    type SettlementTransferRepository,
} from '../ports/private/settlement-transfer.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';

@Injectable()
export class RecordManualSettlementTransferHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(SETTLEMENT_TRANSFER_REPOSITORY)
        private readonly transfers: SettlementTransferRepository,
        @Inject(SETTLEMENT_TRANSFER_RECEIPTS)
        private readonly receipts: SettlementTransferReceipts,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    async execute(
        c: RecordSettlementTransferCommand,
    ): Promise<SettlementTransferResult> {
        if (!Number.isSafeInteger(c.amountInCents) || c.amountInCents <= 0)
            throw new FinancesError('VALIDATION_ERROR', ['amountInCents']);
        if (
            !c.allocations.length ||
            c.allocations.some(
                (a) =>
                    !Number.isSafeInteger(a.amountInCents) ||
                    a.amountInCents <= 0 ||
                    !Number.isSafeInteger(a.expectedObligationVersion) ||
                    a.expectedObligationVersion <= 0,
            ) ||
            new Set(c.allocations.map((a) => a.obligationId.toLowerCase()))
                .size !== c.allocations.length ||
            c.allocations.reduce(
                (sum, a) => sum + BigInt(a.amountInCents),
                0n,
            ) !== BigInt(c.amountInCents)
        )
            throw new FinancesError('VALIDATION_ERROR', ['allocations']);
        try {
            return await this.uow.execute(async () => {
                await this.context.read(c.actorId, c.spaceId);
                const existing = await this.receipts.find(c);
                if (existing) return { ...existing, replayed: true };
                const context = await this.context.lockForSettlement(
                    c.actorId,
                    c.spaceId,
                );
                if (context.version !== c.expectedSpaceVersion)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                if (
                    c.payerMemberId === c.recipientMemberId ||
                    !context.members.some(
                        (m) => m.memberId === c.payerMemberId,
                    ) ||
                    !context.members.some(
                        (m) => m.memberId === c.recipientMemberId,
                    )
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'payerMemberId',
                        'recipientMemberId',
                    ]);
                if (civilDate(c.factDate) > this.clock.today())
                    throw new FinancesError('VALIDATION_ERROR', ['factDate']);
                const ids = c.allocations.map((a) => a.obligationId).sort();
                const discovered = await this.transfers.discover(
                    c.spaceId.value,
                    ids,
                );
                if (discovered.length !== ids.length)
                    throw new FinancesError(
                        'INTER_MEMBER_OBLIGATION_NOT_FOUND',
                    );
                await this.transfers.lockCycles(
                    c.spaceId.value,
                    [
                        ...new Set(
                            discovered
                                .map((o) => o.cycleId)
                                .filter((id): id is string => id !== null),
                        ),
                    ].sort(),
                );
                const before = await this.transfers.lockObligations(
                    c.spaceId.value,
                    ids,
                );
                const concurrentReceipt = await this.receipts.find(c);
                if (concurrentReceipt)
                    return { ...concurrentReceipt, replayed: true };
                if (before.length !== ids.length)
                    throw new FinancesError(
                        'INTER_MEMBER_OBLIGATION_NOT_FOUND',
                    );
                const cycles = new Map(
                    discovered.map((o) => [o.id, o.cycleId]),
                );
                if (before.some((o) => o.cycleId !== cycles.get(o.id)))
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const allocations = c.allocations.map((a) => {
                    const obligation = before.find(
                        (o) => o.id === a.obligationId,
                    )!;
                    if (
                        obligation.debtorMemberId !== c.payerMemberId ||
                        obligation.creditorMemberId !== c.recipientMemberId
                    )
                        throw new FinancesError('VALIDATION_ERROR', [
                            'allocations',
                        ]);
                    return {
                        id: randomUUID(),
                        obligationId: a.obligationId,
                        cycleId: obligation.cycleId,
                        amountInCents: a.amountInCents,
                    };
                });
                const after = c.allocations.map((a) =>
                    before
                        .find((o) => o.id === a.obligationId)!
                        .applySettlement(
                            allocations.find(
                                (x) => x.obligationId === a.obligationId,
                            )!.id,
                            a.amountInCents,
                            a.expectedObligationVersion,
                        ),
                );
                const transfer = new SettlementTransfer(
                    randomUUID(),
                    c.spaceId.value,
                    c.payerMemberId,
                    c.recipientMemberId,
                    c.amountInCents,
                    c.factDate,
                    this.clock.now().toISOString(),
                    c.actorId.value,
                    allocations,
                );
                await this.transfers.save(transfer, before, after);
                const detail = await this.transfers.detail(
                    c.spaceId.value,
                    transfer.id,
                );
                if (!detail)
                    throw new Error('Persisted settlement transfer missing');
                const result = { ...detail, replayed: false };
                await this.receipts.save(c, result);
                return result;
            });
        } catch (error) {
            if (!(error instanceof SettlementTransferReceiptRaceError))
                throw error;
            return this.uow.execute(async () => {
                await this.context.read(c.actorId, c.spaceId);
                const receipt = await this.receipts.find(c);
                if (!receipt) throw error;
                return { ...receipt, replayed: true };
            });
        }
    }
}
