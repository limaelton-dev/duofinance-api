import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
import { type OccurrenceFact } from '../../domain/recurrence/financial-occurrence.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import type { SettlementSelection } from '../../domain/shared-expense/settlement-selection.js';
import {
    INSTALLMENT_COMMITMENT_REPOSITORY,
    type InstallmentCommitmentRepository,
} from '../ports/private/installment-commitment.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import { ReconcileFinancialOrigin } from './reconcile-financial-origin.js';
import { digest, type Fulfillment } from './installment-commitment.commands.js';
import { rootView, installmentView } from './installment-commitment.models.js';
import { synthetic as syntheticOrigin } from './installment-commitment.origin.js';
@Injectable()
export class RecordInstallmentCommitmentHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(INSTALLMENT_COMMITMENT_REPOSITORY)
        private readonly repository: InstallmentCommitmentRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
        private readonly reconcile: ReconcileFinancialOrigin,
    ) {}

    async record(c: Fulfillment) {
        const operation =
            c.kind === 'DISBURSEMENT'
                ? 'RECORD_INSTALLMENT_DISBURSEMENT'
                : c.kind === 'EXTERNAL_LIABILITY'
                  ? 'RECORD_INSTALLMENT_EXTERNAL_LIABILITY'
                  : 'SETTLE_INSTALLMENT_EXTERNAL_LIABILITY';
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
                if ((context !== null) !== 'expectedSpaceVersion' in c)
                    throw new FinancesError('VALIDATION_ERROR', [
                        'expectedSpaceVersion',
                    ]);
                if (
                    context &&
                    context.version !==
                        ('expectedSpaceVersion' in c
                            ? c.expectedSpaceVersion
                            : undefined)
                )
                    throw new FinancesError('EXPENSE_OPTIONS_CHANGED');
                const root = await this.repository.find(
                    c.spaceId.value,
                    c.commitmentId,
                    true,
                );
                if (
                    !root ||
                    !root.plan.installments.some(
                        (item) => item.id === c.installmentId,
                    ) ||
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
                if (
                    root.plan.installments.find(
                        (item) => item.id === c.installmentId,
                    )?.remainingAmountInCents === 0 &&
                    c.kind !== 'SETTLE_EXTERNAL_LIABILITY'
                )
                    throw new FinancesError('OCCURRENCE_ALREADY_RESOLVED');
                const occurrence = await this.repository.occurrence(
                    root,
                    c.installmentId,
                );
                if (!occurrence)
                    throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
                if (occurrence.stateVersion !== c.expectedInstallmentVersion)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const now = this.clock.now().toISOString();
                const today = this.clock.today();
                if (civilDate(c.factDate) > today)
                    throw new FinancesError('VALIDATION_ERROR', ['factDate']);
                if (c.kind === 'SETTLE_EXTERNAL_LIABILITY') {
                    const liability = occurrence.facts.find(
                        (fact) =>
                            fact.kind === 'EXTERNAL_LIABILITY' &&
                            fact.id === c.liabilityId,
                    );
                    if (!liability || liability.kind !== 'EXTERNAL_LIABILITY')
                        throw new FinancesError('EXTERNAL_LIABILITY_NOT_FOUND');
                    if (
                        liability.holderMemberId
                            ? liability.holderMemberId !==
                              context?.actorMemberId
                            : liability.holderPersonId !== c.actorId.value
                    )
                        throw new FinancesError(
                            'EXTERNAL_LIABILITY_HOLDER_REQUIRED',
                        );
                    if (c.amountInCents > liability.remainingAmountInCents)
                        throw new FinancesError('CONCURRENT_MODIFICATION');
                    const settlement = await this.repository.settleExternal(
                        root,
                        occurrence,
                        c.liabilityId,
                        c.amountInCents,
                        c.factDate,
                        c.actorId.value,
                        now,
                    );
                    const updatedRoot = (await this.repository.find(
                        root.spaceId,
                        root.id,
                    ))!;
                    const updated = (await this.repository.occurrence(
                        updatedRoot,
                        c.installmentId,
                    ))!;
                    const result = {
                        commitment: rootView(updatedRoot),
                        installment: installmentView(
                            updatedRoot,
                            updatedRoot.plan.installments.find(
                                (item) => item.id === c.installmentId,
                            )!,
                            updated,
                        ),
                        settlement,
                        replayed: false,
                    };
                    await this.repository.saveReceipt(
                        c.actorId.value,
                        c.spaceId.value,
                        root.id,
                        c.installmentId,
                        operation,
                        c.idempotencyKey,
                        hash,
                        result,
                        now,
                    );
                    return result;
                }
                const memberId =
                    c.kind === 'DISBURSEMENT'
                        ? 'payerMemberId' in c
                            ? c.payerMemberId
                            : null
                        : 'holderMemberId' in c
                          ? c.holderMemberId
                          : null;
                if (
                    context &&
                    (!memberId ||
                        !context.members.some(
                            (member) => member.memberId === memberId,
                        ))
                )
                    throw new FinancesError('VALIDATION_ERROR', ['memberId']);
                const common = {
                    id: randomUUID(),
                    amountInCents: c.amountInCents,
                    factDate: c.factDate,
                    registeredAt: now,
                    recordedByPersonId: c.actorId.value,
                };
                const fact: OccurrenceFact =
                    c.kind === 'DISBURSEMENT'
                        ? {
                              ...common,
                              kind: 'DISBURSEMENT',
                              method: c.method,
                              payerMemberId: context ? memberId : null,
                              payerPersonId: context ? null : c.actorId.value,
                          }
                        : {
                              ...common,
                              kind: 'EXTERNAL_LIABILITY',
                              holderMemberId: context ? memberId : null,
                              holderPersonId: context ? null : c.actorId.value,
                              remainingAmountInCents: c.amountInCents,
                          };
                const next = occurrence.record(
                    fact,
                    c.expectedInstallmentVersion,
                    today,
                );
                await this.repository.record(root, next, fact);
                if (context) {
                    const synthetic = syntheticOrigin(root, next, today);
                    await this.reconcile.execute(
                        synthetic,
                        ('settlement' in c
                            ? c.settlement
                            : undefined) as SettlementSelection,
                        c.actorId.value,
                        today,
                        now,
                        c.installmentId,
                    );
                }
                const updatedRoot = (await this.repository.find(
                    root.spaceId,
                    root.id,
                ))!;
                const result = {
                    commitment: rootView(updatedRoot),
                    installment: installmentView(
                        updatedRoot,
                        updatedRoot.plan.installments.find(
                            (item) => item.id === c.installmentId,
                        )!,
                        next,
                    ),
                    replayed: false,
                };
                await this.repository.saveReceipt(
                    c.actorId.value,
                    c.spaceId.value,
                    root.id,
                    c.installmentId,
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
