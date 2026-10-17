import { Inject, Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import {
    FINANCIAL_CORRECTION_REPOSITORY,
    type FinancialCorrectionRepository,
} from '../../../application/ports/private/financial-correction.repository.js';
import type {
    FinancialFulfillmentReversalRepository,
    FinancialReversalReadInput,
    FinancialReversalTarget,
} from '../../../application/ports/private/financial-fulfillment-reversal.repository.js';
import type { FinancialCorrectionState } from '../../../domain/corrections/financial-correction.js';
import {
    validateFinancialReversal,
    validFinancialAmount,
    type FinancialFulfillmentReversal,
    type FinancialFulfillmentReversalState,
    type ReversibleFinancialFact,
} from '../../../domain/reversals/financial-fulfillment-reversal.js';
import type { EconomicShare } from '../../../domain/shared-expense/responsibility-split.js';
import type { OccurrenceFact } from '../../../domain/recurrence/financial-occurrence.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import {
    FinancialCommitmentOrmEntity,
    FinancialExternalLiabilityOrmEntity,
} from '../entities/shared-expense.orm-entity.js';
import { FinancialOccurrenceOrmEntity } from '../entities/recurrence.orm-entity.js';
import { FinancialFulfillmentReversalOrmEntity } from '../entities/financial-fulfillment-reversal.orm-entity.js';
import {
    FinancialInstallmentPayoffOrmEntity,
    FinancialInstallmentResolutionOrmEntity,
    FinancialInstallmentPlanOrmEntity,
} from '../entities/installment.orm-entity.js';
import { FinancialExternalLiabilitySettlementOrmEntity } from '../entities/external-liability-settlement.orm-entity.js';
import { financialFulfillmentReversals } from '../queries/financial-fulfillment-reversal-projection.js';

