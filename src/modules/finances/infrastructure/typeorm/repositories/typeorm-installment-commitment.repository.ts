import { Inject, Injectable, Optional } from '@nestjs/common';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../../../application/ports/private/shared-expense.repositories.js';
import {
    applicableNonRecurringVersion,
    nonRecurringVersions,
    withNonRecurringReadModels,
} from '../queries/non-recurring-version-selection.js';
import { randomUUID } from 'node:crypto';
import { In } from 'typeorm';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { InstallmentCommitmentRepository } from '../../../application/ports/private/installment-commitment.repository.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import {
    InstallmentCommitment,
    type InstallmentPayoffImpact,
    type InstallmentResolutionItem,
} from '../../../domain/installment/installment-commitment.js';
import {
    Installment,
    InstallmentPlan,
    type InstallmentAnticipation,
} from '../../../domain/installment/installment-plan.js';
import {
    FinancialOccurrence,
    type OccurrenceFact,
} from '../../../domain/recurrence/financial-occurrence.js';
import {
    FinancialCommitmentOrmEntity,
    FinancialDisbursementOrmEntity,
    FinancialExternalLiabilityOrmEntity,
} from '../entities/shared-expense.orm-entity.js';
import { FinancialOccurrenceOrmEntity } from '../entities/recurrence.orm-entity.js';
import {
    FinancialInstallmentAnticipationOrmEntity,
    FinancialInstallmentPayoffOrmEntity,
    FinancialInstallmentResolutionOrmEntity,
    FinancialInstallmentCommandReceiptOrmEntity,
    FinancialInstallmentOrmEntity,
    FinancialInstallmentPlanOrmEntity,
    FinancialInstallmentShareOrmEntity,
} from '../entities/installment.orm-entity.js';
import { recordFinancialCommandAudit } from './record-financial-command-audit.js';
import { financialFulfillmentReversals } from '../queries/financial-fulfillment-reversal-projection.js';
import {
    applyFinancialAdjustments,
    financialCorrections,
} from '../queries/financial-correction-projection.js';
import { FinancialCommitmentAdjustmentOrmEntity } from '../entities/financial-correction.orm-entity.js';

@Injectable()
export class TypeOrmInstallmentCommitmentRepository implements InstallmentCommitmentRepository {
    constructor(
        private readonly provider: EntityManagerProvider,
        @Optional()
        @Inject(FINANCES_CLOCK)
        private readonly clock?: FinancesClock,
    ) {}

    private manager() {
        return this.provider.get();
    }

    async save(root: InstallmentCommitment): Promise<void> {
        const m = this.manager();
        const p = root.participation;
        await m.insert(FinancialCommitmentOrmEntity, {
            id: root.id,
            spaceId: root.spaceId,
            kind: 'EXPENSE',
            modality: 'INSTALLMENT',
            description: root.description,
            createdBy: root.createdByPersonId,
            personalOwnerPersonId:
                p.type === 'PERSONAL' ? p.ownerPersonId : null,
            version: root.version,
            registeredAt: new Date(root.registeredAt),
        });
        await m.insert(FinancialInstallmentPlanOrmEntity, {
            id: root.plan.id,
            spaceId: root.spaceId,
            commitmentId: root.id,
            installmentCount: root.plan.count,
            totalAmountInCents: root.plan.totalAmountInCents,
            cadence: root.cadence,
            plannedPaymentMethod: root.plannedPaymentMethod,
            splitInput: p.type === 'SHARED' ? p.distribution : null,
            expectedMemberId: p.type === 'SHARED' ? p.expectedMemberId : null,
            ruleSnapshot: p.type === 'SHARED' ? p.settlementRuleSnapshot : null,
            ruleSourceVersion:
                p.type === 'SHARED' ? p.settlementRuleSourceVersion : 0,
            registeredAt: new Date(root.registeredAt),
        });
        for (const installment of root.plan.installments) {
            await m.insert(FinancialInstallmentOrmEntity, {
                id: installment.id,
                spaceId: root.spaceId,
                commitmentId: root.id,
                planId: root.plan.id,
                position: installment.position,
                dueDate: installment.dueDate,
                amountInCents: installment.amountInCents,
            });
            await m.insert(FinancialOccurrenceOrmEntity, {
                id: installment.id,
                spaceId: root.spaceId,
                commitmentId: root.id,
                referenceDate: installment.dueDate,
                economicVersion: null,
                installmentId: installment.id,
                stateVersion: 1,
                amountInCents: installment.amountInCents,
                status: 'PENDING',
                materializedAt: new Date(root.registeredAt),
            });
            for (const share of root.sharesFor(installment.position) ?? [])
                await m.insert(FinancialInstallmentShareOrmEntity, {
                    installmentId: installment.id,
                    memberId: share.memberId,
                    spaceId: root.spaceId,
                    commitmentId: root.id,
                    amountInCents: share.amountInCents,
                });
        }
    }

