import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import {
    type FinancialCorrectionRepository,
    type FinancialCorrectionTarget,
} from '../../../application/ports/private/financial-correction.repository.js';
import {
    FINANCIAL_COMMITMENT_REPOSITORY,
    type FinancialCommitmentRepository,
} from '../../../application/ports/private/shared-expense.repositories.js';
import {
    INCOME_REPOSITORY,
    type IncomeRepository,
} from '../../../application/ports/private/income.ports.js';
import {
    RECURRING_COMMITMENT_REPOSITORY,
    type RecurringCommitmentRepository,
} from '../../../application/ports/private/recurring-commitment.repository.js';
import {
    INSTALLMENT_COMMITMENT_REPOSITORY,
    type InstallmentCommitmentRepository,
} from '../../../application/ports/private/installment-commitment.repository.js';
import type {
    FinancialAdjustment,
    FinancialCancellation,
    FinancialCorrectionState,
} from '../../../domain/corrections/financial-correction.js';
import type { OccurrenceFact } from '../../../domain/recurrence/financial-occurrence.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import { FinancialCommitmentOrmEntity } from '../entities/shared-expense.orm-entity.js';
import { financialFulfillmentReversals } from '../queries/financial-fulfillment-reversal-projection.js';
import { FinancialOccurrenceOrmEntity } from '../entities/recurrence.orm-entity.js';
import {
    FinancialCommitmentAdjustmentOrmEntity,
    FinancialCommitmentCancellationOrmEntity,
} from '../entities/financial-correction.orm-entity.js';
import { financialCorrections } from '../queries/financial-correction-projection.js';
import { assertFinancialClosureOriginOpen } from './assert-financial-closure-origin-open.js';

