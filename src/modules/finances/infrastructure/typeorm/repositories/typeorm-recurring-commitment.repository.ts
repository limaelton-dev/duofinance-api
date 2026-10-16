import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { In } from 'typeorm';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { RecurringCommitmentRepository } from '../../../application/ports/private/recurring-commitment.repository.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import {
    FinancialOccurrence,
    type OccurrenceFact,
} from '../../../domain/recurrence/financial-occurrence.js';
import { RecurringCommitment } from '../../../domain/recurrence/recurring-commitment.js';
import { RecurrenceRule } from '../../../domain/recurrence/recurrence-rule.js';
import {
    ResponsibilitySplit,
    type EconomicShare,
} from '../../../domain/shared-expense/responsibility-split.js';
import {
    FinancialCommitmentOrmEntity,
    FinancialDisbursementOrmEntity,
    FinancialExternalLiabilityOrmEntity,
} from '../entities/shared-expense.orm-entity.js';
import { FinancialReceiptOrmEntity } from '../entities/income.orm-entity.js';
import {
    FinancialOccurrenceOrmEntity,
    FinancialRecurrenceCommandReceiptOrmEntity,
    FinancialRecurrenceShareOrmEntity,
    FinancialRecurrenceVersionOrmEntity,
} from '../entities/recurrence.orm-entity.js';
import { recordFinancialCommandAudit } from './record-financial-command-audit.js';

@Injectable()
export class TypeOrmRecurringCommitmentRepository implements RecurringCommitmentRepository {
    constructor(private readonly provider: EntityManagerProvider) {}

    private manager() {
        return this.provider.get();
    }

    async save(root: RecurringCommitment): Promise<void> {
        const m = this.manager();
        const personal = root.participation.type === 'PERSONAL';
        await m.insert(FinancialCommitmentOrmEntity, {
            id: root.id,
            spaceId: root.spaceId,
            kind: root.kind,
            modality: 'RECURRING',
            description: root.description,
            createdBy: root.createdByPersonId,
            personalOwnerPersonId: personal ? root.createdByPersonId : null,
            version: root.version,
            registeredAt: new Date(root.registeredAt),
        });
        const p = root.participation;
        await m.insert(FinancialRecurrenceVersionOrmEntity, {
            commitmentId: root.id,
            spaceId: root.spaceId,
            version: root.economicVersion,
            amountInCents: root.amountInCents,
            valueMode: root.valueMode,
            frequency: root.rule.pattern.frequency,
            dayOfMonth: root.rule.pattern.dayOfMonth,
            monthOfYear:
                root.rule.pattern.frequency === 'ANNUAL'
                    ? root.rule.pattern.monthOfYear
                    : null,
            startsOn: root.rule.startsOn,
            endsOn: root.rule.endsOn,
            ownerPersonId: p.type === 'PERSONAL' ? p.ownerPersonId : null,
            splitInput: p.type === 'SHARED' ? p.distribution : null,
            expectedMemberId: p.type === 'SHARED' ? p.expectedMemberId : null,
            ruleSnapshot: p.type === 'SHARED' ? p.settlementRuleSnapshot : null,
            ruleSourceVersion:
                p.type === 'SHARED' ? p.settlementRuleSourceVersion : 0,
            registeredAt: new Date(root.registeredAt),
        });
        if (p.type === 'SHARED' && p.split)
            for (const share of p.split.shares)
                await m.insert(FinancialRecurrenceShareOrmEntity, {
                    commitmentId: root.id,
                    spaceId: root.spaceId,
                    version: root.economicVersion,
                    memberId: share.memberId,
                    amountInCents: share.amountInCents,
                });
    }

    async find(
        spaceId: string,
        commitmentId: string,
        lock = false,
    ): Promise<RecurringCommitment | null> {
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
    ): Promise<RecurringCommitment | null> {
        const m = this.manager();
        const q = m
            .createQueryBuilder(FinancialCommitmentOrmEntity, 'c')
            .where(
                'c.space_id=:spaceId AND c.id=:commitmentId AND c.modality=:modality',
                { spaceId, commitmentId, modality: 'RECURRING' },
            );
        if (lock) q.setLock('pessimistic_write');
        const c = await q.getOne();
        if (!c) return null;
        const v = await m.findOneByOrFail(FinancialRecurrenceVersionOrmEntity, {
            spaceId,
            commitmentId,
            version: 1,
        });
        return this.hydrate(c, v);
    }