    async find(
        spaceId: string,
        commitmentId: string,
        lock = false,
    ): Promise<InstallmentCommitment | null> {
        return lock
            ? this.findInSnapshot(spaceId, commitmentId, true)
            : this.provider.readSnapshot(() =>
                  this.findInSnapshot(spaceId, commitmentId, false),
              );
    }

    private async findInSnapshot(
        spaceId: string,
        commitmentId: string,
        lock: boolean,
    ): Promise<InstallmentCommitment | null> {
        const m = this.manager();
        const q = m
            .createQueryBuilder(FinancialCommitmentOrmEntity, 'c')
            .where(
                'c.space_id=:spaceId AND c.id=:commitmentId AND c.modality=:modality',
                { spaceId, commitmentId, modality: 'INSTALLMENT' },
            );
        if (lock) q.setLock('pessimistic_write');
        const c = await q.getOne();
        if (!c) return null;
        const plan = await m.findOneBy(FinancialInstallmentPlanOrmEntity, {
            spaceId,
            commitmentId,
        });
        if (!plan) throw new Error('Installment plan missing');
        const rows = await m.find(FinancialInstallmentOrmEntity, {
            where: { spaceId, commitmentId },
            order: { position: 'ASC' },
        });
        const states = await m.find(FinancialOccurrenceOrmEntity, {
            where: {
                spaceId,
                commitmentId,
                installmentId: In(rows.map((row) => row.id)),
            },
        });
        const anticipations = await m.find(
            FinancialInstallmentAnticipationOrmEntity,
            { where: { spaceId, commitmentId } },
        );
        const payoffs = await m.find(FinancialInstallmentPayoffOrmEntity, {
            where: { spaceId, commitmentId },
        });
        const resolutions = await m.find(
            FinancialInstallmentResolutionOrmEntity,
            { where: { spaceId, commitmentId } },
        );
        const fulfilled: { installment_id: string; amount: string }[] =
            await m.query(
                `SELECT installment_id,SUM(amount_in_cents)::text AS amount FROM (
                SELECT d.occurrence_id AS installment_id,d.amount_in_cents-COALESCE((SELECT SUM(r.amount_in_cents) FROM financial_fulfillment_reversals r WHERE r.space_id=d.space_id AND r.original_id=d.id AND r.original_kind='DISBURSEMENT'),0) AS amount_in_cents FROM financial_disbursements d WHERE d.space_id=$1 AND d.commitment_id=$2
                UNION ALL SELECT l.occurrence_id,l.amount_in_cents-COALESCE((SELECT SUM(r.amount_in_cents) FROM financial_fulfillment_reversals r WHERE r.space_id=l.space_id AND r.original_id=l.id AND r.original_kind='EXTERNAL_LIABILITY'),0) FROM financial_external_liabilities l WHERE l.space_id=$1 AND l.commitment_id=$2
            ) facts WHERE installment_id IS NOT NULL GROUP BY installment_id`,
                [spaceId, commitmentId],
            );
        const economicVersions = await nonRecurringVersions(
            m,
            spaceId,
            commitmentId,
        );
        const correctionRows = await m.find(
            FinancialCommitmentAdjustmentOrmEntity,
            {
                where: { spaceId, commitmentId },
                order: { commitmentVersion: 'ASC' },
            },
        );
        const originalShares = await m.find(
            FinancialInstallmentShareOrmEntity,
            { where: { spaceId, commitmentId } },
        );
        const factDates: { target_id: string; fact_date: string }[] =
            await m.query(
                `SELECT occurrence_id AS target_id,MIN(fact_date)::text AS fact_date FROM (SELECT occurrence_id,fact_date FROM financial_disbursements WHERE space_id=$1 AND commitment_id=$2 UNION ALL SELECT occurrence_id,fact_date FROM financial_external_liabilities WHERE space_id=$1 AND commitment_id=$2) dates WHERE occurrence_id IS NOT NULL GROUP BY occurrence_id`,
                [spaceId, commitmentId],
            );
        const today =
            this.clock?.today() ??
            new Date().toLocaleDateString('en-CA', {
                timeZone: 'America/Sao_Paulo',
            });
        const currentDescription =
            economicVersions
                .filter((version) => version.effectiveFrom <= today)
                .at(-1)?.description ?? c.description;
        const reversals = await financialFulfillmentReversals(
            m,
            spaceId,
            commitmentId,
        );
        const activePayoff = payoffs.find((payoff) => !payoff.compensated);
        const installments = rows.map((row) => {
            const state = states.find((item) => item.installmentId === row.id);
            if (!state) throw new Error('Installment state missing');
            const applicable = applicableNonRecurringVersion(
                economicVersions,
                row.id,
                today,
                factDates.find((item) => item.target_id === row.id)?.fact_date,
            );
            const adjustments = correctionRows
                .filter((correction) => correction.targetId === row.id)
                .map((correction) => ({
                    ...correction,
                    registeredAt: correction.registeredAt.toISOString(),
                }));
            const corrected = applyFinancialAdjustments(
                applicable?.amountInCents ?? row.amountInCents,
                applicable?.economicShares ??
                    (c.personalOwnerPersonId
                        ? null
                        : originalShares
                              .filter((share) => share.installmentId === row.id)
                              .map((share) => ({
                                  memberId: share.memberId,
                                  amountInCents: share.amountInCents,
                              }))),
                adjustments,
                applicable?.version ?? 1,
            );
            return new Installment(
                row.id,
                row.position,
                row.dueDate,
                corrected.amountInCents,
                (resolutions.find(
                    (item) =>
                        item.installmentId === row.id && !item.compensated,
                )?.type === 'PAYOFF'
                    ? 'PAID_OFF'
                    : resolutions.find(
                            (item) =>
                                item.installmentId === row.id &&
                                !item.compensated,
                        )?.type === 'CANCELLED'
                      ? 'CANCELLED'
                      : state.status) as Installment['status'],
                Number(
                    fulfilled.find((item) => item.installment_id === row.id)
                        ?.amount ?? '0',
                ),
                state.stateVersion,
                (() => {
                    const anticipation = anticipations.find(
                        (item) => item.installmentId === row.id,
                    );
                    return anticipation
                        ? {
                              id: anticipation.id,
                              factId: anticipation.factId,
                              factDate: anticipation.factDate,
                              registeredAt:
                                  anticipation.registeredAt.toISOString(),
                              actorId: anticipation.actorId,
                              expectedRemainingAmountInCents:
                                  anticipation.expectedRemainingAmountInCents,
                              paidAmountInCents: anticipation.paidAmountInCents,
                              adjustmentInCents: anticipation.adjustmentInCents,
                              economicShares: anticipation.economicShares,
                          }
                        : null;
                })(),
                (() => {
                    const resolution = resolutions.find(
                        (item) =>
                            item.installmentId === row.id && !item.compensated,
                    );
                    return resolution
                        ? {
                              id: resolution.id,
                              type: resolution.type,
                              payoffId: resolution.payoffId,
                              expectedRemainingAmountInCents:
                                  resolution.expectedRemainingAmountInCents,
                              factDate: resolution.factDate,
                              actorId: resolution.actorId,
                              registeredAt:
                                  resolution.registeredAt.toISOString(),
                              reason: resolution.reason,
                          }
                        : null;
                })(),
                row.amountInCents,
                corrected.economicShares,
                applicable?.version ?? 1,
                applicable ? applicable.expectedMemberId : undefined,
                adjustments,
                reversals.filter((reversal) => reversal.targetId === row.id),
                resolutions
                    .filter((resolution) => resolution.installmentId === row.id)
                    .map((resolution) => ({
                        id: resolution.id,
                        type: resolution.type,
                        payoffId: resolution.payoffId,
                        expectedRemainingAmountInCents:
                            resolution.expectedRemainingAmountInCents,
                        factDate: resolution.factDate,
                        actorId: resolution.actorId,
                        registeredAt: resolution.registeredAt.toISOString(),
                        reason: resolution.reason,
                        compensated: resolution.compensated,
                    })),
            );
        });
        return new InstallmentCommitment(
            c.id,
            c.spaceId,
            currentDescription,
            c.createdBy,
            c.registeredAt.toISOString(),
            c.version,
            new InstallmentPlan(
                plan.id,
                c.id,
                c.spaceId,
                installments,
                activePayoff
                    ? {
                          id: activePayoff.id,
                          factId: activePayoff.factId,
                          factDate: activePayoff.factDate,
                          actorId: activePayoff.actorId,
                          registeredAt: activePayoff.registeredAt.toISOString(),
                          expectedRemainingAmountInCents:
                              activePayoff.expectedRemainingAmountInCents,
                          paidAmountInCents: activePayoff.paidAmountInCents,
                          adjustmentInCents: activePayoff.adjustmentInCents,
                          economicShares: activePayoff.economicShares,
                          recognizedRemainingShares:
                              activePayoff.recognizedRemainingShares,
                          recognizedManualAdjustments:
                              activePayoff.recognizedManualAdjustments,
                      }
                    : null,
                payoffs.map((payoff) => ({
                    id: payoff.id,
                    factId: payoff.factId,
                    factDate: payoff.factDate,
                    actorId: payoff.actorId,
                    registeredAt: payoff.registeredAt.toISOString(),
                    expectedRemainingAmountInCents:
                        payoff.expectedRemainingAmountInCents,
                    paidAmountInCents: payoff.paidAmountInCents,
                    adjustmentInCents: payoff.adjustmentInCents,
                    economicShares: payoff.economicShares,
                    recognizedRemainingShares: payoff.recognizedRemainingShares,
                    compensated: payoff.compensated,
                    expectedEconomicShares:
                        payoff.expectedEconomicShares ??
                        payoff.economicShares?.map((share) => ({
                            memberId: share.memberId,
                            amountInCents: resolutions
                                .filter(
                                    (resolution) =>
                                        resolution.payoffId === payoff.id,
                                )
                                .reduce(
                                    (sum, resolution) =>
                                        sum +
                                        (resolution.economicShares?.find(
                                            (item) =>
                                                item.memberId ===
                                                share.memberId,
                                        )?.amountInCents ?? 0),
                                    0,
                                ),
                        })) ??
                        null,
                    recognizedManualAdjustments:
                        payoff.recognizedManualAdjustments,
                })),
            ),
            c.personalOwnerPersonId
                ? { type: 'PERSONAL', ownerPersonId: c.personalOwnerPersonId }
                : {
                      type: 'SHARED',
                      distribution: plan.splitInput!,
                      expectedMemberId: plan.expectedMemberId,
                      settlementRuleSnapshot: plan.ruleSnapshot,
                      settlementRuleSourceVersion: plan.ruleSourceVersion,
                  },
            plan.cadence,
            plan.plannedPaymentMethod,
        );
    }