@Injectable()
export class TypeOrmFinancialCorrectionRepository implements FinancialCorrectionRepository {
    constructor(
        private readonly managers: EntityManagerProvider,
        @Inject(FINANCIAL_COMMITMENT_REPOSITORY)
        private readonly expenses: FinancialCommitmentRepository,
        @Inject(INCOME_REPOSITORY) private readonly incomes: IncomeRepository,
        @Inject(RECURRING_COMMITMENT_REPOSITORY)
        private readonly recurring: RecurringCommitmentRepository,
        @Inject(INSTALLMENT_COMMITMENT_REPOSITORY)
        private readonly installments: InstallmentCommitmentRepository,
    ) {}
    snapshot<T>(work: () => Promise<T>) {
        return this.managers.readSnapshot(work);
    }
    async read(
        spaceId: string,
        id: string,
        target: FinancialCorrectionTarget,
        now: string,
        lock = false,
    ): Promise<FinancialCorrectionState | null> {
        const manager = this.managers.get();
        const query = manager
            .createQueryBuilder(FinancialCommitmentOrmEntity, 'c')
            .where('c.space_id=:spaceId AND c.id=:id', { spaceId, id });
        if (lock) query.setLock('pessimistic_write');
        const meta = await query.getOne();
        if (!meta) return null;
        const common = {
            id,
            spaceId,
            kind: meta.kind as 'EXPENSE' | 'INCOME',
            modality: meta.modality as FinancialCorrectionState['modality'],
            description: meta.description,
            createdByPersonId: meta.createdBy,
            registeredAt: meta.registeredAt.toISOString(),
            version: meta.version,
            personal: meta.personalOwnerPersonId !== null,
        };
        let state: Omit<
            FinancialCorrectionState,
            'adjustments' | 'cancellation' | 'reversals'
        >;
        if (meta.modality === 'ONE_TIME') {
            if (
                target.occurrenceId ||
                target.referenceDate ||
                target.installmentId
            )
                throw new FinancesError('VALIDATION_ERROR', [
                    'occurrenceId',
                    'referenceDate',
                    'installmentId',
                ]);
            if (meta.kind === 'INCOME') {
                const root = (await this.incomes.find(spaceId, id, lock))!;
                const p = root.participation;
                state = {
                    ...common,
                    targetId: id,
                    referenceDate: root.expectedReceiptDate,
                    occurrenceId: null,
                    installmentId: null,
                    occurrenceVersion: 1,
                    economicVersion: 1,
                    projected: false,
                    cancelled: root.status === 'CANCELLED',
                    resolved: false,
                    originalAmountInCents: root.amountInCents,
                    amountInCents: root.amountInCents,
                    fulfilledAmountInCents: root.receivedAmountInCents,
                    shares: p.type === 'SHARED' ? p.split.shares : null,
                    distribution: p.type === 'SHARED' ? p.split.original : null,
                    expectedMemberId:
                        p.type === 'SHARED'
                            ? p.expectedRecipientMemberId
                            : null,
                    settlementRuleSnapshot:
                        p.type === 'SHARED' ? p.settlementRuleSnapshot : null,
                    settlementRuleSourceVersion:
                        p.type === 'SHARED' ? p.settlementRuleSourceVersion : 0,
                    facts: root.validReceipts.map((fact) => ({
                        ...fact,
                        kind: 'RECEIPT',
                    })),
                };
            } else {
                const root = (await this.expenses.find(spaceId, id, lock))!;
                const p = root.initialVersion;
                const facts: OccurrenceFact[] = root.validFulfillments.map(
                    (fact) =>
                        'method' in fact
                            ? {
                                  ...fact,
                                  kind: 'DISBURSEMENT',
                                  payerMemberId:
                                      'payerMemberId' in fact
                                          ? fact.payerMemberId
                                          : null,
                                  payerPersonId:
                                      'payerPersonId' in fact
                                          ? fact.payerPersonId
                                          : null,
                                  recordedByPersonId:
                                      fact.recordedByPersonId ??
                                      root.createdByPersonId,
                              }
                            : {
                                  ...fact,
                                  kind: 'EXTERNAL_LIABILITY',
                                  holderMemberId:
                                      'holderMemberId' in fact
                                          ? fact.holderMemberId
                                          : null,
                                  holderPersonId:
                                      'holderPersonId' in fact
                                          ? fact.holderPersonId
                                          : null,
                              },
                );
                const amount =
                    'split' in p
                        ? p.split.total.amountInCents
                        : p.amount.amountInCents;
                state = {
                    ...common,
                    targetId: id,
                    referenceDate: p.expectedPaymentDate ?? p.factDate,
                    occurrenceId: null,
                    installmentId: null,
                    occurrenceVersion: 1,
                    economicVersion: p.version,
                    projected: false,
                    cancelled: root.status === 'CANCELLED',
                    resolved: false,
                    originalAmountInCents: amount,
                    amountInCents: amount,
                    fulfilledAmountInCents: root.supportedAmountInCents,
                    shares: 'split' in p ? p.split.shares : null,
                    distribution: 'split' in p ? p.split.original : null,
                    expectedMemberId:
                        'split' in p ? p.expectedPayerMemberId : null,
                    settlementRuleSnapshot:
                        'split' in p ? p.settlementRuleSnapshot : null,
                    settlementRuleSourceVersion:
                        'split' in p ? p.settlementRuleSourceVersion : 0,
                    facts,
                };
            }
        } else if (meta.modality === 'RECURRING') {
            if (
                target.installmentId ||
                (!target.referenceDate && !target.occurrenceId)
            )
                throw new FinancesError('VALIDATION_ERROR', ['referenceDate']);
            const root = (await this.recurring.find(spaceId, id, lock))!;
            const row = target.occurrenceId
                ? await manager.findOneBy(FinancialOccurrenceOrmEntity, {
                      id: target.occurrenceId,
                      spaceId,
                      commitmentId: id,
                  })
                : null;
            if (
                target.occurrenceId &&
                (!row ||
                    (target.referenceDate &&
                        target.referenceDate !== row.referenceDate))
            )
                throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
            const date = target.referenceDate ?? row!.referenceDate;
            const occurrence = await this.recurring.occurrence(root, date);
            const config = occurrence
                ? root.configurationForVersion(occurrence.economicVersion)
                : root.projectedConfigurationAt(date);
            if (
                !config ||
                (!occurrence &&
                    (
                        await this.recurring.occurrencesInMonth(
                            root,
                            date.slice(0, 7),
                        )
                    ).length)
            )
                throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
            const amount = occurrence
                ? occurrence.amountInCents
                : config.valueMode === 'FIXED'
                  ? config.amountInCents
                  : null;
            const p = config.participation;
            state = {
                ...common,
                description: config.description,
                targetId: occurrence?.id ?? randomUUID(),
                referenceDate: date,
                occurrenceId: occurrence?.id ?? null,
                installmentId: null,
                occurrenceVersion: occurrence?.stateVersion ?? 1,
                economicVersion: config.economicVersion,
                projected: !occurrence,
                cancelled: occurrence?.status === 'CANCELLED',
                resolved: false,
                originalAmountInCents: amount,
                amountInCents: amount,
                fulfilledAmountInCents: occurrence?.fulfilledAmountInCents ?? 0,
                shares:
                    occurrence?.economicShares ??
                    (amount !== null
                        ? (config.effectiveSplit(amount)?.shares ?? null)
                        : null),
                distribution: p.type === 'SHARED' ? p.distribution : null,
                expectedMemberId:
                    p.type === 'SHARED' ? p.expectedMemberId : null,
                settlementRuleSnapshot:
                    p.type === 'SHARED' ? p.settlementRuleSnapshot : null,
                settlementRuleSourceVersion:
                    p.type === 'SHARED' ? p.settlementRuleSourceVersion : 0,
                facts: occurrence?.validFacts ?? [],
            };
            if (state.projected) state.occurrenceId = state.targetId;
        } else {
            if (
                !target.installmentId ||
                target.occurrenceId ||
                target.referenceDate
            )
                throw new FinancesError('VALIDATION_ERROR', ['installmentId']);
            const root = (await this.installments.find(spaceId, id, lock))!;
            const item = root.plan.installments.find(
                (entry) => entry.id === target.installmentId,
            );
            if (!item)
                throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
            const occurrence = (await this.installments.occurrence(
                root,
                item.id,
            ))!;
            const p = root.participation;
            state = {
                ...common,
                targetId: item.id,
                referenceDate: item.dueDate,
                occurrenceId: item.id,
                installmentId: item.id,
                occurrenceVersion: occurrence.stateVersion,
                economicVersion: item.economicVersion,
                projected: false,
                cancelled: item.status === 'CANCELLED',
                resolved:
                    item.resolution !== null || item.anticipation !== null,
                originalAmountInCents: item.originalAmountInCents,
                amountInCents: item.effectiveAmountInCents,
                fulfilledAmountInCents: item.fulfilledAmountInCents,
                shares: root.effectiveSharesFor(item.position),
                distribution: p.type === 'SHARED' ? p.distribution : null,
                expectedMemberId:
                    item.expectedMemberId === undefined
                        ? p.type === 'SHARED'
                            ? p.expectedMemberId
                            : null
                        : item.expectedMemberId,
                settlementRuleSnapshot:
                    p.type === 'SHARED' ? p.settlementRuleSnapshot : null,
                settlementRuleSourceVersion:
                    p.type === 'SHARED' ? p.settlementRuleSourceVersion : 0,
                facts: occurrence.validFacts,
            };
        }
        const corrections = await financialCorrections(
            manager,
            spaceId,
            id,
            state.targetId,
        );
        if (!state.personal && state.modality !== 'RECURRING') {
            const today = new Date(now).toLocaleDateString('en-CA', {
                timeZone: 'America/Sao_Paulo',
            });
            const [firstFact]: { fact_date: string | null }[] =
                await manager.query(
                    `SELECT MIN(fact_date)::text AS fact_date FROM (SELECT fact_date FROM financial_disbursements WHERE space_id=$1 AND commitment_id=$2 AND occurrence_id IS NOT DISTINCT FROM $3::uuid UNION ALL SELECT fact_date FROM financial_external_liabilities WHERE space_id=$1 AND commitment_id=$2 AND occurrence_id IS NOT DISTINCT FROM $3::uuid UNION ALL SELECT fact_date FROM financial_receipts WHERE space_id=$1 AND commitment_id=$2 AND occurrence_id IS NOT DISTINCT FROM $3::uuid) facts`,
                    [spaceId, id, state.occurrenceId],
                );
            const date = firstFact.fact_date;
            const cutoff = date && date < today ? date : today;
            const [row]: {
                distribution: FinancialCorrectionState['distribution'];
            }[] = await manager.query(
                `SELECT COALESCE((SELECT distribution FROM financial_non_recurring_versions WHERE space_id=$1 AND commitment_id=$2 AND target_id=$3 AND effective_from<=$4::date ORDER BY effective_from DESC LIMIT 1),(SELECT split_input FROM financial_commitment_versions WHERE space_id=$1 AND commitment_id=$2 AND version=1),(SELECT split_input FROM financial_income_versions WHERE space_id=$1 AND commitment_id=$2),(SELECT split_input FROM financial_installment_plans WHERE space_id=$1 AND commitment_id=$2)) AS distribution`,
                [spaceId, id, state.targetId, cutoff],
            );
            state.distribution = row.distribution;
        }
        return {
            ...state,
            originalAmountInCents:
                corrections.adjustments[0]?.previousAmountInCents ??
                state.originalAmountInCents,
            ...corrections,
            reversals: await financialFulfillmentReversals(
                manager,
                spaceId,
                id,
                state.targetId,
            ),
            cancelled: state.cancelled || corrections.cancellation !== null,
        };
    }
    private async bump(state: FinancialCorrectionState) {
        const manager = this.managers.get();
        if (!manager.queryRunner?.isTransactionActive)
            throw new Error('Financial corrections require a transaction');
        const changed = await manager.update(
            FinancialCommitmentOrmEntity,
            { id: state.id, spaceId: state.spaceId, version: state.version },
            { version: state.version + 1 },
        );
        if (changed.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
    }
    async adjust(
        state: FinancialCorrectionState,
        adjustment: FinancialAdjustment,
    ) {
        await assertFinancialClosureOriginOpen(
            this.managers.get(),
            state.spaceId,
            state.id,
            state.targetId,
            state.referenceDate,
        );
        await this.bump(state);
        const manager = this.managers.get();
        if (state.modality !== 'ONE_TIME') {
            const values = {
                amountInCents: adjustment.resultingAmountInCents,
                status: (state.fulfilledAmountInCents ===
                adjustment.resultingAmountInCents
                    ? 'FULFILLED'
                    : state.fulfilledAmountInCents === 0
                      ? 'PENDING'
                      : 'PARTIALLY_FULFILLED') as FinancialOccurrenceOrmEntity['status'],
                stateVersion: state.occurrenceVersion + 1,
            };
            if (state.projected)
                await manager.insert(FinancialOccurrenceOrmEntity, {
                    ...values,
                    id: state.targetId,
                    spaceId: state.spaceId,
                    commitmentId: state.id,
                    referenceDate: state.referenceDate!,
                    economicVersion: state.economicVersion,
                    installmentId: null,
                    materializedAt: new Date(adjustment.registeredAt),
                });
            else {
                const changed = await manager.update(
                    FinancialOccurrenceOrmEntity,
                    {
                        id: state.targetId,
                        spaceId: state.spaceId,
                        commitmentId: state.id,
                        stateVersion: state.occurrenceVersion,
                    },
                    values,
                );
                if (changed.affected !== 1)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
            }
        }
        await manager.insert(FinancialCommitmentAdjustmentOrmEntity, {
            ...adjustment,
            registeredAt: new Date(adjustment.registeredAt),
        });
    }
    async cancel(
        state: FinancialCorrectionState,
        cancellation: FinancialCancellation,
    ) {
        await assertFinancialClosureOriginOpen(
            this.managers.get(),
            state.spaceId,
            state.id,
        );
        await this.bump(state);
        await this.managers
            .get()
            .insert(FinancialCommitmentCancellationOrmEntity, {
                ...cancellation,
                registeredAt: new Date(cancellation.registeredAt),
            });
    }
}
