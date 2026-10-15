import { Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { InterMemberPositionReader } from '../../../application/ports/private/inter-member-position-reader.js';
import type {
    OpenObligationView,
    PositionDirection,
    PositionKey,
} from '../../../application/models/inter-member-position.js';
interface PositionRow {
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
    target_date: string;
    cycle_status: 'OPEN' | 'FINALIZED';
}
function safeAmount(value: string): number {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount < 0)
        throw new Error('Invalid persisted obligation amount');
    return amount;
}
@Injectable()
export class TypeOrmInterMemberPositionReader implements InterMemberPositionReader {
    constructor(private readonly managers: EntityManagerProvider) {}
    async read(
        spaceId: string,
        actorMemberId: string,
        direction: PositionDirection,
        after: PositionKey | null,
    ) {
        const rows: PositionRow[] = await this.managers.get().query(
            `
            WITH open_obligations AS MATERIALIZED (
                SELECT * FROM inter_member_obligations
                WHERE space_id = $1 AND status IN ('OPEN','PARTIALLY_SETTLED') AND remaining_amount_in_cents > 0
                AND (debtor_member_id = $2 OR creditor_member_id = $2)
            ), totals AS (
                SELECT COALESCE(SUM(remaining_amount_in_cents) FILTER (WHERE debtor_member_id = $2), 0)::text AS payable,
                    COALESCE(SUM(remaining_amount_in_cents) FILTER (WHERE creditor_member_id = $2), 0)::text AS receivable
                FROM open_obligations
            ), page AS (
                SELECT * FROM open_obligations
                WHERE ($3 = 'ALL' OR ($3 = 'PAYABLE' AND debtor_member_id = $2) OR ($3 = 'RECEIVABLE' AND creditor_member_id = $2))
                    AND ($4::timestamptz IS NULL OR (registered_at, id) < ($4::timestamptz, $5::uuid))
                ORDER BY registered_at DESC, id DESC LIMIT 21
            )
            SELECT t.payable, t.receivable, p.id, p.version, p.status, p.debtor_member_id, p.creditor_member_id,
                p.original_amount_in_cents::text, p.recognized_amount_in_cents::text, p.remaining_amount_in_cents::text,
                to_char(p.fact_date, 'YYYY-MM-DD') AS fact_date,
                to_char(p.registered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS registered_at,
                p.commitment_id, p.disbursement_id, p.external_liability_id, p.receipt_id, c.description, p.cycle_id,
                to_char(s.target_date, 'YYYY-MM-DD') AS target_date, s.status AS cycle_status
            FROM totals t LEFT JOIN page p ON true
            LEFT JOIN financial_commitments c ON c.space_id = $1 AND c.id = p.commitment_id
            LEFT JOIN settlement_cycles s ON s.space_id = $1 AND s.id = p.cycle_id
            ORDER BY p.registered_at DESC, p.id DESC
        `,
            [
                spaceId,
                actorMemberId,
                direction,
                after?.registeredAt ?? null,
                after?.id ?? null,
            ],
        );
        const items: OpenObligationView[] = rows
            .filter((row) => row.id !== null)
            .map((row) => ({
                id: row.id!,
                version: row.version,
                status: row.status,
                debtorMemberId: row.debtor_member_id,
                creditorMemberId: row.creditor_member_id,
                originalAmountInCents: safeAmount(row.original_amount_in_cents),
                recognizedAmountInCents: safeAmount(
                    row.recognized_amount_in_cents,
                ),
                remainingAmountInCents: safeAmount(
                    row.remaining_amount_in_cents,
                ),
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
                settlementCycle:
                    row.cycle_id === null
                        ? null
                        : {
                              id: row.cycle_id,
                              targetDate: row.target_date,
                              status: row.cycle_status,
                          },
            }));
        return {
            payableAmountInCents: rows[0].payable,
            receivableAmountInCents: rows[0].receivable,
            items,
        };
    }
}
