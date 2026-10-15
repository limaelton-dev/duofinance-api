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
    FINANCIAL_COMMITMENT_REPOSITORY,
    FINANCES_CLOCK,
    ExpenseReceiptRaceError,
    type FinancialCommitmentRepository,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import {
    PERSONAL_EXPENSE_RECEIPTS,
    type PersonalExpenseReceipts,
} from '../ports/private/personal-expense.ports.js';
import {
    FinancialCommitment,
    type PersonalCommitmentVersion,
} from '../../domain/shared-expense/financial-commitment.js';
import { Money } from '../../domain/shared-expense/money.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import {
    personalExpenseView,
    type RecordPersonalExpenseCommand,
    type PersonalExpenseResult,
} from '../models/personal-expense.js';
@Injectable()
export class RecordPersonalExpenseHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(FINANCIAL_COMMITMENT_REPOSITORY)
        private readonly commitments: FinancialCommitmentRepository,
        @Inject(PERSONAL_EXPENSE_RECEIPTS)
        private readonly receipts: PersonalExpenseReceipts,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    async execute(
        c: RecordPersonalExpenseCommand,
    ): Promise<PersonalExpenseResult> {
        try {
            return await this.uow.execute(async () => {
                const context = await this.access.assertCanWrite(
                    c.actorId,
                    c.spaceId,
                );
                if (context.type !== 'PERSONAL')
                    throw new FinancesError('PERSONAL_SPACE_REQUIRED');
                const receipt = await this.receipts.find(c);
                if (receipt) return { ...receipt, replayed: true };
                const today = this.clock.today(),
                    registeredAt = this.clock.now().toISOString();
                if (civilDate(c.factDate) > today)
                    throw new FinancesError('VALIDATION_ERROR', ['factDate']);
                const commitment =
                    new FinancialCommitment<PersonalCommitmentVersion>(
                        randomUUID(),
                        c.spaceId.value,
                        c.description.trim(),
                        c.actorId.value,
                        registeredAt,
                        {
                            version: 1,
                            ownerPersonId: c.actorId.value,
                            amount: Money.from(c.amountInCents),
                            factDate: c.factDate,
                        },
                        {
                            id: randomUUID(),
                            payerPersonId: c.actorId.value,
                            method: c.disbursement.method,
                            amountInCents:
                                c.disbursement.amountInCents ?? c.amountInCents,
                            recordedByPersonId: c.actorId.value,
                            factDate: c.factDate,
                            registeredAt,
                        },
                        today,
                    );
                await this.commitments.save(commitment);
                const result = {
                    ...personalExpenseView(commitment),
                    replayed: false,
                };
                await this.receipts.save(c, result, registeredAt);
                return result;
            });
        } catch (error) {
            if (!(error instanceof ExpenseReceiptRaceError)) throw error;
            return this.uow.execute(async () => {
                const context = await this.access.assertCanRead(
                    c.actorId,
                    c.spaceId,
                );
                if (context.type !== 'PERSONAL')
                    throw new FinancesError('PERSONAL_SPACE_REQUIRED');
                const receipt = await this.receipts.find(c);
                if (!receipt) throw error;
                return { ...receipt, replayed: true };
            });
        }
    }
}