    async list(spaceId: string, after: string | null) {
        return this.provider.readSnapshot(async () => {
            const m = this.manager();
            const [counts]: { total_count: string; amount: string }[] =
                await m.query(
                    withNonRecurringReadModels(
                        `SELECT COUNT(DISTINCT i.commitment_id)::text AS total_count,COALESCE(SUM(i.amount_in_cents),0)::text AS amount FROM financial_installments i WHERE i.space_id=$1`,
                        '$2::date',
                    ),
                    [
                        spaceId,
                        this.clock?.today() ??
                            new Date().toLocaleDateString('en-CA', {
                                timeZone: 'America/Sao_Paulo',
                            }),
                    ],
                );
            const rows: { commitment_id: string }[] = await m.query(
                `SELECT commitment_id FROM financial_installment_plans WHERE space_id=$1 AND ($2::uuid IS NULL OR commitment_id>$2::uuid) ORDER BY commitment_id LIMIT 21`,
                [spaceId, after],
            );
            const items: InstallmentCommitment[] = [];
            for (const row of rows)
                items.push(
                    (await this.findInSnapshot(
                        spaceId,
                        row.commitment_id,
                        false,
                    ))!,
                );
            return {
                items,
                totalCount: Number(counts.total_count),
                totalAmountInCents: counts.amount,
            };
        });
    }