    private hydrate(
        c: FinancialCommitmentOrmEntity,
        v: FinancialRecurrenceVersionOrmEntity,
    ): RecurringCommitment {
        const pattern =
            v.frequency === 'MONTHLY'
                ? { frequency: 'MONTHLY' as const, dayOfMonth: v.dayOfMonth }
                : {
                      frequency: 'ANNUAL' as const,
                      monthOfYear: v.monthOfYear!,
                      dayOfMonth: v.dayOfMonth,
                  };
        const participation = v.ownerPersonId
            ? { type: 'PERSONAL' as const, ownerPersonId: v.ownerPersonId }
            : {
                  type: 'SHARED' as const,
                  split:
                      v.valueMode === 'FIXED'
                          ? ResponsibilitySplit.create(
                                v.amountInCents!,
                                v.splitInput!.shares.map((s) => s.memberId),
                                v.splitInput!,
                            )
                          : null,
                  distribution: v.splitInput!,
                  expectedMemberId: v.expectedMemberId,
                  settlementRuleSnapshot: v.ruleSnapshot,
                  settlementRuleSourceVersion: v.ruleSourceVersion,
              };
        return new RecurringCommitment(
            c.id,
            c.spaceId,
            c.kind as 'EXPENSE' | 'INCOME',
            c.description,
            v.amountInCents,
            new RecurrenceRule(pattern, v.startsOn, v.endsOn),
            c.createdBy,
            c.registeredAt.toISOString(),
            v.version,
            c.version,
            participation,
            v.valueMode,
        );
    }

    async list(spaceId: string, month: string, after: string | null) {
        return this.provider.readSnapshot(() =>
            this.listInSnapshot(spaceId, month, after),
        );
    }

    private async listInSnapshot(
        spaceId: string,
        month: string,
        after: string | null,
    ) {
        const m = this.manager();
        const start = `${month}-01`;
        const last = `((date_trunc('month',$2::date)+interval '1 month - 1 day')::date)`;
        const candidate = `make_date(EXTRACT(YEAR FROM $2::date)::integer,EXTRACT(MONTH FROM $2::date)::integer,LEAST(v.day_of_month,EXTRACT(DAY FROM ${last})::integer))`;
        const conditions = `c.space_id=$1 AND c.modality='RECURRING' AND v.version=1 AND (v.frequency='MONTHLY' OR v.month_of_year=EXTRACT(MONTH FROM $2::date)::integer) AND ${candidate}>=v.starts_on AND (v.ends_on IS NULL OR ${candidate}<=v.ends_on)`;
        const effective = `CASE WHEN v.value_mode='VARIABLE' THEN o.amount_in_cents ELSE v.amount_in_cents END`;
        const counts: { count: string; amount: string; unknown: string }[] =
            await m.query(
                `SELECT COUNT(*)::text AS count,COALESCE(SUM(${effective}),0)::text AS amount,COUNT(*) FILTER (WHERE ${effective} IS NULL)::text AS unknown FROM financial_commitments c JOIN financial_recurrence_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id LEFT JOIN financial_occurrences o ON o.space_id=c.space_id AND o.commitment_id=c.id AND o.reference_date=${candidate} WHERE ${conditions}`,
                [spaceId, start],
            );
        const ids: { id: string }[] = await m.query(
            `SELECT c.id FROM financial_commitments c JOIN financial_recurrence_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id WHERE ${conditions} AND ($3::uuid IS NULL OR c.id>$3::uuid) ORDER BY c.id LIMIT 21`,
            [spaceId, start, after],
        );
        if (ids.length === 0)
            return {
                items: [],
                totalCount: Number(counts[0].count),
                totalAmountInCents: counts[0].amount,
                unknownAmountCount: Number(counts[0].unknown),
            };
        const keys = ids.map((row) => row.id);
        const [roots, versions] = await Promise.all([
            m.find(FinancialCommitmentOrmEntity, {
                where: { spaceId, id: In(keys) },
            }),
            m.find(FinancialRecurrenceVersionOrmEntity, {
                where: { spaceId, commitmentId: In(keys), version: 1 },
            }),
        ]);
        const rootById = new Map(roots.map((root) => [root.id, root]));
        const versionById = new Map(versions.map((v) => [v.commitmentId, v]));
        const items = ids.map((row) =>
            this.hydrate(rootById.get(row.id)!, versionById.get(row.id)!),
        );
        return {
            items,
            totalCount: Number(counts[0].count),
            totalAmountInCents: counts[0].amount,
            unknownAmountCount: Number(counts[0].unknown),
        };
    }

