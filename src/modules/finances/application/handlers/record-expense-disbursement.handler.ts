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
    EXPENSE_DISBURSEMENT_RECEIPTS,
    type ExpenseDisbursementReceipts,
} from '../ports/private/expense-disbursement.ports.js';
import { personalExpenseView } from '../models/personal-expense.js';
import type {
    RecordExpenseDisbursementCommand,
    ExpenseDisbursementResult,
} from '../models/expense-disbursement.js';
import type {
    FinancialCommitment,
    PersonalCommitmentVersion,
} from '../../domain/shared-expense/financial-commitment.js';
import { ReconcileFinancialOrigin } from './reconcile-financial-origin.js';
@Injectable()
export class RecordExpenseDisbursementHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(FINANCIAL_COMMITMENT_REPOSITORY)
        private readonly commitments: FinancialCommitmentRepository,
        @Inject(EXPENSE_DISBURSEMENT_RECEIPTS)
        private readonly receipts: ExpenseDisbursementReceipts,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
        private readonly reconcile: ReconcileFinancialOrigin,
    ) {}
    async execute(
        c: RecordExpenseDisbursementCommand,
    ): Promise<ExpenseDisbursementResult> {
        try {
            return await this.uow.execute(async () => {
                const access = await this.access.assertCanRead(
                    c.actorId,
                    c.spaceId,
                );
                const previous = await this.receipts.find(c);
                if (previous) return { ...previous, replayed: true };
                const shared = access.type === 'SHARED';
                if (shared !== 'payerMemberId' in c)
                    throw new FinancesError(
                        shared
                            ? 'SHARED_SPACE_REQUIRED'
                            : 'PERSONAL_SPACE_REQUIRED',
                    );
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
                if (!existing || shared !== 'split' in existing.initialVersion)
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                const replay = await this.receipts.find(c);
                if (replay) return { ...replay, replayed: true };
                const p = existing.initialVersion;
                if (
                    context &&
                    'split' in p &&
                    (!context.members.some(
                        (m) => m.memberId === c.payerMemberId,
                    ) ||
                        !p.split.shares.some(
                            (s) => s.memberId === c.payerMemberId,
                        ))
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'payerMemberId',
                    ]);
                const now = this.clock.now().toISOString(),
                    today = this.clock.today();
                const next = existing.recordDisbursement(
                    {
                        id: randomUUID(),
                        amountInCents: c.amountInCents,
                        factDate: c.factDate,
                        method: c.method,
                        registeredAt: now,
                        recordedByPersonId: c.actorId.value,
                        ...(shared
                            ? { payerMemberId: c.payerMemberId! }
                            : { payerPersonId: c.actorId.value }),
                    },
                    c.expectedCommitmentVersion,
                    today,
                );
                await this.commitments.saveDisbursement(next, existing.version);
                if (shared)
                    await this.reconcile.execute(
                        next,
                        c.settlement!,
                        c.actorId.value,
                        today,
                        now,
                    );
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
                    replayed: false,
                };
                await this.receipts.save(c, result, now);
                return result;
            });
        } catch (error) {
            if (!(error instanceof ExpenseReceiptRaceError)) throw error;
            return this.uow.execute(async () => {
                await this.access.assertCanRead(c.actorId, c.spaceId);
                const previous = await this.receipts.find(c);
                if (!previous) throw error;
                return { ...previous, replayed: true };
            });
        }
    }
}
