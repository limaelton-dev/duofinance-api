import { Injectable } from '@nestjs/common';
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
} from '../../../application/models/settlement-cycle.js';
import type {
    SettlementCycleRead,
    SettlementCycleReader,
} from '../../../application/ports/private/settlement-cycle-reader.js';
interface CycleRow {
    id: string;
    version: number;
    target_date: string;
    status: 'OPEN' | 'FINALIZED';
    finalized_at: string | null;
    original: string;
    remaining: string;
    transferred: string;
    payable: string;
    receivable: string;
    obligation_count: number;
    open_obligation_count: number;
}
interface DetailRow extends CycleRow {
    obligation_id: string | null;
    obligation_version: number;
    obligation_status: 'OPEN' | 'PARTIALLY_SETTLED' | 'SETTLED';
    debtor_member_id: string;
    creditor_member_id: string;
    original_amount_in_cents: string;
    remaining_amount_in_cents: string;
    fact_date: string;
    registered_at: string;
    commitment_id: string;
    disbursement_id: string;
    description: string;
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
                SELECT * FROM settlement_cycles WHERE space_id=$1 AND status='OPEN'
                AND ($3='OPEN' OR target_date >= $4::date)
                AND ($5::date IS NULL OR (target_date,id)>($5::date,$6::uuid))
                ORDER BY target_date ASC,id ASC LIMIT 21
            )
            SELECT ${cycleColumns}, ${aggregate},
                COALESCE((SELECT SUM(a.amount_in_cents) FROM settlement_allocations a WHERE a.space_id=$1 AND a.cycle_id=s.id),0)::text AS transferred
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
                COALESCE((SELECT SUM(a.amount_in_cents) FROM settlement_allocations a WHERE a.space_id=$1 AND a.cycle_id=s.id),0)::text AS transferred,
                p.id AS obligation_id,p.version AS obligation_version,p.status AS obligation_status,
                p.debtor_member_id,p.creditor_member_id,p.original_amount_in_cents::text,p.remaining_amount_in_cents::text,
                to_char(p.fact_date,'YYYY-MM-DD') AS fact_date,
                to_char(p.registered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS registered_at,
                p.commitment_id,p.disbursement_id,c.description
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
                resolvedAmountInCents: amount(
                    (
                        BigInt(row.original_amount_in_cents) -
                        BigInt(row.remaining_amount_in_cents)
                    ).toString(),
                ),
                remainingAmountInCents: amount(row.remaining_amount_in_cents),
                factDate: row.fact_date,
                registeredAt: row.registered_at,
                origin: {
                    commitmentId: row.commitment_id,
                    disbursementId: row.disbursement_id,
                    description: row.description,
                },
            }));
        return { cycle: cycle(rows[0]), items };
    }
}