    async occurrence(
        root: RecurringCommitment,
        referenceDate: string,
    ): Promise<FinancialOccurrence | null> {
        return this.provider.readSnapshot(() =>
            this.occurrenceInSnapshot(root, referenceDate),
        );
    }

    private async occurrenceInSnapshot(
        root: RecurringCommitment,
        referenceDate: string,
    ): Promise<FinancialOccurrence | null> {
        const m = this.manager();
        const row = await m.findOneBy(FinancialOccurrenceOrmEntity, {
            spaceId: root.spaceId,
            commitmentId: root.id,
            referenceDate,
        });
        if (!row) return null;
        const [disbursements, receipts, liabilities, settlements] =
            await Promise.all([
                m.find(FinancialDisbursementOrmEntity, {
                    where: {
                        spaceId: root.spaceId,
                        commitmentId: root.id,
                        occurrenceId: row.id,
                    },
                    order: { sequence: 'ASC' },
                }),
                m.find(FinancialReceiptOrmEntity, {
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
                    `SELECT s.* FROM financial_external_liability_settlements s JOIN financial_external_liabilities l ON l.space_id=s.space_id AND l.commitment_id=s.commitment_id AND l.id=s.external_liability_id WHERE l.space_id=$1 AND l.occurrence_id=$2 ORDER BY s.sequence`,
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
        const sequenced = [
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
            ...receipts.map((f) => ({
                sequence: f.sequence,
                fact: {
                    kind: 'RECEIPT' as const,
                    id: f.id,
                    amountInCents: f.amountInCents,
                    factDate: f.factDate,
                    registeredAt: f.registeredAt.toISOString(),
                    recordedByPersonId: f.recordedByPersonId,
                    recipientMemberId: f.recipientMemberId,
                    recipientPersonId: f.recipientPersonId,
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
        ];
        const facts: OccurrenceFact[] = sequenced
            .sort((a, b) => a.sequence - b.sequence)
            .map((row) => row.fact);
        const changes: {
            version: number;
            previous_amount_in_cents: string | null;
            amount_in_cents: string;
            actor_id: string;
            registered_at: Date;
        }[] = await m.query(
            `SELECT version,previous_amount_in_cents,amount_in_cents,actor_id,registered_at FROM financial_occurrence_value_changes WHERE occurrence_id=$1 ORDER BY version`,
            [row.id],
        );
        return new FinancialOccurrence(
            row.id,
            row.commitmentId,
            row.spaceId,
            row.referenceDate,
            row.economicVersion,
            row.stateVersion,
            row.amountInCents,
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
            changes.map((change) => ({
                version: change.version,
                previousAmountInCents:
                    change.previous_amount_in_cents === null
                        ? null
                        : Number(change.previous_amount_in_cents),
                amountInCents: Number(change.amount_in_cents),
                actorId: change.actor_id,
                registeredAt: change.registered_at.toISOString(),
            })),
        );
    }

    async defineValue(
        root: RecurringCommitment,
        occurrence: FinancialOccurrence,
        shares: readonly EconomicShare[] | null,
        wasProjected: boolean,
    ): Promise<void> {
        const m = this.manager();
        const change = occurrence.valueHistory.at(-1)!;
        if (wasProjected) {
            await m.insert(FinancialOccurrenceOrmEntity, {
                id: occurrence.id,
                spaceId: root.spaceId,
                commitmentId: root.id,
                referenceDate: occurrence.referenceDate,
                economicVersion: occurrence.economicVersion,
                stateVersion: occurrence.stateVersion,
                amountInCents: occurrence.amountInCents,
                status: occurrence.status,
                materializedAt: new Date(occurrence.materializedAt),
            });
        } else {
            const changed = await m.update(
                FinancialOccurrenceOrmEntity,
                {
                    id: occurrence.id,
                    spaceId: root.spaceId,
                    stateVersion: occurrence.stateVersion - 1,
                    status: 'PENDING',
                },
                {
                    stateVersion: occurrence.stateVersion,
                    amountInCents: occurrence.amountInCents,
                },
            );
            if (changed.affected !== 1)
                throw new FinancesError('CONCURRENT_MODIFICATION');
        }
        await m.query(
            `INSERT INTO financial_occurrence_value_changes (occurrence_id,version,space_id,commitment_id,previous_amount_in_cents,amount_in_cents,shares,actor_id,registered_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
                occurrence.id,
                change.version,
                root.spaceId,
                root.id,
                change.previousAmountInCents,
                change.amountInCents,
                shares ? JSON.stringify(shares) : null,
                change.actorId,
                change.registeredAt,
            ],
        );
        await m.query(
            `DELETE FROM financial_occurrence_shares WHERE occurrence_id=$1`,
            [occurrence.id],
        );
        for (const share of shares ?? [])
            await m.query(
                `INSERT INTO financial_occurrence_shares (occurrence_id,member_id,space_id,commitment_id,amount_in_cents) VALUES ($1,$2,$3,$4,$5)`,
                [
                    occurrence.id,
                    share.memberId,
                    root.spaceId,
                    root.id,
                    share.amountInCents,
                ],
            );
    }

    private async nextSequence(root: RecurringCommitment): Promise<number> {
        const [row]: { n: number }[] = await this.manager().query(
            `SELECT (SELECT COUNT(*) FROM financial_disbursements WHERE space_id=$1 AND commitment_id=$2)+(SELECT COUNT(*) FROM financial_receipts WHERE space_id=$1 AND commitment_id=$2)+(SELECT COUNT(*) FROM financial_external_liabilities WHERE space_id=$1 AND commitment_id=$2)+(SELECT COUNT(*) FROM financial_external_liability_settlements WHERE space_id=$1 AND commitment_id=$2)+1 AS n`,
            [root.spaceId, root.id],
        );
        return Number(row.n);
    }

    async record(
        root: RecurringCommitment,
        occurrence: FinancialOccurrence,
        fact: OccurrenceFact,
        wasProjected: boolean,
    ): Promise<void> {
        const m = this.manager();
        if (wasProjected)
            await m.insert(FinancialOccurrenceOrmEntity, {
                id: occurrence.id,
                spaceId: root.spaceId,
                commitmentId: root.id,
                referenceDate: occurrence.referenceDate,
                economicVersion: occurrence.economicVersion,
                stateVersion: occurrence.stateVersion,
                amountInCents: occurrence.amountInCents,
                status: occurrence.status,
                materializedAt: new Date(occurrence.materializedAt),
            });
        else {
            const changed = await m.update(
                FinancialOccurrenceOrmEntity,
                {
                    id: occurrence.id,
                    spaceId: root.spaceId,
                    stateVersion: occurrence.stateVersion - 1,
                },
                {
                    stateVersion: occurrence.stateVersion,
                    status: occurrence.status,
                },
            );
            if (changed.affected !== 1)
                throw new FinancesError('CONCURRENT_MODIFICATION');
        }
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
        if (fact.kind === 'RECEIPT')
            await m.insert(FinancialReceiptOrmEntity, {
                id: fact.id,
                spaceId: root.spaceId,
                commitmentId: root.id,
                occurrenceId: occurrence.id,
                sequence,
                recordedByPersonId: fact.recordedByPersonId,
                recipientMemberId: fact.recipientMemberId,
                recipientPersonId: fact.recipientPersonId,
                amountInCents: fact.amountInCents,
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
    }

    async settleExternal(
        root: RecurringCommitment,
        occurrence: FinancialOccurrence,
        liabilityId: string,
        amountInCents: number,
        factDate: string,
        actorId: string,
        key: string,
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
        const sequence = await this.nextSequence(root);
        const id = randomUUID();
        await m.query(
            `INSERT INTO financial_external_liability_settlements (id,space_id,commitment_id,external_liability_id,sequence,holder_member_id,holder_person_id,recorded_by_person_id,receipt_operation,idempotency_key,amount_in_cents,fact_date,registered_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,$9,$10,$11)`,
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
        const updated = await m.update(
            FinancialOccurrenceOrmEntity,
            { id: occurrence.id, stateVersion: occurrence.stateVersion },
            { stateVersion: occurrence.stateVersion + 1 },
        );
        if (updated.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        return { id, remainingAmountInCents: remaining };
    }

    async findReceipt(
        actorId: string,
        operation: string,
        key: string,
        hash: Buffer,
    ): Promise<unknown | null> {
        const row = await this.manager().findOneBy(
            FinancialRecurrenceCommandReceiptOrmEntity,
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
        occurrenceId: string | null,
        operation: string,
        key: string,
        hash: Buffer,
        result: unknown,
        now: string,
    ): Promise<void> {
        await this.manager().insert(
            FinancialRecurrenceCommandReceiptOrmEntity,
            {
                actorId,
                operation,
                idempotencyKey: key,
                requestHash: hash,
                status: 'COMPLETED',
                spaceId,
                commitmentId,
                occurrenceId,
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
