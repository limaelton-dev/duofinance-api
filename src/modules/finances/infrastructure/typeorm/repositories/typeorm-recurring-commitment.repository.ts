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
            effectiveFrom: root.effectiveFrom,
            description: root.description,
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
        const versions = await m.find(FinancialRecurrenceVersionOrmEntity, {
            where: { spaceId, commitmentId },
            order: { version: 'ASC' },
        });
        const [termination]: { ends_on: string }[] = await m.query(
            `SELECT ends_on::text AS ends_on FROM financial_recurrence_terminations WHERE commitment_id=$1`,
            [commitmentId],
        );
        return this.hydrateSeries(c, versions, termination?.ends_on ?? null);
    }

    private hydrateSeries(
        c: FinancialCommitmentOrmEntity,
        versions: FinancialRecurrenceVersionOrmEntity[],
        terminatedOn: string | null,
    ): RecurringCommitment {
        const snapshots = versions.map((v) => ({
            effectiveFrom: v.effectiveFrom,
            configuration: this.hydrate(c, v),
        }));
        const latest = snapshots.at(-1)!.configuration;
        return new RecurringCommitment(
            latest.id,
            latest.spaceId,
            latest.kind,
            latest.description,
            latest.amountInCents,
            latest.rule,
            latest.createdByPersonId,
            latest.registeredAt,
            latest.economicVersion,
            c.version,
            latest.participation,
            latest.valueMode,
            latest.effectiveFrom,
            snapshots,
            terminatedOn,
        );
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
            v.description,
            v.amountInCents,
            new RecurrenceRule(pattern, v.startsOn, v.endsOn),
            c.createdBy,
            c.registeredAt.toISOString(),
            v.version,
            c.version,
            participation,
            v.valueMode,
            v.effectiveFrom,
        );
    }

    async saveVersion(
        root: RecurringCommitment,
        next: RecurringCommitment,
        effectiveFrom: string,
    ): Promise<void> {
        const m = this.manager();
        const updated = await m.update(
            FinancialCommitmentOrmEntity,
            { id: root.id, spaceId: root.spaceId, version: root.version },
            { version: root.version + 1 },
        );
        if (updated.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        const p = next.participation;
        await m.insert(FinancialRecurrenceVersionOrmEntity, {
            commitmentId: root.id,
            spaceId: root.spaceId,
            version: next.economicVersion,
            effectiveFrom,
            description: next.description,
            amountInCents: next.amountInCents,
            valueMode: next.valueMode,
            frequency: next.rule.pattern.frequency,
            dayOfMonth: next.rule.pattern.dayOfMonth,
            monthOfYear:
                next.rule.pattern.frequency === 'ANNUAL'
                    ? next.rule.pattern.monthOfYear
                    : null,
            startsOn: next.rule.startsOn,
            endsOn: next.rule.endsOn,
            ownerPersonId: p.type === 'PERSONAL' ? p.ownerPersonId : null,
            splitInput: p.type === 'SHARED' ? p.distribution : null,
            expectedMemberId: p.type === 'SHARED' ? p.expectedMemberId : null,
            ruleSnapshot: p.type === 'SHARED' ? p.settlementRuleSnapshot : null,
            ruleSourceVersion:
                p.type === 'SHARED' ? p.settlementRuleSourceVersion : 0,
            registeredAt: new Date(next.registeredAt),
        });
        if (p.type === 'SHARED' && p.split)
            for (const share of p.split.shares)
                await m.insert(FinancialRecurrenceShareOrmEntity, {
                    commitmentId: root.id,
                    spaceId: root.spaceId,
                    version: next.economicVersion,
                    memberId: share.memberId,
                    amountInCents: share.amountInCents,
                });
    }

    async terminate(
        root: RecurringCommitment,
        endsOn: string,
        actorId: string,
        now: string,
    ): Promise<void> {
        const m = this.manager();
        const updated = await m.update(
            FinancialCommitmentOrmEntity,
            { id: root.id, spaceId: root.spaceId, version: root.version },
            { version: root.version + 1 },
        );
        if (updated.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        await m.query(
            `INSERT INTO financial_recurrence_terminations (space_id,commitment_id,ends_on,actor_id,registered_at,commitment_version) VALUES ($1,$2,$3,$4,$5,$6)`,
            [root.spaceId, root.id, endsOn, actorId, now, root.version + 1],
        );
    }

    async materializedAfter(root: RecurringCommitment, date: string) {
        return this.provider.readSnapshot(async () =>
            this.manager().query(
                `SELECT reference_date::text AS "referenceDate",status,economic_version AS "economicVersion" FROM financial_occurrences WHERE space_id=$1 AND commitment_id=$2 AND reference_date>=$3 ORDER BY reference_date`,
                [root.spaceId, root.id, date],
            ),
        );
    }

    async occurrencesInMonth(root: RecurringCommitment, month: string) {
        const rows: { reference_date: string }[] =
            await this.provider.readSnapshot(async () =>
                this.manager().query(
                    `SELECT reference_date::text AS reference_date FROM financial_occurrences WHERE space_id=$1 AND commitment_id=$2 AND reference_date>=($3::date) AND reference_date<($3::date+interval '1 month') ORDER BY reference_date`,
                    [root.spaceId, root.id, `${month}-01`],
                ),
            );
        const occurrences: FinancialOccurrence[] = [];
        for (const row of rows)
            occurrences.push(
                (await this.occurrence(root, row.reference_date))!,
            );
        return occurrences;
    }

    async cancel(
        root: RecurringCommitment,
        occurrence: FinancialOccurrence,
        wasProjected: boolean,
    ) {
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
            const updated = await m.update(
                FinancialOccurrenceOrmEntity,
                {
                    id: occurrence.id,
                    spaceId: root.spaceId,
                    stateVersion: occurrence.stateVersion - 1,
                    status: 'PENDING',
                },
                { stateVersion: occurrence.stateVersion, status: 'CANCELLED' },
            );
            if (updated.affected !== 1)
                throw new FinancesError('CONCURRENT_MODIFICATION');
        }
        await m.query(
            `INSERT INTO financial_occurrence_cancellations (occurrence_id,space_id,commitment_id,actor_id,registered_at) VALUES ($1,$2,$3,$4,$5)`,
            [
                occurrence.id,
                root.spaceId,
                root.id,
                occurrence.cancellation!.actorId,
                occurrence.cancellation!.registeredAt,
            ],
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
        const rows = `WITH versions AS (
            SELECT v.*,LEAD(v.effective_from) OVER (PARTITION BY v.commitment_id ORDER BY v.effective_from) AS next_from
            FROM financial_recurrence_versions v WHERE v.space_id=$1
        ), eligible_projection AS (
            SELECT c.id,${candidate} AS reference_date,CASE WHEN v.value_mode='VARIABLE' THEN o.amount_in_cents ELSE COALESCE(o.amount_in_cents,v.amount_in_cents) END AS amount
            FROM financial_commitments c JOIN versions v ON v.space_id=c.space_id AND v.commitment_id=c.id
            LEFT JOIN financial_recurrence_terminations t ON t.space_id=c.space_id AND t.commitment_id=c.id
            LEFT JOIN financial_occurrences o ON o.space_id=c.space_id AND o.commitment_id=c.id AND o.reference_date=${candidate}
            WHERE c.space_id=$1 AND c.modality='RECURRING' AND (v.frequency='MONTHLY' OR v.month_of_year=EXTRACT(MONTH FROM $2::date)::integer)
                AND ${candidate}>=v.starts_on AND (v.ends_on IS NULL OR ${candidate}<=v.ends_on)
                AND ${candidate}>=v.effective_from AND (v.next_from IS NULL OR ${candidate}<v.next_from)
                AND (t.ends_on IS NULL OR ${candidate}<=t.ends_on) AND (o.status IS NULL OR o.status<>'CANCELLED')
                AND NOT EXISTS (SELECT 1 FROM financial_occurrences existing WHERE existing.space_id=c.space_id AND existing.commitment_id=c.id AND existing.reference_date>=($2::date) AND existing.reference_date<($2::date+interval '1 month') AND existing.reference_date<>${candidate})
        ), projected AS (
            SELECT id,reference_date,amount FROM (
                SELECT eligible_projection.*,ROW_NUMBER() OVER (PARTITION BY id ORDER BY reference_date) AS position
                FROM eligible_projection
            ) ranked WHERE position=1
        ), actual AS (
            SELECT c.id,o.reference_date,o.amount_in_cents AS amount FROM financial_occurrences o
            JOIN financial_commitments c ON c.space_id=o.space_id AND c.id=o.commitment_id
            WHERE o.space_id=$1 AND c.modality='RECURRING' AND o.reference_date>=($2::date)
                AND o.reference_date<($2::date+interval '1 month') AND o.status<>'CANCELLED'
                AND NOT EXISTS (SELECT 1 FROM projected p WHERE p.id=c.id AND p.reference_date=o.reference_date)
        ), rows AS (SELECT * FROM projected UNION ALL SELECT * FROM actual)`;
        const counts: { count: string; amount: string; unknown: string }[] =
            await m.query(
                `${rows} SELECT COUNT(DISTINCT id)::text AS count,COALESCE(SUM(amount),0)::text AS amount,COUNT(*) FILTER (WHERE amount IS NULL)::text AS unknown FROM rows`,
                [spaceId, start],
            );
        const ids: { id: string; reference_date: string }[] = await m.query(
            `${rows} SELECT id,MIN(reference_date)::text AS reference_date FROM rows WHERE ($3::uuid IS NULL OR id>$3::uuid) GROUP BY id ORDER BY id LIMIT 21`,
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
                where: { spaceId, commitmentId: In(keys) },
            }),
        ]);
        const rootById = new Map(roots.map((root) => [root.id, root]));
        const terminations: { commitment_id: string; ends_on: string }[] =
            await m.query(
                `SELECT commitment_id,ends_on::text AS ends_on FROM financial_recurrence_terminations WHERE space_id=$1 AND commitment_id=ANY($2::uuid[])`,
                [spaceId, keys],
            );
        const items = ids.map((row) => ({
            commitment: this.hydrateSeries(
                rootById.get(row.id)!,
                versions
                    .filter((v) => v.commitmentId === row.id)
                    .sort((a, b) => a.version - b.version),
                terminations.find((t) => t.commitment_id === row.id)?.ends_on ??
                    null,
            ),
            referenceDate: row.reference_date,
        }));
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
        const [cancellation]: { actor_id: string; registered_at: Date }[] =
            await m.query(
                `SELECT actor_id,registered_at FROM financial_occurrence_cancellations WHERE occurrence_id=$1`,
                [row.id],
            );
        if (row.economicVersion === null)
            throw new Error('Recurring occurrence without economic version');
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
            cancellation
                ? {
                      actorId: cancellation.actor_id,
                      registeredAt: cancellation.registered_at.toISOString(),
                  }
                : null,
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
