import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import { ClosureResolutionAudit } from './closure-resolution-audit.js';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import type { SettlementOffset } from '../../../domain/settlement-offset/settlement-offset.js';
import type { InterMemberObligation } from '../../../domain/shared-expense/inter-member-obligation.js';
import type {
    PositionDirection,
    PositionKey,
} from '../../../application/models/inter-member-position.js';
import type { AssignmentCycle } from '../../../application/models/settlement-adjustment.js';
import type {
    RecordSettlementOffsetCommand,
    SettlementOffsetOptionsRead,
    SettlementOffsetResult,
    SettlementOffsetScope,
} from '../../../application/models/settlement-offset.js';
import {
    SettlementOffsetReceiptRaceError,
    type SettlementOffsetRepository,
} from '../../../application/ports/private/settlement-offset.repository.js';
import {
    SettlementOffsetOrmEntity,
    SettlementOffsetAllocationOrmEntity,
    SettlementOffsetCommandReceiptOrmEntity,
    SettlementOffsetAuditOrmEntity,
} from '../entities/settlement-offset.orm-entity.js';
import {
    InterMemberObligationChangeOrmEntity,
    InterMemberObligationOrmEntity,
} from '../entities/shared-expense.orm-entity.js';
function hash(c: RecordSettlementOffsetCommand) {
    return createHash('sha256')
        .update(
            JSON.stringify({
                spaceId: c.spaceId.value,
                expectedSpaceVersion: c.expectedSpaceVersion,
                factDate: c.factDate,
                scope: {
                    cycleIds: [...c.scope.cycleIds].sort(),
                    obligationIds: [...c.scope.obligationIds].sort(),
                },
                expectedCycleVersions: [...c.expectedCycleVersions].sort(
                    (a, b) => a.cycleId.localeCompare(b.cycleId),
                ),
                allocations: [...c.allocations].sort((a, b) =>
                    a.obligationId.localeCompare(b.obligationId),
                ),
            }),
        )
        .digest();
}
const predicate = `(o.cycle_id=ANY($3::uuid[]) OR o.id=ANY($4::uuid[]))`;
const origin = `jsonb_strip_nulls(jsonb_build_object('kind',CASE WHEN o.closure_agreement_id IS NOT NULL THEN 'CLOSURE_AGREEMENT' WHEN o.receipt_id IS NULL THEN 'EXPENSE' ELSE 'INCOME' END,'commitmentId',o.commitment_id,'disbursementId',o.disbursement_id,'receiptId',o.receipt_id,'closureAgreementId',o.closure_agreement_id,'externalLiabilityId',o.external_liability_id,'description',c.description))`;
const obligation = `jsonb_build_object('id',o.id,'version',o.version,'status',o.status,'debtorMemberId',o.debtor_member_id,'creditorMemberId',o.creditor_member_id,'originalAmountInCents',o.original_amount_in_cents,'recognizedAmountInCents',o.recognized_amount_in_cents,'remainingAmountInCents',o.remaining_amount_in_cents,'factDate',to_char(o.fact_date,'YYYY-MM-DD'),'registeredAt',to_char(o.registered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'origin',${origin},'settlementCycle',CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object('id',s.id,'targetDate',to_char(s.target_date,'YYYY-MM-DD'),'status',s.status) END)`;
@Injectable()
export class TypeOrmSettlementOffsetRepository implements SettlementOffsetRepository {
    constructor(
        private readonly provider: EntityManagerProvider,
        private readonly closureAudit: ClosureResolutionAudit,
    ) {}
    private transaction() {
        const m = this.provider.get();
        if (!m.queryRunner?.isTransactionActive)
            throw new Error('Settlement offset requires a transaction');
        return m;
    }
    async validateScope(spaceId: string, scope: SettlementOffsetScope) {
        const cycles: AssignmentCycle[] = await this.provider
            .get()
            .query(
                `SELECT id,version,status,to_char(target_date,'YYYY-MM-DD') AS "targetDate" FROM settlement_cycles WHERE space_id=$1 AND (id=ANY($2::uuid[]) OR id IN (SELECT cycle_id FROM inter_member_obligations WHERE space_id=$1 AND id=ANY($3::uuid[]))) ORDER BY id`,
                [spaceId, scope.cycleIds, scope.obligationIds],
            );
        if (scope.cycleIds.some((id) => !cycles.some((c) => c.id === id)))
            throw new FinancesError('SETTLEMENT_CYCLE_NOT_FOUND');
        if (cycles.length > 50)
            throw new FinancesError('VALIDATION_ERROR', ['scope']);
        const ids: { id: string }[] = await this.provider
            .get()
            .query(
                `SELECT id FROM inter_member_obligations WHERE space_id=$1 AND id=ANY($2::uuid[])`,
                [spaceId, scope.obligationIds],
            );
        if (ids.length !== scope.obligationIds.length)
            throw new FinancesError('INTER_MEMBER_OBLIGATION_NOT_FOUND');
        return cycles;
    }
    async options(
        spaceId: string,
        actorMemberId: string,
        scope: SettlementOffsetScope,
        direction: PositionDirection,
        after: PositionKey | null,
    ): Promise<SettlementOffsetOptionsRead> {
        return this.provider.readSnapshot(async () => {
            const cycles = await this.validateScope(spaceId, scope);
            const rows: {
                payable: string;
                receivable: string;
                items: SettlementOffsetOptionsRead['items'];
                preview: SettlementOffsetOptionsRead['previewCandidates'];
            }[] = await this.provider.get().query(
                `
                WITH eligible AS MATERIALIZED (
                    SELECT o.* FROM inter_member_obligations o LEFT JOIN settlement_cycles s ON s.space_id=o.space_id AND s.id=o.cycle_id
                    WHERE o.space_id=$1 AND ${predicate} AND o.remaining_amount_in_cents>0 AND (s.id IS NULL OR s.status='OPEN')
                ), totals AS (SELECT COALESCE(SUM(remaining_amount_in_cents) FILTER (WHERE debtor_member_id=$2),0)::text AS payable,COALESCE(SUM(remaining_amount_in_cents) FILTER (WHERE creditor_member_id=$2),0)::text AS receivable FROM eligible),
                page AS MATERIALIZED (SELECT * FROM eligible WHERE ($5='ALL' OR ($5='PAYABLE' AND debtor_member_id=$2) OR ($5='RECEIVABLE' AND creditor_member_id=$2))
                    AND ($6::timestamptz IS NULL OR (registered_at,id)<($6::timestamptz,$7::uuid)) ORDER BY registered_at DESC,id DESC LIMIT 21),
                ranked AS (SELECT o.*,ROW_NUMBER() OVER (PARTITION BY debtor_member_id ORDER BY s.target_date ASC NULLS LAST,o.registered_at,o.id) AS rank FROM eligible o LEFT JOIN settlement_cycles s ON s.space_id=$1 AND s.id=o.cycle_id),
                candidates AS MATERIALIZED (SELECT * FROM ranked WHERE rank<=20)
                SELECT totals.*,
                    COALESCE((SELECT jsonb_agg(${obligation} ORDER BY o.registered_at DESC,o.id DESC) FROM page o JOIN financial_commitments c ON c.space_id=$1 AND c.id=o.commitment_id LEFT JOIN settlement_cycles s ON s.space_id=$1 AND s.id=o.cycle_id),'[]'::jsonb) AS items,
                    COALESCE((SELECT jsonb_agg(${obligation} ORDER BY s.target_date ASC NULLS LAST,o.registered_at,o.id) FROM candidates o JOIN financial_commitments c ON c.space_id=$1 AND c.id=o.commitment_id LEFT JOIN settlement_cycles s ON s.space_id=$1 AND s.id=o.cycle_id),'[]'::jsonb) AS preview
                FROM totals`,
                [
                    spaceId,
                    actorMemberId,
                    scope.cycleIds,
                    scope.obligationIds,
                    direction,
                    after?.registeredAt ?? null,
                    after?.id ?? null,
                ],
            );
            return {
                cycles,
                payable: rows[0].payable,
                receivable: rows[0].receivable,
                items: rows[0].items,
                previewCandidates: rows[0].preview,
            };
        });
    }
    async findReceipt(c: RecordSettlementOffsetCommand) {
        const row = await this.provider
            .get()
            .findOneBy(SettlementOffsetCommandReceiptOrmEntity, {
                actorId: c.actorId.value,
                idempotencyKey: c.idempotencyKey,
            });
        if (!row) return null;
        if (!row.requestHash.equals(hash(c)))
            throw new FinancesError('IDEMPOTENCY_KEY_REUSED');
        return row.result as SettlementOffsetResult;
    }
    async saveReceipt(
        c: RecordSettlementOffsetCommand,
        result: SettlementOffsetResult,
    ) {
        try {
            await this.transaction().insert(
                SettlementOffsetCommandReceiptOrmEntity,
                {
                    actorId: c.actorId.value,
                    idempotencyKey: c.idempotencyKey,
                    spaceId: c.spaceId.value,
                    offsetId: result.offset.id,
                    requestHash: hash(c),
                    result,
                    registeredAt: new Date(result.offset.registeredAt),
                },
            );
        } catch (error) {
            if (
                error instanceof QueryFailedError &&
                (error.driverError as { code?: string }).code === '23505'
            )
                throw new SettlementOffsetReceiptRaceError();
            throw error;
        }
        const closureAudit = await this.closureAudit.context(
            c.actorId.value,
            c.spaceId.value,
        );
        await this.transaction().insert(SettlementOffsetAuditOrmEntity, {
            id: randomUUID(),
            actorId: c.actorId.value,
            idempotencyKey: c.idempotencyKey,
            spaceId: c.spaceId.value,
            offsetId: result.offset.id,
            action: 'RECORD_SETTLEMENT_OFFSET',
            payload: {
                amountInCents: result.offset.amountInCents,
                allocationCount: result.allocations.length,
                affectedCycleIds: result.affectedCycleIds,
                ...closureAudit,
                ...(closureAudit.closure
                    ? {
                          obligationIds: result.allocations.map(
                              (allocation) => allocation.obligationId,
                          ),
                      }
                    : {}),
            },
            registeredAt: new Date(result.offset.registeredAt),
        });
    }
    async save(
        offset: SettlementOffset,
        before: InterMemberObligation[],
        after: InterMemberObligation[],
    ) {
        const m = this.transaction();
        await m.insert(SettlementOffsetOrmEntity, {
            id: offset.id,
            spaceId: offset.spaceId,
            amountInCents: offset.amountInCents,
            factDate: offset.factDate,
            registeredAt: new Date(offset.registeredAt),
            createdByPersonId: offset.createdByPersonId,
        });
        for (const allocation of offset.allocations) {
            await m.insert(SettlementOffsetAllocationOrmEntity, {
                ...allocation,
                spaceId: offset.spaceId,
                offsetId: offset.id,
            });
            const old = before.find((o) => o.id === allocation.obligationId)!,
                next = after.find((o) => o.id === allocation.obligationId)!;
            const update = await m.update(
                InterMemberObligationOrmEntity,
                { spaceId: offset.spaceId, id: old.id, version: old.version },
                {
                    remainingAmountInCents: next.remainingAmountInCents,
                    status: next.status,
                    version: next.version,
                },
            );
            if (update.affected !== 1)
                throw new FinancesError('CONCURRENT_MODIFICATION');
            await m.insert(InterMemberObligationChangeOrmEntity, {
                obligationId: next.id,
                spaceId: offset.spaceId,
                version: next.version,
                type: 'OFFSET_APPLIED',
                actorId: offset.createdByPersonId,
                allocationId: null,
                snapshot: {
                    offsetId: offset.id,
                    offsetAllocationId: allocation.id,
                    cycleId: allocation.cycleId,
                    beforeAmountInCents: old.remainingAmountInCents,
                    appliedAmountInCents: allocation.amountInCents,
                    remainingAmountInCents: next.remainingAmountInCents,
                    status: next.status,
                },
                registeredAt: new Date(offset.registeredAt),
            });
        }
    }
    private async details(spaceId: string, ids: string[]) {
        if (!ids.length) return [];
        const rows: { result: SettlementOffsetResult }[] = await this.provider
            .get()
            .query(
                `SELECT jsonb_build_object('spaceId',t.space_id,'offset',jsonb_build_object('id',t.id,'amountInCents',t.amount_in_cents,'reversedAmountInCents',COALESCE(r.amount_in_cents,0),'effectiveAmountInCents',t.amount_in_cents-COALESCE(r.amount_in_cents,0),'reversalId',r.id,'factDate',to_char(t.fact_date,'YYYY-MM-DD'),'registeredAt',to_char(t.registered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'createdByPersonId',t.created_by),
            'allocations',(SELECT jsonb_agg(jsonb_build_object('id',a.id,'obligationId',a.obligation_id,'cycleId',a.cycle_id,'debtorMemberId',a.debtor_member_id,'creditorMemberId',a.creditor_member_id,'amountInCents',a.amount_in_cents,'reversedAmountInCents',COALESCE(ra.amount_in_cents,0),'effectiveAmountInCents',a.amount_in_cents-COALESCE(ra.amount_in_cents,0),'origin',${origin}) ORDER BY a.id) FROM settlement_offset_allocations a JOIN inter_member_obligations o ON o.space_id=a.space_id AND o.id=a.obligation_id JOIN financial_commitments c ON c.space_id=o.space_id AND c.id=o.commitment_id LEFT JOIN settlement_reversal_applications ra ON ra.space_id=a.space_id AND ra.original_offset_allocation_id=a.id WHERE a.space_id=$1 AND a.offset_id=t.id),
            'affectedCycleIds',COALESCE((SELECT jsonb_agg(x.cycle_id ORDER BY x.cycle_id) FROM (SELECT DISTINCT cycle_id FROM settlement_offset_allocations WHERE space_id=$1 AND offset_id=t.id AND cycle_id IS NOT NULL) x),'[]'::jsonb),'replayed',false) AS result FROM settlement_offsets t LEFT JOIN settlement_reversals r ON r.space_id=t.space_id AND r.original_offset_id=t.id WHERE t.space_id=$1 AND t.id=ANY($2::uuid[])`,
                [spaceId, ids],
            );
        return rows.map((r) => r.result);
    }
    async detail(spaceId: string, id: string) {
        return this.provider.readSnapshot(
            async () => (await this.details(spaceId, [id]))[0] ?? null,
        );
    }
    async history(
        spaceId: string,
        cycleId: string | null,
        obligationId: string | null,
        after: PositionKey | null,
    ) {
        return this.provider.readSnapshot(async () => {
            const rows: { id: string; applied: string }[] = await this.provider
                .get()
                .query(
                    `SELECT t.id,SUM(a.amount_in_cents) FILTER (WHERE ($2::uuid IS NULL OR a.cycle_id=$2) AND ($3::uuid IS NULL OR a.obligation_id=$3))::text AS applied FROM settlement_offsets t JOIN settlement_offset_allocations a ON a.space_id=t.space_id AND a.offset_id=t.id WHERE t.space_id=$1 AND ($4::timestamptz IS NULL OR (t.registered_at,t.id)<($4::timestamptz,$5::uuid)) GROUP BY t.id,t.registered_at HAVING SUM(a.amount_in_cents) FILTER (WHERE ($2::uuid IS NULL OR a.cycle_id=$2) AND ($3::uuid IS NULL OR a.obligation_id=$3)) IS NOT NULL ORDER BY t.registered_at DESC,t.id DESC LIMIT 21`,
                    [
                        spaceId,
                        cycleId,
                        obligationId,
                        after?.registeredAt ?? null,
                        after?.id ?? null,
                    ],
                );
            const details = await this.details(
                spaceId,
                rows.map((r) => r.id),
            );
            return rows.map((row) => ({
                ...details.find((d) => d.offset.id === row.id)!,
                appliedAmountInCentsInFilter: row.applied,
            }));
        });
    }
}
