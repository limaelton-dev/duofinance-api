import { Injectable } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { FinanceTodayUnavailableError } from '../../../application/ports/public/finance-today-query.port.js';
import { settlementCycleTotals } from '../../../application/queries/settlement-cycle.calculations.js';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type {
    PositionDirection,
    PositionKey,
} from '../../../application/models/inter-member-position.js';
import type {
    SettlementCycleKey,
    SettlementCycleView,
    SettlementObligationView,
    SelectedSettlementObligation,
    SelectedSettlementTotals,
} from '../../../application/models/settlement-cycle.js';
import type {
    SettlementCycleRead,
    SettlementCycleReader,
} from '../../../application/ports/private/settlement-cycle-reader.js';
import { FinancesError } from '../../../domain/errors/finances.error.js';
interface CycleRow {
    id: string;
    version: number;
    target_date: string;
    status: 'OPEN' | 'FINALIZED';
    finalized_at: string | null;
    original: string;
    recognized: string;
    remaining: string;
    transferred: string;
    compensated: string;
    waived: string;
    payable: string;
    receivable: string;
    obligation_count: number;
    open_obligation_count: number;
}
interface DetailRow extends CycleRow {
    obligation_id: string | null;
    obligation_version: number;
    obligation_status:
        'OPEN' | 'PARTIALLY_SETTLED' | 'SETTLED' | 'RECONCILED' | 'WAIVED';
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
    compensated_amount_in_cents: string;
    waived_amount_in_cents: string;
}
function cycle(row: CycleRow): SettlementCycleRead {
    return {
        id: row.id,
        version: row.version,
        targetDate: row.target_date,
        status: row.status,
        finalizedAt: row.finalized_at,
        obligationCount: row.obligation_count,
        openObligationCount: row.open_obligation_count,
        totals: settlementCycleTotals(
            row.original,
            row.remaining,
            row.transferred,
            row.recognized,
            row.compensated,
            row.waived,
        ),
        payableAmountInCents: row.payable,
        receivableAmountInCents: row.receivable,
    };
}
function amount(value: string): number {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0)
        throw new Error('Invalid persisted obligation amount');
    return result;
}
const aggregate = `COALESCE(SUM(o.original_amount_in_cents),0)::text AS original,
    COALESCE(SUM(o.recognized_amount_in_cents),0)::text AS recognized,
    COALESCE(SUM(o.remaining_amount_in_cents),0)::text AS remaining,
    COALESCE(SUM(o.remaining_amount_in_cents) FILTER (WHERE o.debtor_member_id=$2),0)::text AS payable,
    COALESCE(SUM(o.remaining_amount_in_cents) FILTER (WHERE o.creditor_member_id=$2),0)::text AS receivable,
    COUNT(o.id)::integer AS obligation_count,
    COUNT(o.id) FILTER (WHERE o.remaining_amount_in_cents>0)::integer AS open_obligation_count`;
const cycleColumns = `s.id, s.version, to_char(s.target_date,'YYYY-MM-DD') AS target_date, s.status,
    to_char(s.finalized_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS finalized_at`;