@Injectable()
export class TypeOrmFinancialFulfillmentReversalRepository implements FinancialFulfillmentReversalRepository {
    constructor(
        private readonly managers: EntityManagerProvider,
        @Inject(FINANCIAL_CORRECTION_REPOSITORY)
        private readonly corrections: FinancialCorrectionRepository,
    ) {}
    snapshot<T>(work: () => Promise<T>) {
        return this.managers.readSnapshot(work);
    }
    async read(
        spaceId: string,
        commitmentId: string,
        input: FinancialReversalReadInput,
        now: string,
        lock = false,
    ): Promise<FinancialFulfillmentReversalState | null> {
        const manager = this.managers.get();
        const rootQuery = manager
            .createQueryBuilder(FinancialCommitmentOrmEntity, 'c')
            .where('c.space_id=:spaceId AND c.id=:commitmentId', {
                spaceId,
                commitmentId,
            });
        if (lock) rootQuery.setLock('pessimistic_write');
        const root = await rootQuery.getOne();
        if (!root) return null;
        const names = {
            DISBURSEMENT: {
                table: 'financial_disbursements',
                member: 'payer_member_id',
                person: 'payer_person_id',
            },
            EXTERNAL_LIABILITY: {
                table: 'financial_external_liabilities',
                member: 'holder_member_id',
                person: 'holder_person_id',
            },
            EXTERNAL_SETTLEMENT: {
                table: 'financial_external_liability_settlements',
                member: 'holder_member_id',
                person: 'holder_person_id',
            },
            RECEIPT: {
                table: 'financial_receipts',
                member: 'recipient_member_id',
                person: 'recipient_person_id',
            },
        };
        const source = names[input.originalKind];
        if (!source)
            throw new FinancesError('VALIDATION_ERROR', ['originalKind']);
        type FactRow = {
            id: string;
            amount: string;
            fact_date: string;
            registered_at: Date;
            recorded_by_person_id: string;
            member_id: string | null;
            person_id: string | null;
            occurrence_id: string | null;
            external_liability_id: string | null;
        };
        const [row]: FactRow[] = await manager.query(
            `SELECT f.id,f.amount_in_cents::text AS amount,f.fact_date::text,f.registered_at,f.recorded_by_person_id,f.${source.member} AS member_id,f.${source.person} AS person_id,${input.originalKind === 'EXTERNAL_SETTLEMENT' ? 'l.occurrence_id' : 'f.occurrence_id'} AS occurrence_id,${input.originalKind === 'EXTERNAL_SETTLEMENT' ? 'f.external_liability_id' : input.originalKind === 'EXTERNAL_LIABILITY' ? 'f.id' : 'NULL::uuid'} AS external_liability_id FROM ${source.table} f ${input.originalKind === 'EXTERNAL_SETTLEMENT' ? 'JOIN financial_external_liabilities l ON l.space_id=f.space_id AND l.commitment_id=f.commitment_id AND l.id=f.external_liability_id' : ''} WHERE f.space_id=$1 AND f.commitment_id=$2 AND f.id=$3 ${lock ? 'FOR UPDATE OF f' : ''}`,
            [spaceId, commitmentId, input.originalId],
        );
        if (!row) return null;
        const original: ReversibleFinancialFact = {
            id: row.id,
            kind: input.originalKind,
            amountInCents: Number(row.amount),
            factDate: row.fact_date,
            registeredAt: row.registered_at.toISOString(),
            recordedByPersonId: row.recorded_by_person_id,
            memberId: row.member_id,
            personId: row.person_id,
            externalLiabilityId: row.external_liability_id,
            occurrenceId: row.occurrence_id,
            installmentId:
                root.modality === 'INSTALLMENT' ? row.occurrence_id : null,
        };
        let target: FinancialReversalTarget = {};
        let globalPayoff: FinancialFulfillmentReversalState['globalPayoff'] =
            null;
        if (root.modality === 'ONE_TIME') {
            if (
                input.installmentId ||
                input.occurrenceId ||
                input.referenceDate ||
                row.occurrence_id
            )
                throw new FinancesError('FINANCIAL_REVERSAL_NOT_FOUND');
        } else if (root.modality === 'RECURRING') {
            const occurrence = row.occurrence_id
                ? await manager.findOneBy(FinancialOccurrenceOrmEntity, {
                      id: row.occurrence_id,
                      spaceId,
                      commitmentId,
                  })
                : null;
            if (
                !occurrence ||
                input.installmentId ||
                (input.occurrenceId && input.occurrenceId !== occurrence.id) ||
                (input.referenceDate &&
                    input.referenceDate !== occurrence.referenceDate)
            )
                throw new FinancesError('FINANCIAL_REVERSAL_NOT_FOUND');
            target = {
                occurrenceId: occurrence.id,
                referenceDate: occurrence.referenceDate,
            };
        } else if (row.occurrence_id) {
            if (
                input.occurrenceId ||
                input.referenceDate ||
                (input.installmentId &&
                    input.installmentId !== row.occurrence_id)
            )
                throw new FinancesError('FINANCIAL_REVERSAL_NOT_FOUND');
            target = { installmentId: row.occurrence_id };
        } else {
            if (
                input.originalKind !== 'DISBURSEMENT' ||
                input.installmentId ||
                input.occurrenceId ||
                input.referenceDate
            )
                throw new FinancesError('FINANCIAL_REVERSAL_NOT_FOUND');
            const payoff = await manager.findOneBy(
                FinancialInstallmentPayoffOrmEntity,
                { spaceId, commitmentId, factId: row.id },
            );
            if (!payoff)
                throw new FinancesError('FINANCIAL_REVERSAL_NOT_FOUND');
            const resolutions = await manager.find(
                FinancialInstallmentResolutionOrmEntity,
                { where: { spaceId, commitmentId, payoffId: payoff.id } },
            );
            globalPayoff = {
                id: payoff.id,
                factId: payoff.factId,
                paidAmountInCents: payoff.paidAmountInCents,
                adjustmentInCents: payoff.adjustmentInCents,
                economicShares: payoff.economicShares,
                resolutionInstallmentIds: resolutions.map(
                    (resolution) => resolution.installmentId,
                ),
                fullyReversed: payoff.compensated,
            };
        }
        const origin = globalPayoff
            ? await this.globalOrigin(root, now, row.id)
            : await this.corrections.read(
                  spaceId,
                  commitmentId,
                  target,
                  now,
                  lock,
              );
        if (!origin) throw new FinancesError('FINANCIAL_REVERSAL_NOT_FOUND');
        const allReversals = await financialFulfillmentReversals(
            manager,
            spaceId,
            commitmentId,
        );
        const reversals = allReversals.filter(
            (reversal) =>
                reversal.originalKind === input.originalKind &&
                reversal.originalId === row.id,
        );
        const blockingResolution =
            root.modality === 'INSTALLMENT' &&
            row.occurrence_id &&
            input.originalKind !== 'EXTERNAL_SETTLEMENT'
                ? await manager.findOneBy(
                      FinancialInstallmentResolutionOrmEntity,
                      {
                          spaceId,
                          commitmentId,
                          installmentId: row.occurrence_id,
                          type: 'PAYOFF',
                          compensated: false,
                      },
                  )
                : null;
        let externalLiability: FinancialFulfillmentReversalState['externalLiability'] =
            null;
        if (row.external_liability_id) {
            const liabilityQuery = manager
                .createQueryBuilder(FinancialExternalLiabilityOrmEntity, 'l')
                .where(
                    'l.space_id=:spaceId AND l.commitment_id=:commitmentId AND l.id=:id',
                    { spaceId, commitmentId, id: row.external_liability_id },
                );
            if (lock) liabilityQuery.setLock('pessimistic_write');
            const liability = await liabilityQuery.getOne();
            if (!liability)
                throw new FinancesError('FINANCIAL_REVERSAL_NOT_FOUND');
            const settlements = await manager.find(
                FinancialExternalLiabilitySettlementOrmEntity,
                {
                    where: {
                        spaceId,
                        commitmentId,
                        externalLiabilityId: liability.id,
                    },
                },
            );
            externalLiability = {
                id: liability.id,
                originalAmountInCents: liability.amountInCents,
                validAmountInCents: validFinancialAmount(
                    liability.amountInCents,
                    allReversals,
                    'EXTERNAL_LIABILITY',
                    liability.id,
                ),
                validSettledAmountInCents: settlements.reduce(
                    (sum, settlement) =>
                        sum +
                        validFinancialAmount(
                            settlement.amountInCents,
                            allReversals,
                            'EXTERNAL_SETTLEMENT',
                            settlement.id,
                        ),
                    0,
                ),
                remainingAmountInCents: liability.remainingAmountInCents,
            };
        }
        return {
            origin,
            original,
            reversals,
            reversibleAmountInCents: validFinancialAmount(
                original.amountInCents,
                reversals,
                input.originalKind,
                row.id,
            ),
            blockingGlobalPayoffId: blockingResolution?.payoffId ?? null,
            externalLiability,
            globalPayoff,
        };
    }
    async reverse(
        state: FinancialFulfillmentReversalState,
        reversal: FinancialFulfillmentReversal,
    ) {
        const manager = this.managers.get();
        if (!manager.queryRunner?.isTransactionActive)
            throw new Error('Financial reversals require a transaction');
        const impact = validateFinancialReversal(state, reversal.amountInCents);
        if (
            reversal.spaceId !== state.origin.spaceId ||
            reversal.commitmentId !== state.origin.id ||
            reversal.targetId !== state.origin.targetId ||
            reversal.originalKind !== state.original.kind ||
            reversal.originalId !== state.original.id ||
            reversal.commitmentVersion !== state.origin.version + 1
        )
            throw new FinancesError('CONCURRENT_MODIFICATION');
        const root = await manager.update(
            FinancialCommitmentOrmEntity,
            {
                id: state.origin.id,
                spaceId: state.origin.spaceId,
                version: state.origin.version,
            },
            { version: reversal.commitmentVersion },
        );
        if (root.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        await manager.insert(FinancialFulfillmentReversalOrmEntity, {
            ...reversal,
            registeredAt: new Date(reversal.registeredAt),
            disbursementId:
                reversal.originalKind === 'DISBURSEMENT'
                    ? reversal.originalId
                    : null,
            externalLiabilityId:
                reversal.originalKind === 'EXTERNAL_LIABILITY'
                    ? reversal.originalId
                    : null,
            externalSettlementId:
                reversal.originalKind === 'EXTERNAL_SETTLEMENT'
                    ? reversal.originalId
                    : null,
            receiptId:
                reversal.originalKind === 'RECEIPT'
                    ? reversal.originalId
                    : null,
        });
        if (state.externalLiability) {
            const changed = await manager.update(
                FinancialExternalLiabilityOrmEntity,
                {
                    id: state.externalLiability.id,
                    spaceId: state.origin.spaceId,
                    commitmentId: state.origin.id,
                    remainingAmountInCents:
                        state.externalLiability.remainingAmountInCents,
                },
                {
                    remainingAmountInCents:
                        impact.externalRemainingAmountInCentsAfter!,
                },
            );
            if (changed.affected !== 1)
                throw new FinancesError('CONCURRENT_MODIFICATION');
        }
        if (state.globalPayoff) {
            const changed = await manager.update(
                FinancialInstallmentPayoffOrmEntity,
                {
                    id: state.globalPayoff.id,
                    spaceId: state.origin.spaceId,
                    commitmentId: state.origin.id,
                    compensated: false,
                },
                { compensated: true },
            );
            if (changed.affected !== 1)
                throw new FinancesError('CONCURRENT_MODIFICATION');
            const rows = await manager.find(
                FinancialInstallmentResolutionOrmEntity,
                {
                    where: {
                        spaceId: state.origin.spaceId,
                        commitmentId: state.origin.id,
                        payoffId: state.globalPayoff.id,
                        compensated: false,
                    },
                    order: { installmentId: 'ASC' },
                },
            );
            for (const resolution of rows) {
                const resolutionChange = await manager.update(
                    FinancialInstallmentResolutionOrmEntity,
                    { id: resolution.id, compensated: false },
                    { compensated: true },
                );
                if (resolutionChange.affected !== 1)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const occurrence = await manager.findOneByOrFail(
                    FinancialOccurrenceOrmEntity,
                    {
                        spaceId: state.origin.spaceId,
                        commitmentId: state.origin.id,
                        installmentId: resolution.installmentId,
                    },
                );
                const occurrenceChange = await manager.update(
                    FinancialOccurrenceOrmEntity,
                    {
                        id: occurrence.id,
                        stateVersion: occurrence.stateVersion,
                    },
                    { stateVersion: occurrence.stateVersion + 1 },
                );
                if (occurrenceChange.affected !== 1)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
            }
        } else if (state.origin.occurrenceId) {
            const fulfilled =
                state.origin.fulfilledAmountInCents -
                (state.original.kind === 'EXTERNAL_SETTLEMENT'
                    ? 0
                    : reversal.amountInCents);
            const status =
                fulfilled === 0
                    ? 'PENDING'
                    : fulfilled === state.origin.amountInCents
                      ? 'FULFILLED'
                      : 'PARTIALLY_FULFILLED';
            const changed = await manager.update(
                FinancialOccurrenceOrmEntity,
                {
                    id: state.origin.occurrenceId,
                    spaceId: state.origin.spaceId,
                    commitmentId: state.origin.id,
                    stateVersion: state.origin.occurrenceVersion,
                },
                { stateVersion: state.origin.occurrenceVersion + 1, status },
            );
            if (changed.affected !== 1)
                throw new FinancesError('CONCURRENT_MODIFICATION');
        }
    }
    async loadOrigin(
        spaceId: string,
        commitmentId: string,
        target: FinancialReversalTarget,
        now: string,
    ) {
        const root = await this.managers
            .get()
            .findOneBy(FinancialCommitmentOrmEntity, {
                id: commitmentId,
                spaceId,
            });
        if (!root) throw new FinancesError('FINANCIAL_REVERSAL_NOT_FOUND');
        if (
            root.modality === 'INSTALLMENT' &&
            !target.installmentId &&
            !target.occurrenceId &&
            !target.referenceDate
        )
            return this.globalOrigin(root, now);
        const origin = await this.corrections.read(
            spaceId,
            commitmentId,
            target,
            now,
        );
        if (!origin) throw new FinancesError('FINANCIAL_REVERSAL_NOT_FOUND');
        return origin;
    }
    private async globalOrigin(
        root: FinancialCommitmentOrmEntity,
        _now: string,
        factId?: string,
    ): Promise<FinancialCorrectionState> {
        const manager = this.managers.get();
        const query = manager
            .createQueryBuilder(FinancialInstallmentPayoffOrmEntity, 'p')
            .innerJoin(
                'financial_disbursements',
                'd',
                'd.id=p.fact_id AND d.space_id=p.space_id AND d.commitment_id=p.commitment_id',
            )
            .where('p.space_id=:spaceId AND p.commitment_id=:id', {
                spaceId: root.spaceId,
                id: root.id,
            })
            .orderBy('d.sequence', 'DESC');
        if (factId) query.andWhere('p.fact_id=:factId', { factId });
        const payoff = await query.getOne();
        if (!payoff) throw new FinancesError('FINANCIAL_REVERSAL_NOT_FOUND');
        const plan = await manager.findOneByOrFail(
            FinancialInstallmentPlanOrmEntity,
            { spaceId: root.spaceId, commitmentId: root.id },
        );
        const reversals = await financialFulfillmentReversals(
            manager,
            root.spaceId,
            root.id,
            root.id,
        );
        const facts: {
            id: string;
            amount: string;
            fact_date: string;
            registered_at: Date;
            recorded_by_person_id: string;
            payer_member_id: string | null;
            payer_person_id: string | null;
            method: 'PIX' | 'DEBIT' | 'CASH';
        }[] = await manager.query(
            `SELECT d.id,d.amount_in_cents::text AS amount,d.fact_date::text,d.registered_at,d.recorded_by_person_id,d.payer_member_id,d.payer_person_id,d.method FROM financial_disbursements d JOIN financial_installment_payoffs p ON p.space_id=d.space_id AND p.commitment_id=d.commitment_id AND p.fact_id=d.id WHERE d.space_id=$1 AND d.commitment_id=$2 ORDER BY d.sequence`,
            [root.spaceId, root.id],
        );
        const validFacts: OccurrenceFact[] = facts
            .map((fact) => ({
                id: fact.id,
                kind: 'DISBURSEMENT' as const,
                amountInCents: validFinancialAmount(
                    Number(fact.amount),
                    reversals,
                    'DISBURSEMENT',
                    fact.id,
                ),
                factDate: fact.fact_date,
                registeredAt: fact.registered_at.toISOString(),
                recordedByPersonId: fact.recorded_by_person_id,
                payerMemberId: fact.payer_member_id,
                payerPersonId: fact.payer_person_id,
                method: fact.method,
            }))
            .filter((fact) => fact.amountInCents > 0);
        return {
            id: root.id,
            spaceId: root.spaceId,
            kind: 'EXPENSE',
            modality: 'INSTALLMENT',
            description: root.description,
            createdByPersonId: root.createdBy,
            registeredAt: root.registeredAt.toISOString(),
            version: root.version,
            personal: root.personalOwnerPersonId !== null,
            targetId: root.id,
            referenceDate: payoff.factDate,
            occurrenceId: null,
            installmentId: null,
            occurrenceVersion: 1,
            economicVersion: 1,
            projected: false,
            cancelled: false,
            resolved: false,
            originalAmountInCents: payoff.paidAmountInCents,
            amountInCents: payoff.paidAmountInCents,
            fulfilledAmountInCents: validFacts.reduce(
                (sum, fact) => sum + fact.amountInCents,
                0,
            ),
            shares: payoff.economicShares,
            distribution: payoff.economicShares
                ? {
                      mode: 'AMOUNTS',
                      shares: payoff.economicShares.map(
                          (share: EconomicShare) => ({ ...share }),
                      ),
                  }
                : null,
            expectedMemberId: plan.expectedMemberId,
            settlementRuleSnapshot: plan.ruleSnapshot,
            settlementRuleSourceVersion: plan.ruleSourceVersion,
            facts: validFacts,
            adjustments: [],
            cancellation: null,
            reversals,
        };
    }
    async list(spaceId: string, commitmentId: string, after: string | null) {
        const manager = this.managers.get();
        const totalCount = await manager.count(
            FinancialFulfillmentReversalOrmEntity,
            { where: { spaceId, commitmentId } },
        );
        const query = manager
            .createQueryBuilder(FinancialFulfillmentReversalOrmEntity, 'r')
            .where('r.space_id=:spaceId AND r.commitment_id=:commitmentId', {
                spaceId,
                commitmentId,
            });
        if (after) query.andWhere('r.id>:after', { after });
        const rows = await query.orderBy('r.id', 'ASC').take(21).getMany();
        return {
            items: rows.map((row) => ({
                id: row.id,
                spaceId: row.spaceId,
                commitmentId: row.commitmentId,
                targetId: row.targetId,
                occurrenceId: row.occurrenceId,
                installmentId: row.installmentId,
                commitmentVersion: row.commitmentVersion,
                originalKind: row.originalKind,
                originalId: row.originalId,
                amountInCents: row.amountInCents,
                reason: row.reason,
                factDate: row.factDate,
                actorId: row.actorId,
                registeredAt: row.registeredAt.toISOString(),
            })),
            totalCount,
        };
    }
}