    async occurrence(
        root: InstallmentCommitment,
        installmentId: string,
    ): Promise<FinancialOccurrence | null> {
        return this.provider.readSnapshot(() =>
            this.occurrenceInSnapshot(root, installmentId),
        );
    }

    private async occurrenceInSnapshot(
        root: InstallmentCommitment,
        installmentId: string,
    ): Promise<FinancialOccurrence | null> {
        const m = this.manager();
        const row = await m.findOneBy(FinancialOccurrenceOrmEntity, {
            id: installmentId,
            spaceId: root.spaceId,
            commitmentId: root.id,
            installmentId,
        });
        if (!row) return null;
        const [disbursements, liabilities, settlements] = await Promise.all([
            m.find(FinancialDisbursementOrmEntity, {
                where: {
                    spaceId: root.spaceId,
                    commitmentId: root.id,
                    occurrenceId: row.id,
                },
                order: { sequence: 'ASC' },
            }),
            m.find(FinancialExternalLiabilityOrmEntity, {
                where: {
                    spaceId: root.spaceId,
                    commitmentId: root.id,
                    occurrenceId: row.id,
                },
                order: { sequence: 'ASC' },
            }),
            m.query(
                `SELECT s.*,s.fact_date::text AS fact_date FROM financial_external_liability_settlements s JOIN financial_external_liabilities l ON l.space_id=s.space_id AND l.commitment_id=s.commitment_id AND l.id=s.external_liability_id WHERE l.space_id=$1 AND l.occurrence_id=$2 ORDER BY s.sequence`,
                [root.spaceId, row.id],
            ) as Promise<
                {
                    id: string;
                    external_liability_id: string;
                    amount_in_cents: string;
                    fact_date: string;
                    registered_at: Date;
                    recorded_by_person_id: string;
                }[]
            >,
        ]);
        const facts: OccurrenceFact[] = [
            ...disbursements.map((f) => ({
                sequence: f.sequence,
                fact: {
                    kind: 'DISBURSEMENT' as const,
                    id: f.id,
                    amountInCents: f.amountInCents,
                    factDate: f.factDate,
                    registeredAt: f.registeredAt.toISOString(),
                    recordedByPersonId: f.recordedByPersonId,
                    payerMemberId: f.payerMemberId,
                    payerPersonId: f.payerPersonId,
                    method: f.method as 'PIX' | 'DEBIT' | 'CASH',
                },
            })),
            ...liabilities.map((f) => ({
                sequence: f.sequence,
                fact: {
                    kind: 'EXTERNAL_LIABILITY' as const,
                    id: f.id,
                    amountInCents: f.amountInCents,
                    factDate: f.factDate,
                    registeredAt: f.registeredAt.toISOString(),
                    recordedByPersonId: f.recordedByPersonId,
                    holderMemberId: f.holderMemberId,
                    holderPersonId: f.holderPersonId,
                    remainingAmountInCents: f.remainingAmountInCents,
                },
            })),
        ]
            .sort((a, b) => a.sequence - b.sequence)
            .map((item) => item.fact);
        return new FinancialOccurrence(
            row.id,
            row.commitmentId,
            row.spaceId,
            row.referenceDate,
            1,
            row.stateVersion,
            root.plan.installments.find((item) => item.id === row.id)!
                .effectiveAmountInCents,
            facts,
            row.materializedAt.toISOString(),
            row.status,
            settlements.map((s) => ({
                id: s.id,
                externalLiabilityId: s.external_liability_id,
                amountInCents: Number(s.amount_in_cents),
                factDate: s.fact_date,
                registeredAt: s.registered_at.toISOString(),
                recordedByPersonId: s.recorded_by_person_id,
            })),
            [],
            null,
            (await financialCorrections(m, root.spaceId, root.id, row.id))
                .adjustments,
            root.effectiveSharesFor(
                root.plan.installments.find((item) => item.id === row.id)!
                    .position,
            ),
            await financialFulfillmentReversals(
                m,
                root.spaceId,
                root.id,
                row.id,
            ),
        );
    }

