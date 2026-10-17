import { Inject, Injectable } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
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
import { type InstallmentResolutionItem } from '../../domain/installment/installment-commitment.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import {
    INSTALLMENT_COMMITMENT_REPOSITORY,
    type InstallmentCommitmentRepository,
} from '../ports/private/installment-commitment.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import {
    digest,
    type Cancellation,
} from './installment-commitment.commands.js';
import { rootView } from './installment-commitment.models.js';
@Injectable()
export class CancelInstallmentCommitmentHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(INSTALLMENT_COMMITMENT_REPOSITORY)
        private readonly repository: InstallmentCommitmentRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}

    async cancelFuture(c: Cancellation) {
        const operation = 'CANCEL_FUTURE_INSTALLMENTS';
        const hash = digest(operation, c.spaceId.value, {
            ...c,
            actorId: undefined,
            spaceId: undefined,
            idempotencyKey: undefined,
        });
        const execute = () =>
            this.uow.execute(async () => {
                const access = await this.access.assertCanRead(
                    c.actorId,
                    c.spaceId,
                );
                const prior = await this.repository.findReceipt(
                    c.actorId.value,
                    operation,
                    c.idempotencyKey,
                    hash,
                );
                if (prior) return { ...(prior as object), replayed: true };
                const context =
                    access.type === 'SHARED'
                        ? await this.context.lockForFulfillment(
                              c.actorId,
                              c.spaceId,
                          )
                        : null;
                if (!context)
                    await this.access.assertCanWrite(c.actorId, c.spaceId);
                if (
                    (context !== null) !==
                    (c.expectedSpaceVersion !== undefined)
                )
                    throw new FinancesError('VALIDATION_ERROR', [
                        'expectedSpaceVersion',
                    ]);
                if (context && context.version !== c.expectedSpaceVersion)
                    throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
                const root = await this.repository.find(
                    c.spaceId.value,
                    c.commitmentId,
                    true,
                );
                if (
                    !root ||
                    (root.participation.type === 'SHARED') !==
                        (context !== null)
                )
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                const replay = await this.repository.findReceipt(
                    c.actorId.value,
                    operation,
                    c.idempotencyKey,
                    hash,
                );
                if (replay) return { ...(replay as object), replayed: true };
                if (root.version !== c.expectedCommitmentVersion)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const today = this.clock.today();
                if (civilDate(c.factDate) > today)
                    throw new FinancesError('VALIDATION_ERROR', ['factDate']);
                const open = root
                    .resolutionOptions()
                    .filter((item) => item.expectedRemainingAmountInCents > 0);
                const selected = c.installments.map((choice) =>
                    open.find(
                        (item) => item.installmentId === choice.installmentId,
                    ),
                );
                if (
                    new Set(c.installments.map((item) => item.installmentId))
                        .size !== c.installments.length ||
                    selected.some(
                        (item, index) =>
                            !item ||
                            item.expectedInstallmentVersion !==
                                c.installments[index]!
                                    .expectedInstallmentVersion ||
                            item.dueDate <= today,
                    )
                )
                    throw new FinancesError('INSTALLMENT_SELECTION_CHANGED');
                for (const item of selected as InstallmentResolutionItem[]) {
                    const occurrence = await this.repository.occurrence(
                        root,
                        item.installmentId,
                    );
                    if (
                        !occurrence ||
                        occurrence.facts.some(
                            (fact) => fact.kind === 'EXTERNAL_LIABILITY',
                        )
                    )
                        throw new FinancesError('OCCURRENCE_ALREADY_RESOLVED');
                    if (
                        occurrence.facts.some(
                            (fact) => fact.factDate > c.factDate,
                        )
                    )
                        throw new FinancesError('VALIDATION_ERROR', [
                            'factDate',
                        ]);
                }
                const now = this.clock.now().toISOString();
                await this.repository.cancelFuture(
                    root,
                    selected as InstallmentResolutionItem[],
                    c.reason,
                    c.actorId.value,
                    c.factDate,
                    now,
                );
                const updated = (await this.repository.find(
                    root.spaceId,
                    root.id,
                ))!;
                const result = {
                    commitment: rootView(updated),
                    cancelled: selected,
                    reason: c.reason,
                    factDate: c.factDate,
                    actorId: c.actorId.value,
                    replayed: false,
                };
                await this.repository.saveReceipt(
                    c.actorId.value,
                    c.spaceId.value,
                    root.id,
                    null,
                    operation,
                    c.idempotencyKey,
                    hash,
                    result,
                    now,
                );
                return result;
            });
        try {
            return await execute();
        } catch (error) {
            if (
                !(error instanceof QueryFailedError) ||
                error.driverError.code !== '23505'
            )
                throw error;
            return this.uow.execute(async () => {
                await this.access.assertCanRead(c.actorId, c.spaceId);
                const prior = await this.repository.findReceipt(
                    c.actorId.value,
                    operation,
                    c.idempotencyKey,
                    hash,
                );
                if (!prior) throw error;
                return { ...(prior as object), replayed: true };
            });
        }
    }
}
