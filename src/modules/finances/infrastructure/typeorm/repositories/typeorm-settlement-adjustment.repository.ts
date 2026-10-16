import { Injectable } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { SettlementAdjustmentReceiptRaceError } from '../../../application/ports/private/settlement-adjustment.repository.js';
import { createHash, randomUUID } from 'node:crypto';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type {
    AdjustmentOperation,
    AdjustmentResult,
    SettlementAdjustmentRepository,
} from '../../../application/ports/private/settlement-adjustment.repository.js';
import type {
    AdjustmentCommand,
    AssignmentCycle,
} from '../../../application/models/settlement-adjustment.js';
import type { CommitmentSettlementRule } from '../../../domain/settlement-rule/commitment-settlement-rule.js';
import type { SettlementRuleSnapshot } from '../../../domain/settlement-rule/settlement-rule.js';
import type { InterMemberObligation } from '../../../domain/shared-expense/inter-member-obligation.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import {
    FinancialCommitmentOrmEntity,
    InterMemberObligationChangeOrmEntity,
} from '../entities/shared-expense.orm-entity.js';
import {
    FinancialCommitmentSettlementRuleOrmEntity,
    FinancialCommitmentSettlementRuleChangeOrmEntity,
    FinancialSettlementAdjustmentReceiptOrmEntity,
    FinancialSettlementAdjustmentAuditOrmEntity,
} from '../entities/settlement-adjustment.orm-entity.js';

