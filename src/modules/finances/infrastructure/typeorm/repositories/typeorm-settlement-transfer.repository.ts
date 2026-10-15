import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type {
    OpenObligationView,
    PositionKey,
} from '../../../application/models/inter-member-position.js';
import type { SettlementTransferResult } from '../../../application/models/settlement-transfer.js';
import type { SettlementTransferRepository } from '../../../application/ports/private/settlement-transfer.repository.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
import { InterMemberObligation } from '../../../domain/shared-expense/inter-member-obligation.js';
import type { SettlementTransfer } from '../../../domain/settlement-transfer/settlement-transfer.js';

function amount(value: string): number {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0)
        throw new Error('Invalid persisted amount');
    return result;
}
function transaction(p: EntityManagerProvider) {
    const m = p.get();
    if (!m.queryRunner?.isTransactionActive)
        throw new Error('Settlement write requires a transaction');
    return m;
}
interface ObligationRow {
    id: string;
    space_id: string;
    commitment_id: string;
    disbursement_id: string | null;
    external_liability_id: string | null;
    receipt_id: string | null;
    debtor_member_id: string;
    creditor_member_id: string;
    original_amount_in_cents: string;
    recognized_amount_in_cents: string;
    remaining_amount_in_cents: string;
    cycle_id: string | null;
    fact_date: string;
    registered_at: Date;
    version: number;
    actor_id: string;
}
interface OptionRow {
    payable: string;
    receivable: string;
    id: string | null;
    version: number;
    status: 'OPEN' | 'PARTIALLY_SETTLED';
    debtor_member_id: string;
    creditor_member_id: string;
    original_amount_in_cents: string;
    recognized_amount_in_cents: string;
    remaining_amount_in_cents: string;
    fact_date: string;
    registered_at: string;
    commitment_id: string;
    disbursement_id: string | null;
    external_liability_id: string | null;
    receipt_id: string | null;
    description: string;
    cycle_id: string | null;
    target_date: string | null;
    cycle_status: 'OPEN' | 'FINALIZED' | null;
}
@Injectable()
export class TypeOrmSettlementTransferRepository implements SettlementTransferRepository {
    constructor(private readonly provider: EntityManagerProvider) {}
    async discover(spaceId: string, ids: string[]) {
        if (!ids.length) return [];
        const rows: {
            id: string;
            cycleId: string | null;
            commitmentId: string;
        }[] = await transaction(this.provider).query(
            `SELECT id, cycle_id AS "cycleId", commitment_id AS "commitmentId" FROM inter_member_obligations WHERE space_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`,
            [spaceId, ids],
        );
        return rows;
    }
    async lockOrigins(spaceId: string, ids: string[]): Promise<void> {
        for (const id of ids)
            await transaction(this.provider).query(
                `SELECT id FROM financial_commitments WHERE space_id=$1 AND id=$2 FOR UPDATE`,
                [spaceId, id],
            );
    }
    async lockCycles(spaceId: string, ids: string[]): Promise<void> {
        const m = transaction(this.provider);
        for (const id of ids) {
            const rows: { status: string }[] = await m.query(
                `SELECT status FROM settlement_cycles WHERE space_id=$1 AND id=$2 FOR SHARE`,
                [spaceId, id],
            );
            if (!rows.length)
                throw new FinancesError('CONCURRENT_MODIFICATION');
            if (rows[0].status !== 'OPEN')
                throw new FinancesError('SETTLEMENT_CYCLE_FINALIZED');
        }
    }
    async lockObligations(
        spaceId: string,
        ids: string[],
    ): Promise<InterMemberObligation[]> {
        const m = transaction(this.provider);
        const result: InterMemberObligation[] = [];
        for (const id of ids) {
            const rows: ObligationRow[] = await m.query(
                `SELECT o.*, to_char(o.fact_date,'YYYY-MM-DD') AS fact_date, ch.actor_id
                    FROM inter_member_obligations o JOIN inter_member_obligation_changes ch ON ch.space_id=o.space_id AND ch.obligation_id=o.id AND ch.version=1 WHERE o.space_id=$1 AND o.id=$2 FOR UPDATE OF o`,
                [spaceId, id],
            );
            if (!rows.length) continue;
            const o = rows[0];
            const changes: { allocation_id: string }[] = await m.query(
                `SELECT allocation_id FROM inter_member_obligation_changes WHERE space_id=$1 AND obligation_id=$2 AND allocation_id IS NOT NULL ORDER BY version`,
                [spaceId, id],
            );
            result.push(
                new InterMemberObligation(
                    o.id,
                    o.space_id,
                    o.commitment_id,
                    o.disbursement_id ??
                        o.receipt_id ??
                        o.external_liability_id!,
                    o.debtor_member_id,
                    o.creditor_member_id,
                    amount(o.original_amount_in_cents),
                    o.cycle_id,
                    o.fact_date,
                    o.registered_at.toISOString(),
                    o.actor_id,
                    amount(o.remaining_amount_in_cents),
                    o.version,
                    changes.map((change) => change.allocation_id),
                    o.receipt_id ? 'INCOME' : 'EXPENSE',
                    amount(o.recognized_amount_in_cents),
                    false,
                    null,
                    o.external_liability_id,
                ),
            );
        }
        return result;
    }
    async save(
        transfer: SettlementTransfer,
        before: InterMemberObligation[],
        after: InterMemberObligation[],
    ): Promise<void> {
        const m = transaction(this.provider);
        await m.query(
            `INSERT INTO settlement_transfers(id,space_id,payer_member_id,recipient_member_id,amount_in_cents,fact_date,registered_at,created_by,mode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'MANUAL')`,
            [
                transfer.id,
                transfer.spaceId,
                transfer.payerMemberId,
                transfer.recipientMemberId,
                String(transfer.amountInCents),
                transfer.factDate,
                transfer.registeredAt,
                transfer.createdByPersonId,
            ],
        );
        for (const allocation of transfer.allocations) {
            const old = before.find((o) => o.id === allocation.obligationId)!;
            const next = after.find((o) => o.id === allocation.obligationId)!;
            await m.query(
                `INSERT INTO settlement_allocations(id,space_id,transfer_id,obligation_id,cycle_id,amount_in_cents) VALUES ($1,$2,$3,$4,$5,$6)`,
                [
                    allocation.id,
                    transfer.spaceId,
                    transfer.id,
                    allocation.obligationId,
                    allocation.cycleId,
                    String(allocation.amountInCents),
                ],
            );
            const changed: { id: string }[] = await m.query(
                `WITH changed AS (UPDATE inter_member_obligations SET remaining_amount_in_cents=$1,status=$2,version=$3 WHERE space_id=$4 AND id=$5 AND version=$6 AND remaining_amount_in_cents=$7 RETURNING id) SELECT id FROM changed`,
                [
                    String(next.remainingAmountInCents),
                    next.status,
                    next.version,
                    transfer.spaceId,
                    old.id,
                    old.version,
                    String(old.remainingAmountInCents),
                ],
            );
            if (changed.length !== 1)
                throw new FinancesError('CONCURRENT_MODIFICATION');
            await m.query(
                `INSERT INTO inter_member_obligation_changes(obligation_id,version,space_id,actor_id,type,allocation_id,snapshot,registered_at) VALUES ($1,$2,$3,$4,'SETTLEMENT_APPLIED',$5,$6,$7)`,
                [
                    old.id,
                    next.version,
                    transfer.spaceId,
                    transfer.createdByPersonId,
                    allocation.id,
                    JSON.stringify({
                        beforeAmountInCents: old.remainingAmountInCents,
                        appliedAmountInCents: allocation.amountInCents,
                        remainingAmountInCents: next.remainingAmountInCents,
                        status: next.status,
                        transferId: transfer.id,
                        cycleId: allocation.cycleId,
                    }),
                    transfer.registeredAt,
                ],
            );
        }
        await m.query(
            `INSERT INTO financial_settlement_audit(id,space_id,transfer_id,actor_id,action,payload,registered_at) VALUES ($1,$2,$3,$4,'RECORD_MANUAL_SETTLEMENT_TRANSFER',$5,$6)`,
            [
                randomUUID(),
                transfer.spaceId,
                transfer.id,
                transfer.createdByPersonId,
                JSON.stringify({
                    payerMemberId: transfer.payerMemberId,
                    recipientMemberId: transfer.recipientMemberId,
                    amountInCents: transfer.amountInCents,
                    factDate: transfer.factDate,
                    allocations: transfer.allocations,
                }),
                transfer.registeredAt,
            ],
        );
    }
    async options(
        spaceId: string,
        actorMemberId: string,
        direction: 'PAYABLE' | 'RECEIVABLE',
        cycleId: string | null,
        after: PositionKey | null,
    ) {
        const rows: OptionRow[] = await this.provider.get().query(
            `
            WITH eligible AS MATERIALIZED (
                SELECT o.* FROM inter_member_obligations o LEFT JOIN settlement_cycles s ON s.space_id=o.space_id AND s.id=o.cycle_id
                WHERE o.space_id=$1 AND o.status IN ('OPEN','PARTIALLY_SETTLED') AND o.remaining_amount_in_cents>0
                    AND (o.cycle_id IS NULL OR s.status='OPEN') AND ($4::uuid IS NULL OR o.cycle_id=$4::uuid)
            ), totals AS (
                SELECT COALESCE(SUM(remaining_amount_in_cents) FILTER (WHERE debtor_member_id=$2),0)::text AS payable,
                    COALESCE(SUM(remaining_amount_in_cents) FILTER (WHERE creditor_member_id=$2),0)::text AS receivable FROM eligible
            ), page AS (
                SELECT * FROM eligible WHERE (($3='PAYABLE' AND debtor_member_id=$2) OR ($3='RECEIVABLE' AND creditor_member_id=$2))
                    AND ($5::timestamptz IS NULL OR (registered_at,id)<($5::timestamptz,$6::uuid))
                ORDER BY registered_at DESC,id DESC LIMIT 21
            )
            SELECT t.payable,t.receivable,p.id,p.version,p.status,p.debtor_member_id,p.creditor_member_id,
                p.original_amount_in_cents::text,p.recognized_amount_in_cents::text,p.remaining_amount_in_cents::text,
                to_char(p.fact_date,'YYYY-MM-DD') AS fact_date,
                to_char(p.registered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS registered_at,
                p.commitment_id,p.disbursement_id,p.external_liability_id,p.receipt_id,c.description,p.cycle_id,
                to_char(s.target_date,'YYYY-MM-DD') AS target_date,s.status AS cycle_status
            FROM totals t LEFT JOIN page p ON true
            LEFT JOIN financial_commitments c ON c.space_id=$1 AND c.id=p.commitment_id
            LEFT JOIN settlement_cycles s ON s.space_id=$1 AND s.id=p.cycle_id
            ORDER BY p.registered_at DESC,p.id DESC`,
            [
                spaceId,
                actorMemberId,
                direction,
                cycleId,
                after?.registeredAt ?? null,
                after?.id ?? null,
            ],
        );
        const items: OpenObligationView[] = rows
            .filter((r) => r.id !== null)
            .map((r) => ({
                id: r.id!,
                version: r.version,
                status: r.status,
                debtorMemberId: r.debtor_member_id,
                creditorMemberId: r.creditor_member_id,
                originalAmountInCents: amount(r.original_amount_in_cents),
                recognizedAmountInCents: amount(r.recognized_amount_in_cents),
                remainingAmountInCents: amount(r.remaining_amount_in_cents),
                factDate: r.fact_date,
                registeredAt: r.registered_at,
                origin: r.receipt_id
                    ? {
                          kind: 'INCOME',
                          commitmentId: r.commitment_id,
                          receiptId: r.receipt_id,
                          description: r.description,
                      }
                    : {
                          commitmentId: r.commitment_id,
                          ...(r.external_liability_id
                              ? {
                                    kind: 'EXPENSE' as const,
                                    externalLiabilityId:
                                        r.external_liability_id,
                                }
                              : { disbursementId: r.disbursement_id! }),
                          description: r.description,
                      },
                settlementCycle: r.cycle_id
                    ? {
                          id: r.cycle_id,
                          targetDate: r.target_date!,
                          status: r.cycle_status!,
                      }
                    : null,
            }));
        return {
            payable: rows[0].payable,
            receivable: rows[0].receivable,
            items,
        };
    }
    async detail(
        spaceId: string,
        id: string,
    ): Promise<Omit<SettlementTransferResult, 'replayed'> | null> {
        const rows: {
            id: string;
            payer_member_id: string;
            recipient_member_id: string;
            amount_in_cents: string;
            fact_date: string;
            registered_at: string;
            created_by: string;
            mode: 'MANUAL';
        }[] = await this.provider
            .get()
            .query(
                `SELECT id,payer_member_id,recipient_member_id,amount_in_cents::text,to_char(fact_date,'YYYY-MM-DD') AS fact_date,to_char(registered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS registered_at,created_by,mode FROM settlement_transfers WHERE space_id=$1 AND id=$2`,
                [spaceId, id],
            );
        if (!rows.length) return null;
        const r = rows[0];
        const allocations: {
            id: string;
            obligation_id: string;
            cycle_id: string | null;
            amount_in_cents: string;
            commitment_id: string;
            disbursement_id: string | null;
            external_liability_id: string | null;
            receipt_id: string | null;
            description: string;
        }[] = await this.provider
            .get()
            .query(
                `SELECT a.id,a.obligation_id,a.cycle_id,a.amount_in_cents::text,o.commitment_id,o.disbursement_id,o.external_liability_id,o.receipt_id,c.description FROM settlement_allocations a JOIN inter_member_obligations o ON o.space_id=a.space_id AND o.id=a.obligation_id JOIN financial_commitments c ON c.space_id=o.space_id AND c.id=o.commitment_id WHERE a.space_id=$1 AND a.transfer_id=$2 ORDER BY a.id`,
                [spaceId, id],
            );
        return {
            spaceId,
            transfer: {
                id: r.id,
                payerMemberId: r.payer_member_id,
                recipientMemberId: r.recipient_member_id,
                amountInCents: amount(r.amount_in_cents),
                factDate: r.fact_date,
                registeredAt: r.registered_at,
                createdByPersonId: r.created_by,
                mode: r.mode,
            },
            allocations: allocations.map((a) => ({
                id: a.id,
                obligationId: a.obligation_id,
                cycleId: a.cycle_id,
                amountInCents: amount(a.amount_in_cents),
                origin: a.receipt_id
                    ? {
                          kind: 'INCOME',
                          commitmentId: a.commitment_id,
                          receiptId: a.receipt_id,
                          description: a.description,
                      }
                    : {
                          commitmentId: a.commitment_id,
                          ...(a.external_liability_id
                              ? {
                                    kind: 'EXPENSE' as const,
                                    externalLiabilityId:
                                        a.external_liability_id,
                                }
                              : { disbursementId: a.disbursement_id! }),
                          description: a.description,
                      },
            })),
            affectedCycleIds: [
                ...new Set(
                    allocations
                        .map((a) => a.cycle_id)
                        .filter((v): v is string => v !== null),
                ),
            ].sort(),
        };
    }
    async history(
        spaceId: string,
        cycleId: string | null,
        obligationId: string | null,
        after: PositionKey | null,
    ) {
        const rows: { id: string; applied: string }[] = await this.provider
            .get()
            .query(
                `
            SELECT t.id,COALESCE(SUM(a.amount_in_cents) FILTER (WHERE ($2::uuid IS NULL OR a.cycle_id=$2::uuid) AND ($3::uuid IS NULL OR a.obligation_id=$3::uuid)),0)::text AS applied
            FROM settlement_transfers t JOIN settlement_allocations a ON a.space_id=t.space_id AND a.transfer_id=t.id
            WHERE t.space_id=$1 AND ($4::timestamptz IS NULL OR (t.registered_at,t.id)<($4::timestamptz,$5::uuid))
            GROUP BY t.id,t.registered_at
            HAVING ($2::uuid IS NULL AND $3::uuid IS NULL) OR SUM(a.amount_in_cents) FILTER (WHERE ($2::uuid IS NULL OR a.cycle_id=$2::uuid) AND ($3::uuid IS NULL OR a.obligation_id=$3::uuid)) IS NOT NULL
            ORDER BY t.registered_at DESC,t.id DESC LIMIT 21`,
                [
                    spaceId,
                    cycleId,
                    obligationId,
                    after?.registeredAt ?? null,
                    after?.id ?? null,
                ],
            );
        const items = await Promise.all(
            rows.map(async (r) => ({
                ...(await this.detail(spaceId, r.id))!,
                appliedAmountInCentsInFilter: amount(r.applied),
            })),
        );
        return { items };
    }
    async hasCycle(spaceId: string, id: string) {
        const rows: { id: string }[] = await this.provider
            .get()
            .query(
                `SELECT id FROM settlement_cycles WHERE space_id=$1 AND id=$2`,
                [spaceId, id],
            );
        return rows.length > 0;
    }
    async hasObligation(spaceId: string, id: string) {
        const rows: { id: string }[] = await this.provider
            .get()
            .query(
                `SELECT id FROM inter_member_obligations WHERE space_id=$1 AND id=$2`,
                [spaceId, id],
            );
        return rows.length > 0;
    }
}