    private async nextSequence(root: InstallmentCommitment): Promise<number> {
        const [row]: { n: number }[] = await this.manager().query(
            `SELECT (SELECT COUNT(*) FROM financial_disbursements WHERE space_id=$1 AND commitment_id=$2)+(SELECT COUNT(*) FROM financial_external_liabilities WHERE space_id=$1 AND commitment_id=$2)+(SELECT COUNT(*) FROM financial_external_liability_settlements WHERE space_id=$1 AND commitment_id=$2)+1 AS n`,
            [root.spaceId, root.id],
        );
        return Number(row.n);
    }

    private async bump(
        root: InstallmentCommitment,
        occurrence: FinancialOccurrence,
        status: FinancialOccurrence['status'],
        settling = false,
        amountInCents?: number,
    ) {
        const m = this.manager();
        const changed = await m.update(
            FinancialCommitmentOrmEntity,
            { id: root.id, spaceId: root.spaceId, version: root.version },
            { version: root.version + 1 },
        );
        if (changed.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        const state = await m.update(
            FinancialOccurrenceOrmEntity,
            {
                id: occurrence.id,
                spaceId: root.spaceId,
                stateVersion: settling
                    ? occurrence.stateVersion
                    : occurrence.stateVersion - 1,
            },
            {
                stateVersion: settling
                    ? occurrence.stateVersion + 1
                    : occurrence.stateVersion,
                status,
                ...(amountInCents === undefined ? {} : { amountInCents }),
            },
        );
        if (state.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
    }

    async record(
        root: InstallmentCommitment,
        occurrence: FinancialOccurrence,
        fact: OccurrenceFact,
        anticipation?: InstallmentAnticipation,
    ): Promise<void> {
        const m = this.manager();
        root.assertGlobalFulfillment(
            fact.amountInCents,
            anticipation?.adjustmentInCents ?? 0,
        );
        await this.bump(
            root,
            occurrence,
            occurrence.status,
            false,
            anticipation ? occurrence.amountInCents! : undefined,
        );
        const sequence = await this.nextSequence(root);
        if (fact.kind === 'DISBURSEMENT')
            await m.insert(FinancialDisbursementOrmEntity, {
                id: fact.id,
                spaceId: root.spaceId,
                commitmentId: root.id,
                occurrenceId: occurrence.id,
                sequence,
                version: 1,
                recordedByPersonId: fact.recordedByPersonId,
                payerMemberId: fact.payerMemberId,
                payerPersonId: fact.payerPersonId,
                amountInCents: fact.amountInCents,
                method: fact.method,
                factDate: fact.factDate,
                registeredAt: new Date(fact.registeredAt),
            });
        if (fact.kind === 'EXTERNAL_LIABILITY')
            await m.insert(FinancialExternalLiabilityOrmEntity, {
                id: fact.id,
                spaceId: root.spaceId,
                commitmentId: root.id,
                occurrenceId: occurrence.id,
                sequence,
                version: 1,
                recordedByPersonId: fact.recordedByPersonId,
                holderMemberId: fact.holderMemberId,
                holderPersonId: fact.holderPersonId,
                amountInCents: fact.amountInCents,
                remainingAmountInCents: fact.remainingAmountInCents,
                factDate: fact.factDate,
                registeredAt: new Date(fact.registeredAt),
            });
        if (anticipation)
            await m.insert(FinancialInstallmentAnticipationOrmEntity, {
                id: anticipation.id,
                spaceId: root.spaceId,
                commitmentId: root.id,
                installmentId: occurrence.id,
                factId: anticipation.factId,
                dueDate: occurrence.referenceDate,
                expectedRemainingAmountInCents:
                    anticipation.expectedRemainingAmountInCents,
                paidAmountInCents: anticipation.paidAmountInCents,
                effectiveAmountInCents: occurrence.amountInCents!,
                adjustmentInCents: anticipation.adjustmentInCents,
                economicShares: anticipation.economicShares,
                factDate: anticipation.factDate,
                registeredAt: new Date(anticipation.registeredAt),
                actorId: anticipation.actorId,
            });
    }

    private async resolveState(
        root: InstallmentCommitment,
        items: readonly InstallmentResolutionItem[],
    ) {
        const m = this.manager();
        const changed = await m.update(
            FinancialCommitmentOrmEntity,
            { id: root.id, spaceId: root.spaceId, version: root.version },
            { version: root.version + 1 },
        );
        if (changed.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        for (const item of items) {
            const state = await m.update(
                FinancialOccurrenceOrmEntity,
                {
                    id: item.installmentId,
                    spaceId: root.spaceId,
                    commitmentId: root.id,
                    stateVersion: item.expectedInstallmentVersion,
                },
                { stateVersion: item.expectedInstallmentVersion + 1 },
            );
            if (state.affected !== 1)
                throw new FinancesError('CONCURRENT_MODIFICATION');
        }
    }

    async payoff(
        root: InstallmentCommitment,
        impact: InstallmentPayoffImpact,
        fact: Extract<OccurrenceFact, { kind: 'DISBURSEMENT' }>,
        payoffId: string,
    ) {
        const m = this.manager();
        await this.resolveState(root, impact.items);
        const sequence = await this.nextSequence(root);
        await m.insert(FinancialDisbursementOrmEntity, {
            id: fact.id,
            spaceId: root.spaceId,
            commitmentId: root.id,
            occurrenceId: null,
            sequence,
            version: 1,
            recordedByPersonId: fact.recordedByPersonId,
            payerMemberId: fact.payerMemberId,
            payerPersonId: fact.payerPersonId,
            amountInCents: fact.amountInCents,
            method: fact.method,
            factDate: fact.factDate,
            registeredAt: new Date(fact.registeredAt),
        });
        await m.insert(FinancialInstallmentPayoffOrmEntity, {
            id: payoffId,
            spaceId: root.spaceId,
            commitmentId: root.id,
            factId: fact.id,
            expectedRemainingAmountInCents:
                impact.expectedRemainingAmountInCents,
            paidAmountInCents: impact.paidAmountInCents,
            adjustmentInCents: impact.adjustmentInCents,
            economicShares: impact.effectiveEconomicShares,
            expectedEconomicShares: impact.expectedRemainingShares,
            recognizedManualAdjustments: impact.recognizedManualAdjustments,
            recognizedRemainingShares: impact.recognizedRemainingShares,
            factDate: fact.factDate,
            actorId: fact.recordedByPersonId,
            registeredAt: new Date(fact.registeredAt),
        });
        for (const item of impact.items)
            await m.insert(FinancialInstallmentResolutionOrmEntity, {
                id: randomUUID(),
                spaceId: root.spaceId,
                commitmentId: root.id,
                installmentId: item.installmentId,
                type: 'PAYOFF',
                payoffId,
                expectedRemainingAmountInCents:
                    item.expectedRemainingAmountInCents,
                factDate: fact.factDate,
                actorId: fact.recordedByPersonId,
                registeredAt: new Date(fact.registeredAt),
                reason: null,
                economicShares: item.remainingEconomicShares,
            });
    }

    async cancelFuture(
        root: InstallmentCommitment,
        items: readonly InstallmentResolutionItem[],
        reason: string,
        actorId: string,
        factDate: string,
        now: string,
    ) {
        const m = this.manager();
        await this.resolveState(root, items);
        for (const item of items)
            await m.insert(FinancialInstallmentResolutionOrmEntity, {
                id: randomUUID(),
                spaceId: root.spaceId,
                commitmentId: root.id,
                installmentId: item.installmentId,
                type: 'CANCELLED',
                payoffId: null,
                expectedRemainingAmountInCents:
                    item.expectedRemainingAmountInCents,
                factDate,
                actorId,
                registeredAt: new Date(now),
                reason,
                economicShares: item.remainingEconomicShares,
            });
    }

    async settleExternal(
        root: InstallmentCommitment,
        occurrence: FinancialOccurrence,
        liabilityId: string,
        amountInCents: number,
        factDate: string,
        actorId: string,
        now: string,
    ) {
        const m = this.manager();
        const liability = await m.findOneBy(
            FinancialExternalLiabilityOrmEntity,
            {
                id: liabilityId,
                spaceId: root.spaceId,
                commitmentId: root.id,
                occurrenceId: occurrence.id,
            },
        );
        if (!liability) throw new FinancesError('EXTERNAL_LIABILITY_NOT_FOUND');
        if (amountInCents > liability.remainingAmountInCents)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        await this.bump(root, occurrence, occurrence.status, true);
        const remaining = liability.remainingAmountInCents - amountInCents;
        const changed = await m.update(
            FinancialExternalLiabilityOrmEntity,
            {
                id: liability.id,
                remainingAmountInCents: liability.remainingAmountInCents,
            },
            { remainingAmountInCents: remaining },
        );
        if (changed.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        const id = randomUUID();
        const sequence = await this.nextSequence(root);
        await m.query(
            `INSERT INTO financial_external_liability_settlements
            (id,space_id,commitment_id,external_liability_id,sequence,holder_member_id,holder_person_id,recorded_by_person_id,receipt_operation,idempotency_key,amount_in_cents,fact_date,registered_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,$9,$10,$11)`,
            [
                id,
                root.spaceId,
                root.id,
                liability.id,
                sequence,
                liability.holderMemberId,
                liability.holderPersonId,
                actorId,
                amountInCents,
                factDate,
                now,
            ],
        );
        return { id, remainingAmountInCents: remaining };
    }

    async findReceipt(
        actorId: string,
        operation: string,
        key: string,
        hash: Buffer,
    ): Promise<unknown | null> {
        const row = await this.manager().findOneBy(
            FinancialInstallmentCommandReceiptOrmEntity,
            { actorId, operation, idempotencyKey: key },
        );
        if (!row) return null;
        if (!row.requestHash.equals(hash))
            throw new FinancesError('IDEMPOTENCY_KEY_REUSED');
        return row.result;
    }

    async saveReceipt(
        actorId: string,
        spaceId: string,
        commitmentId: string,
        installmentId: string | null,
        operation: string,
        key: string,
        hash: Buffer,
        result: unknown,
        now: string,
    ): Promise<void> {
        await this.manager().insert(
            FinancialInstallmentCommandReceiptOrmEntity,
            {
                actorId,
                operation,
                idempotencyKey: key,
                requestHash: hash,
                status: 'COMPLETED',
                spaceId,
                commitmentId,
                installmentId,
                result: result as Record<string, unknown>,
                createdAt: new Date(now),
            },
        );
        await recordFinancialCommandAudit(
            this.manager(),
            {
                actorId: { value: actorId },
                spaceId: { value: spaceId },
                idempotencyKey: key,
            },
            operation,
            commitmentId,
            now,
        );
    }
}