function canonical(value: unknown): string {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value !== null && typeof value === 'object')
        return (
            '{' +
            Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
                .join(',') +
            '}'
        );
    return JSON.stringify(value);
}
function hash(command: AdjustmentCommand) {
    const input = {
        ...command,
        actorId: command.actorId.value,
        spaceId: command.spaceId.value,
    };
    if (
        'expectedCycleVersions' in input &&
        Array.isArray(input.expectedCycleVersions)
    )
        input.expectedCycleVersions = [...input.expectedCycleVersions].sort(
            (a, b) => a.cycleId.localeCompare(b.cycleId),
        );
    return createHash('sha256').update(canonical(input)).digest();
}
@Injectable()
export class TypeOrmSettlementAdjustmentRepository implements SettlementAdjustmentRepository {
    constructor(private readonly provider: EntityManagerProvider) {}
    readSnapshot<T>(work: () => Promise<T>): Promise<T> {
        return this.provider.readSnapshot(work);
    }
    private transaction() {
        const manager = this.provider.get();
        if (!manager.queryRunner?.isTransactionActive)
            throw new Error(
                'Settlement adjustment write requires a transaction',
            );
        return manager;
    }
    async findReceipt<T extends AdjustmentResult>(
        operation: AdjustmentOperation,
        c: AdjustmentCommand,
    ): Promise<T | null> {
        const row = await this.provider
            .get()
            .findOneBy(FinancialSettlementAdjustmentReceiptOrmEntity, {
                actorId: c.actorId.value,
                operation,
                idempotencyKey: c.idempotencyKey,
            });
        if (!row) return null;
        if (!row.requestHash.equals(hash(c)))
            throw new FinancesError('IDEMPOTENCY_KEY_REUSED');
        return row.result as T;
    }
    async saveReceipt(
        operation: AdjustmentOperation,
        c: AdjustmentCommand,
        result: AdjustmentResult,
        now: string,
    ) {
        try {
            await this.transaction().insert(
                FinancialSettlementAdjustmentReceiptOrmEntity,
                {
                    actorId: c.actorId.value,
                    spaceId: c.spaceId.value,
                    operation,
                    idempotencyKey: c.idempotencyKey,
                    requestHash: hash(c),
                    result,
                    registeredAt: new Date(now),
                },
            );
        } catch (error) {
            if (
                error instanceof QueryFailedError &&
                (error.driverError as { code?: string }).code === '23505'
            )
                throw new SettlementAdjustmentReceiptRaceError();
            throw error;
        }
        await this.provider
            .get()
            .insert(FinancialSettlementAdjustmentAuditOrmEntity, {
                id: randomUUID(),
                spaceId: c.spaceId.value,
                actorId: c.actorId.value,
                idempotencyKey: c.idempotencyKey,
                action: operation,
                targetId:
                    'commitmentId' in result
                        ? result.commitmentId
                        : result.obligation.id,
                payload:
                    'commitmentId' in result
                        ? {
                              commitmentVersion: result.commitmentVersion,
                              ruleVersion: result.settlementRule.version,
                          }
                        : {
                              obligationVersion: result.obligation.version,
                              affectedCycleIds: result.affectedCycleIds,
                          },
                registeredAt: new Date(now),
            });
    }
    async commitment(spaceId: string, id: string, lock: boolean) {
        const c = await this.provider
            .get()
            .findOne(FinancialCommitmentOrmEntity, {
                where: { spaceId, id },
                ...(lock
                    ? { lock: { mode: 'pessimistic_write' as const } }
                    : {}),
            });
        if (!c || c.personalOwnerPersonId) return null;
        const rule = await this.provider
            .get()
            .findOneBy(FinancialCommitmentSettlementRuleOrmEntity, {
                spaceId,
                commitmentId: id,
            });
        return {
            id,
            version: c.version,
            specificRuleVersion: rule?.version ?? 0,
        };
    }
    async saveRule(
        spaceId: string,
        rule: CommitmentSettlementRule,
        actorId: string,
        now: string,
    ) {
        const m = this.transaction();
        const previous = await m.findOneBy(
            FinancialCommitmentSettlementRuleOrmEntity,
            { spaceId, commitmentId: rule.commitmentId },
        );
        const update = await m.update(
            FinancialCommitmentOrmEntity,
            {
                spaceId,
                id: rule.commitmentId,
                version: rule.commitmentVersion - 1,
            },
            { version: rule.commitmentVersion },
        );
        if (update.affected !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        await m.upsert(
            FinancialCommitmentSettlementRuleOrmEntity,
            {
                commitmentId: rule.commitmentId,
                spaceId,
                version: rule.version,
                rule: rule.rule.snapshot,
            },
            ['commitmentId'],
        );
        await m.insert(FinancialCommitmentSettlementRuleChangeOrmEntity, {
            commitmentId: rule.commitmentId,
            version: rule.version,
            spaceId,
            commitmentVersion: rule.commitmentVersion,
            actorId,
            previousRule: previous?.rule ?? null,
            rule: rule.rule.snapshot,
            registeredAt: new Date(now),
        });
    }
    async effectiveRule(
        spaceId: string,
        commitmentId: string,
        inherited: SettlementRuleSnapshot | null,
        version: number,
    ) {
        const row = await this.provider
            .get()
            .findOneBy(FinancialCommitmentSettlementRuleOrmEntity, {
                spaceId,
                commitmentId,
            });
        return row
            ? {
                  source: 'SPECIFIC' as const,
                  rule: row.rule,
                  version: row.version,
              }
            : { source: 'INHERITED' as const, rule: inherited, version };
    }
    async cycle(spaceId: string, id: string): Promise<AssignmentCycle | null> {
        const rows: AssignmentCycle[] = await this.provider
            .get()
            .query(
                `SELECT id,to_char(target_date,'YYYY-MM-DD') AS "targetDate",status,version FROM settlement_cycles WHERE space_id=$1 AND id=$2`,
                [spaceId, id],
            );
        return rows[0] ?? null;
    }
    async cycleForDate(
        spaceId: string,
        date: string,
    ): Promise<AssignmentCycle | null> {
        const rows: AssignmentCycle[] = await this.provider
            .get()
            .query(
                `SELECT id,to_char(target_date,'YYYY-MM-DD') AS "targetDate",status,version FROM settlement_cycles WHERE space_id=$1 AND target_date=$2`,
                [spaceId, date],
            );
        return rows[0] ?? null;
    }
    async createCycleForDate(
        spaceId: string,
        date: string,
    ): Promise<AssignmentCycle> {
        const rows: { id: string }[] = await this.transaction().query(
            `INSERT INTO settlement_cycles(id,space_id,target_date,status,version) VALUES ($1,$2,$3,'OPEN',1) ON CONFLICT (space_id,target_date) DO NOTHING RETURNING id`,
            [randomUUID(), spaceId, date],
        );
        if (!rows[0]) throw new FinancesError('CONCURRENT_MODIFICATION');
        return (await this.cycle(spaceId, rows[0].id))!;
    }
    async lockCycles(spaceId: string, ids: string[]) {
        const result: AssignmentCycle[] = [];
        for (const id of ids) {
            const rows: AssignmentCycle[] = await this.provider
                .get()
                .query(
                    `SELECT id,to_char(target_date,'YYYY-MM-DD') AS "targetDate",status,version FROM settlement_cycles WHERE space_id=$1 AND id=$2 FOR SHARE`,
                    [spaceId, id],
                );
            if (!rows[0]) throw new FinancesError('SETTLEMENT_CYCLE_NOT_FOUND');
            result.push(rows[0]);
        }
        return result;
    }
    async saveAssignment(
        before: InterMemberObligation,
        after: InterMemberObligation,
        actorId: string,
        now: string,
    ) {
        const m = this.transaction();
        const changed: { id: string }[] = await m.query(
            `WITH changed AS (UPDATE inter_member_obligations SET cycle_id=$1,version=$2 WHERE space_id=$3 AND id=$4 AND version=$5 RETURNING id) SELECT id FROM changed`,
            [
                after.cycleId,
                after.version,
                after.spaceId,
                after.id,
                before.version,
            ],
        );
        if (changed.length !== 1)
            throw new FinancesError('CONCURRENT_MODIFICATION');
        await m.insert(InterMemberObligationChangeOrmEntity, {
            obligationId: after.id,
            version: after.version,
            spaceId: after.spaceId,
            actorId,
            type: 'ASSIGNMENT_CHANGED',
            allocationId: null,
            snapshot: {
                previousCycleId: before.cycleId,
                cycleId: after.cycleId,
                previousVersion: before.version,
                version: after.version,
                remainingAmountInCents: after.remainingAmountInCents,
            },
            registeredAt: new Date(now),
        });
    }
    async options(
        spaceId: string,
        obligationId: string,
        after: { targetDate: string; id: string } | null,
    ) {
        return this.provider.readSnapshot(async () => {
            const rows: {
                id: string;
                version: number;
                remainingAmountInCents: string;
                cycleId: string | null;
            }[] = await this.provider
                .get()
                .query(
                    `SELECT id,version,remaining_amount_in_cents::text AS "remainingAmountInCents",cycle_id AS "cycleId" FROM inter_member_obligations WHERE space_id=$1 AND id=$2`,
                    [spaceId, obligationId],
                );
            if (!rows[0]) return null;
            const o = rows[0];
            const cycles: AssignmentCycle[] = await this.provider
                .get()
                .query(
                    `SELECT id,to_char(target_date,'YYYY-MM-DD') AS "targetDate",status,version FROM settlement_cycles WHERE space_id=$1 AND status='OPEN' AND ($2::date IS NULL OR (target_date,id)>($2::date,$3::uuid)) ORDER BY target_date,id LIMIT 21`,
                    [spaceId, after?.targetDate ?? null, after?.id ?? null],
                );
            return {
                obligation: {
                    ...o,
                    remainingAmountInCents: Number(o.remainingAmountInCents),
                },
                currentCycle: o.cycleId
                    ? await this.cycle(spaceId, o.cycleId)
                    : null,
                cycles,
            };
        });
    }
}