@Injectable()
export class TypeOrmSettlementCycleReader implements SettlementCycleReader {
    constructor(private readonly managers: EntityManagerProvider) {}
    async today(spaceId: string, actorMemberId: string, referenceDate: string) {
        let rows: (CycleRow & { overdue_count: number })[];
        try {
            rows = await this.managers.get().query(
                `WITH overdue AS MATERIALIZED (
                    SELECT s.id,s.target_date FROM settlement_cycles s
                    WHERE s.space_id=$1 AND s.status='OPEN' AND s.target_date<$3::date
                    AND EXISTS (SELECT 1 FROM inter_member_obligations o WHERE o.space_id=$1 AND o.cycle_id=s.id AND o.remaining_amount_in_cents>0)
                ), selected AS MATERIALIZED (
                    (SELECT * FROM settlement_cycles WHERE space_id=$1 AND status='OPEN' AND target_date>=$3::date ORDER BY target_date,id LIMIT 1)
                    UNION ALL
                    (SELECT s.* FROM settlement_cycles s JOIN overdue d ON d.id=s.id WHERE s.space_id=$1 ORDER BY s.target_date,s.id LIMIT 3)
                ), summaries AS (
                    SELECT ${cycleColumns},${aggregate},
                        COALESCE((SELECT SUM(a.amount_in_cents) FROM settlement_allocations a WHERE a.space_id=$1 AND a.cycle_id=s.id),0)::text AS transferred, COALESCE((SELECT SUM((ch.snapshot->>'appliedAmountInCents')::bigint) FROM inter_member_obligation_changes ch WHERE ch.space_id=$1 AND ch.type='OFFSET_APPLIED' AND ch.snapshot->>'cycleId'=s.id::text),0)::text AS compensated, COALESCE((SELECT SUM((ch.snapshot->>'appliedAmountInCents')::bigint) FROM inter_member_obligation_changes ch WHERE ch.space_id=$1 AND ch.type='WAIVED' AND ch.snapshot->>'cycleId'=s.id::text),0)::text AS waived
                    FROM selected s LEFT JOIN inter_member_obligations o ON o.space_id=$1 AND o.cycle_id=s.id
                    GROUP BY s.id,s.version,s.target_date,s.status,s.finalized_at
                )
                SELECT c.*,(SELECT COUNT(*)::integer FROM overdue) AS overdue_count
                FROM (SELECT 1) seed LEFT JOIN summaries c ON true ORDER BY c.target_date,c.id`,
                [spaceId, actorMemberId, referenceDate],
            );
        } catch (error) {
            const cause =
                error instanceof QueryFailedError ? error.driverError : error;
            const code =
                typeof cause === 'object' && cause !== null && 'code' in cause
                    ? cause.code
                    : null;
            if (
                typeof code === 'string' &&
                (code.startsWith('08') ||
                    [
                        '53000',
                        '53100',
                        '53200',
                        '53300',
                        '53400',
                        '57014',
                        '57P01',
                        '57P02',
                        '57P03',
                        'ECONNREFUSED',
                        'ECONNRESET',
                        'ETIMEDOUT',
                        'EPIPE',
                    ].includes(code))
            )
                throw new FinanceTodayUnavailableError();
            throw error;
        }
        const cycles = rows.filter((row) => row.id !== null).map(cycle);
        return {
            nextCycle:
                cycles.find((row) => row.targetDate >= referenceDate) ?? null,
            overdueCycles: {
                items: cycles.filter((row) => row.targetDate < referenceDate),
                totalCount: rows[0].overdue_count,
            },
        };
    }
    async list(
        spaceId: string,
        actorMemberId: string,
        view: SettlementCycleView,
        referenceDate: string,
        after: SettlementCycleKey | null,
    ): Promise<SettlementCycleRead[]> {
        const rows: CycleRow[] = await this.managers.get().query(
            `
            WITH page AS MATERIALIZED (
                SELECT * FROM settlement_cycles WHERE space_id=$1 AND status=CASE WHEN $3='FINALIZED' THEN 'FINALIZED' ELSE 'OPEN' END
                AND ($3 IN ('OPEN','FINALIZED') OR ($3='UPCOMING' AND target_date >= $4::date) OR ($3='OVERDUE' AND target_date < $4::date AND EXISTS (SELECT 1 FROM inter_member_obligations overdue WHERE overdue.space_id=$1 AND overdue.cycle_id=settlement_cycles.id AND overdue.remaining_amount_in_cents>0)))
                AND ($5::date IS NULL OR (target_date,id)>($5::date,$6::uuid))
                ORDER BY target_date ASC,id ASC LIMIT 21
            )
            SELECT ${cycleColumns}, ${aggregate},
                COALESCE((SELECT SUM(a.amount_in_cents) FROM settlement_allocations a WHERE a.space_id=$1 AND a.cycle_id=s.id),0)::text AS transferred, COALESCE((SELECT SUM((ch.snapshot->>'appliedAmountInCents')::bigint) FROM inter_member_obligation_changes ch WHERE ch.space_id=$1 AND ch.type='OFFSET_APPLIED' AND ch.snapshot->>'cycleId'=s.id::text),0)::text AS compensated, COALESCE((SELECT SUM((ch.snapshot->>'appliedAmountInCents')::bigint) FROM inter_member_obligation_changes ch WHERE ch.space_id=$1 AND ch.type='WAIVED' AND ch.snapshot->>'cycleId'=s.id::text),0)::text AS waived
            FROM page s LEFT JOIN inter_member_obligations o ON o.space_id=$1 AND o.cycle_id=s.id
            GROUP BY s.id,s.version,s.target_date,s.status,s.finalized_at
            ORDER BY s.target_date ASC,s.id ASC
        `,
            [
                spaceId,
                actorMemberId,
                view,
                referenceDate,
                after?.targetDate ?? null,
                after?.id ?? null,
            ],
        );
        return rows.map(cycle);
    }
    async detail(
        spaceId: string,
        actorMemberId: string,
        cycleId: string,
        direction: PositionDirection,
        after: PositionKey | null,
    ) {
        const rows: DetailRow[] = await this.managers.get().query(
            `
            WITH selected_cycle AS MATERIALIZED (
                SELECT * FROM settlement_cycles WHERE space_id=$1 AND id=$3
            ), obligations AS MATERIALIZED (
                SELECT o.* FROM inter_member_obligations o JOIN selected_cycle s ON s.id=o.cycle_id
                WHERE o.space_id=$1
            ), totals AS (
                SELECT ${aggregate} FROM obligations o
            ), page AS (
                SELECT * FROM obligations
                WHERE ($4='ALL' OR ($4='PAYABLE' AND debtor_member_id=$2) OR ($4='RECEIVABLE' AND creditor_member_id=$2))
                AND ($5::timestamptz IS NULL OR (registered_at,id)<($5::timestamptz,$6::uuid))
                ORDER BY registered_at DESC,id DESC LIMIT 21
            )
            SELECT ${cycleColumns},t.*,
                COALESCE((SELECT SUM(a.amount_in_cents) FROM settlement_allocations a WHERE a.space_id=$1 AND a.cycle_id=s.id),0)::text AS transferred, COALESCE((SELECT SUM((ch.snapshot->>'appliedAmountInCents')::bigint) FROM inter_member_obligation_changes ch WHERE ch.space_id=$1 AND ch.type='OFFSET_APPLIED' AND ch.snapshot->>'cycleId'=s.id::text),0)::text AS compensated, COALESCE((SELECT SUM((ch.snapshot->>'appliedAmountInCents')::bigint) FROM inter_member_obligation_changes ch WHERE ch.space_id=$1 AND ch.type='WAIVED' AND ch.snapshot->>'cycleId'=s.id::text),0)::text AS waived,
                p.id AS obligation_id,p.version AS obligation_version,p.status AS obligation_status,
                p.debtor_member_id,p.creditor_member_id,p.original_amount_in_cents::text,p.recognized_amount_in_cents::text,p.remaining_amount_in_cents::text,
                to_char(p.fact_date,'YYYY-MM-DD') AS fact_date,
                to_char(p.registered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS registered_at,
                p.commitment_id,p.disbursement_id,p.external_liability_id,p.receipt_id,c.description
                ,COALESCE((SELECT SUM((ch.snapshot->>'appliedAmountInCents')::bigint) FROM inter_member_obligation_changes ch WHERE ch.space_id=$1 AND ch.obligation_id=p.id AND ch.type='OFFSET_APPLIED'),0)::text AS compensated_amount_in_cents
                ,COALESCE((SELECT SUM((ch.snapshot->>'appliedAmountInCents')::bigint) FROM inter_member_obligation_changes ch WHERE ch.space_id=$1 AND ch.obligation_id=p.id AND ch.type='WAIVED'),0)::text AS waived_amount_in_cents
            FROM selected_cycle s CROSS JOIN totals t LEFT JOIN page p ON true
            LEFT JOIN financial_commitments c ON c.space_id=$1 AND c.id=p.commitment_id
            ORDER BY p.registered_at DESC,p.id DESC
        `,
            [
                spaceId,
                actorMemberId,
                cycleId,
                direction,
                after?.registeredAt ?? null,
                after?.id ?? null,
            ],
        );
        if (!rows.length) return null;
        const items: SettlementObligationView[] = rows
            .filter((row) => row.obligation_id !== null)
            .map((row) => ({
                id: row.obligation_id!,
                version: row.obligation_version,
                status: row.obligation_status,
                debtorMemberId: row.debtor_member_id,
                creditorMemberId: row.creditor_member_id,
                originalAmountInCents: amount(row.original_amount_in_cents),
                recognizedAmountInCents: amount(row.recognized_amount_in_cents),
                resolvedAmountInCents: amount(
                    (
                        BigInt(row.recognized_amount_in_cents) -
                        BigInt(row.remaining_amount_in_cents)
                    ).toString(),
                ),
                remainingAmountInCents: amount(row.remaining_amount_in_cents),
                compensatedAmountInCents: amount(
                    row.compensated_amount_in_cents,
                ),
                waivedAmountInCents: amount(row.waived_amount_in_cents),
                factDate: row.fact_date,
                registeredAt: row.registered_at,
                origin: row.receipt_id
                    ? {
                          kind: 'INCOME',
                          commitmentId: row.commitment_id,
                          receiptId: row.receipt_id,
                          description: row.description,
                      }
                    : {
                          commitmentId: row.commitment_id,
                          ...(row.external_liability_id
                              ? {
                                    kind: 'EXPENSE' as const,
                                    externalLiabilityId:
                                        row.external_liability_id,
                                }
                              : { disbursementId: row.disbursement_id! }),
                          description: row.description,
                      },
            }));
        return { cycle: cycle(rows[0]), items };
    }
    async summary(
        spaceId: string,
        actorMemberId: string,
        cycleIds: string[],
        direction: PositionDirection,
        after: PositionKey | null,
    ) {
        return this.managers.readSnapshot(async () => {
            const selected: CycleRow[] = await this.managers.get().query(
                `
                WITH selected_cycles AS MATERIALIZED (SELECT * FROM settlement_cycles WHERE space_id=$1 AND id=ANY($3::uuid[]))
                SELECT ${cycleColumns},${aggregate},
                    COALESCE((SELECT SUM(a.amount_in_cents) FROM settlement_allocations a WHERE a.space_id=$1 AND a.cycle_id=s.id),0)::text AS transferred, COALESCE((SELECT SUM((ch.snapshot->>'appliedAmountInCents')::bigint) FROM inter_member_obligation_changes ch WHERE ch.space_id=$1 AND ch.type='OFFSET_APPLIED' AND ch.snapshot->>'cycleId'=s.id::text),0)::text AS compensated, COALESCE((SELECT SUM((ch.snapshot->>'appliedAmountInCents')::bigint) FROM inter_member_obligation_changes ch WHERE ch.space_id=$1 AND ch.type='WAIVED' AND ch.snapshot->>'cycleId'=s.id::text),0)::text AS waived
                FROM selected_cycles s LEFT JOIN inter_member_obligations o ON o.space_id=$1 AND o.cycle_id=s.id
                GROUP BY s.id,s.version,s.target_date,s.status,s.finalized_at ORDER BY s.target_date,s.id`,
                [spaceId, actorMemberId, cycleIds],
            );
            if (selected.length !== cycleIds.length)
                throw new FinancesError('SETTLEMENT_CYCLE_NOT_FOUND');
            const totals: {
                original: string;
                recognized: string;
                remaining: string;
                transferred: string;
                compensated: string;
                waived: string;
                transfer_total: string;
                transfer_count: number;
                gross_payable: string;
                gross_receivable: string;
                payable: string;
                receivable: string;
            }[] = await this.managers.get().query(
                `
                WITH selected_obligations AS MATERIALIZED (SELECT * FROM inter_member_obligations WHERE space_id=$1 AND cycle_id=ANY($3::uuid[])),
                selected_allocations AS MATERIALIZED (SELECT a.* FROM settlement_allocations a WHERE a.space_id=$1 AND a.cycle_id=ANY($3::uuid[])),
                transfers AS (SELECT t.amount_in_cents FROM settlement_transfers t WHERE t.space_id=$1 AND EXISTS (SELECT 1 FROM selected_allocations a WHERE a.transfer_id=t.id)),
                obligations AS (SELECT ${aggregate},
                    COALESCE(SUM(o.recognized_amount_in_cents) FILTER (WHERE o.debtor_member_id=$2),0)::text AS gross_payable,
                    COALESCE(SUM(o.recognized_amount_in_cents) FILTER (WHERE o.creditor_member_id=$2),0)::text AS gross_receivable
                    FROM selected_obligations o)
                SELECT obligations.*,
                    (SELECT COALESCE(SUM(a.amount_in_cents),0)::text FROM selected_allocations a) AS transferred,
                    (SELECT COALESCE(SUM(t.amount_in_cents),0)::text FROM transfers t) AS transfer_total,
                    (SELECT COUNT(*)::integer FROM transfers) AS transfer_count
                    ,(SELECT COALESCE(SUM((ch.snapshot->>'appliedAmountInCents')::bigint),0)::text FROM inter_member_obligation_changes ch WHERE ch.space_id=$1 AND ch.type='OFFSET_APPLIED' AND ch.snapshot->>'cycleId'=ANY($3::text[])) AS compensated
                    ,(SELECT COALESCE(SUM((ch.snapshot->>'appliedAmountInCents')::bigint),0)::text FROM inter_member_obligation_changes ch WHERE ch.space_id=$1 AND ch.type='WAIVED' AND ch.snapshot->>'cycleId'=ANY($3::text[])) AS waived
                FROM obligations`,
                [spaceId, actorMemberId, cycleIds],
            );
            const rows: { item: SelectedSettlementObligation }[] =
                await this.managers.get().query(
                    `
                WITH page AS MATERIALIZED (
                    SELECT * FROM inter_member_obligations WHERE space_id=$1 AND cycle_id=ANY($3::uuid[])
                    AND ($4='ALL' OR ($4='PAYABLE' AND debtor_member_id=$2) OR ($4='RECEIVABLE' AND creditor_member_id=$2))
                    AND ($5::timestamptz IS NULL OR (registered_at,id)<($5::timestamptz,$6::uuid))
                    ORDER BY registered_at DESC,id DESC LIMIT 21
                ), origins AS MATERIALIZED (
                    SELECT c.id,c.kind,c.description,COALESCE(v.amount_in_cents,i.amount_in_cents) AS amount_in_cents,
                        COALESCE((SELECT jsonb_agg(jsonb_build_object('memberId',s.member_id,'amountInCents',s.amount_in_cents) ORDER BY s.member_id)
                            FROM financial_commitment_shares s WHERE s.space_id=$1 AND s.commitment_id=c.id AND s.version=1),
                            (SELECT jsonb_agg(jsonb_build_object('memberId',s.member_id,'amountInCents',s.amount_in_cents) ORDER BY s.member_id)
                            FROM financial_income_shares s WHERE s.space_id=$1 AND s.commitment_id=c.id),'[]'::jsonb) AS shares,
                        COALESCE((SELECT s.amount_in_cents FROM financial_commitment_shares s WHERE s.space_id=$1 AND s.commitment_id=c.id AND s.version=1 AND s.member_id=$2),
                            (SELECT s.amount_in_cents FROM financial_income_shares s WHERE s.space_id=$1 AND s.commitment_id=c.id AND s.member_id=$2),0) AS actor_amount
                    FROM financial_commitments c LEFT JOIN financial_commitment_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id AND v.version=1
                    LEFT JOIN financial_income_versions i ON i.space_id=c.space_id AND i.commitment_id=c.id
                    WHERE c.space_id=$1 AND c.id IN (SELECT commitment_id FROM page)
                )
                SELECT jsonb_build_object('id',p.id,'version',p.version,'status',p.status,'debtorMemberId',p.debtor_member_id,'creditorMemberId',p.creditor_member_id,
                    'originalAmountInCents',p.original_amount_in_cents,'recognizedAmountInCents',p.recognized_amount_in_cents,
                    'resolvedAmountInCents',p.recognized_amount_in_cents-p.remaining_amount_in_cents,'remainingAmountInCents',p.remaining_amount_in_cents,
                    'compensatedAmountInCents',COALESCE((SELECT SUM((ch.snapshot->>'appliedAmountInCents')::bigint) FROM inter_member_obligation_changes ch WHERE ch.space_id=$1 AND ch.obligation_id=p.id AND ch.type='OFFSET_APPLIED'),0),
                    'waivedAmountInCents',COALESCE((SELECT SUM((ch.snapshot->>'appliedAmountInCents')::bigint) FROM inter_member_obligation_changes ch WHERE ch.space_id=$1 AND ch.obligation_id=p.id AND ch.type='WAIVED'),0),
                    'cycleId',p.cycle_id,'factDate',to_char(p.fact_date,'YYYY-MM-DD'),
                    'registeredAt',to_char(p.registered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                    'origin',jsonb_strip_nulls(jsonb_build_object('kind',c.kind,'commitmentId',c.id,'description',c.description,
                        'disbursementId',p.disbursement_id,'receiptId',p.receipt_id,'externalLiabilityId',p.external_liability_id,'amountInCents',c.amount_in_cents,
                        'distribution',jsonb_build_object('kind',CASE WHEN c.kind='INCOME' THEN 'PARTICIPATION' ELSE 'RESPONSIBILITY' END,
                            'shares',c.shares,'actorAmountInCents',c.actor_amount)))) AS item
                FROM page p JOIN origins c ON c.id=p.commitment_id ORDER BY p.registered_at DESC,p.id DESC`,
                    [
                        spaceId,
                        actorMemberId,
                        cycleIds,
                        direction,
                        after?.registeredAt ?? null,
                        after?.id ?? null,
                    ],
                );
            const t = totals[0];
            const resultTotals: SelectedSettlementTotals = {
                ...settlementCycleTotals(
                    t.original,
                    t.remaining,
                    t.transferred,
                    t.recognized,
                    t.compensated,
                    t.waived,
                ),
                transferTotalAmountInCents: t.transfer_total,
                transferCount: t.transfer_count,
                grossPayableAmountInCents: t.gross_payable,
                grossReceivableAmountInCents: t.gross_receivable,
            };
            return {
                cycles: selected.map(cycle),
                totals: resultTotals,
                payableAmountInCents: t.payable,
                receivableAmountInCents: t.receivable,
                items: rows.map((r) => r.item),
            };
        });
    }
}
