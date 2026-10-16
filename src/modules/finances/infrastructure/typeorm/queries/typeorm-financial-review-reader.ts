import { Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import type { FinancialReviewReader } from '../../../application/ports/private/financial-review-reader.js';
import type {
    FinancialReviewScope,
    FinancialReviewKey,
    FinancialReviewItem,
    FinancialForecastItem,
    FinancialReviewMetrics,
} from '../../../application/models/financial-review.js';
import {
    ResponsibilitySplit,
    type SplitInput,
} from '../../../domain/shared-expense/responsibility-split.js';

const instant = (name: string) =>
    `to_char(${name} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// Only facts owned by Finances are read. All branches retain their own date and author.
const facts = `WITH facts AS (
    SELECT c.id,'EXPENSE'::text AS type,c.id AS commitment_id,NULL::uuid AS external_liability_id,c.description,v.amount_in_cents,v.fact_date AS relevant_date,c.registered_at,c.created_by AS recorded_by_person_id,
        NULL::uuid AS participant_member_id,c.personal_owner_person_id AS participant_person_id,NULL::uuid AS recipient_member_id,
        ARRAY(SELECT s.member_id FROM financial_commitment_shares s WHERE s.space_id=c.space_id AND s.commitment_id=c.id AND s.version=v.version) AS member_ids
    FROM financial_commitments c JOIN financial_commitment_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id WHERE c.space_id=$1 AND c.kind='EXPENSE'
    UNION ALL
    SELECT c.id,'EXPECTED_INCOME',c.id,NULL,c.description,v.amount_in_cents,v.expected_receipt_date,c.registered_at,c.created_by,
        v.expected_recipient_member_id,v.owner_person_id,NULL,
        ARRAY(SELECT s.member_id FROM financial_income_shares s WHERE s.space_id=c.space_id AND s.commitment_id=c.id)
    FROM financial_commitments c JOIN financial_income_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id WHERE c.space_id=$1 AND c.kind='INCOME'
    UNION ALL
    SELECT f.id,'DISBURSEMENT',c.id,NULL,c.description,f.amount_in_cents,f.fact_date,f.registered_at,f.recorded_by_person_id,f.payer_member_id,f.payer_person_id,NULL,ARRAY[f.payer_member_id]
    FROM financial_disbursements f JOIN financial_commitments c ON c.space_id=f.space_id AND c.id=f.commitment_id WHERE f.space_id=$1
    UNION ALL
    SELECT f.id,'RECEIPT',c.id,NULL,c.description,f.amount_in_cents,f.fact_date,f.registered_at,f.recorded_by_person_id,f.recipient_member_id,f.recipient_person_id,NULL,
        ARRAY(SELECT s.member_id FROM financial_income_shares s WHERE s.space_id=c.space_id AND s.commitment_id=c.id)
    FROM financial_receipts f JOIN financial_commitments c ON c.space_id=f.space_id AND c.id=f.commitment_id WHERE f.space_id=$1
    UNION ALL
    SELECT f.id,'EXTERNAL_LIABILITY',c.id,f.id,c.description,f.amount_in_cents,f.fact_date,f.registered_at,f.recorded_by_person_id,f.holder_member_id,f.holder_person_id,NULL,ARRAY[f.holder_member_id]
    FROM financial_external_liabilities f JOIN financial_commitments c ON c.space_id=f.space_id AND c.id=f.commitment_id WHERE f.space_id=$1
    UNION ALL
    SELECT f.id,'EXTERNAL_SETTLEMENT',c.id,f.external_liability_id,c.description,f.amount_in_cents,f.fact_date,f.registered_at,f.recorded_by_person_id,f.holder_member_id,f.holder_person_id,NULL,ARRAY[f.holder_member_id]
    FROM financial_external_liability_settlements f JOIN financial_commitments c ON c.space_id=f.space_id AND c.id=f.commitment_id WHERE f.space_id=$1
    UNION ALL
    SELECT f.id,'INTERNAL_TRANSFER',NULL,NULL,'Transferência interna',f.amount_in_cents,f.fact_date,f.registered_at,f.created_by,f.payer_member_id,NULL,f.recipient_member_id,ARRAY[f.payer_member_id,f.recipient_member_id]
    FROM settlement_transfers f WHERE f.space_id=$1
    UNION ALL
    SELECT f.id,'INTERNAL_OFFSET',NULL,NULL,'Compensação entre pendências',f.amount_in_cents,f.fact_date,f.registered_at,f.created_by,NULL,NULL,NULL,
        ARRAY(SELECT DISTINCT a.debtor_member_id FROM settlement_offset_allocations a WHERE a.space_id=f.space_id AND a.offset_id=f.id ORDER BY a.debtor_member_id)
    FROM settlement_offsets f WHERE f.space_id=$1
    UNION ALL
    SELECT f.id,'INTERNAL_WAIVER',o.commitment_id,NULL,'Dispensa de pendência',f.amount_in_cents,f.fact_date,f.registered_at,f.created_by,f.creditor_member_id,NULL,NULL,
        ARRAY[o.debtor_member_id,o.creditor_member_id]
    FROM obligation_waivers f JOIN inter_member_obligations o ON o.space_id=f.space_id AND o.id=f.obligation_id WHERE f.space_id=$1
), selected AS (
    SELECT * FROM facts WHERE relevant_date >= $2::date AND relevant_date < $3::date AND ($4::uuid IS NULL OR $4::uuid=ANY(member_ids))
)`;
const projection = `id,type,commitment_id AS "commitmentId",external_liability_id AS "externalLiabilityId",description,amount_in_cents::text AS "amountInCents",to_char(relevant_date,'YYYY-MM-DD') AS "relevantDate",
    CASE WHEN type='EXPECTED_INCOME' THEN 'EXPECTED' ELSE 'ACTUAL' END AS "dateNature",${instant('registered_at')} AS "registeredAt",recorded_by_person_id AS "recordedByPersonId",participant_member_id AS "participantMemberId",participant_person_id AS "participantPersonId",recipient_member_id AS "recipientMemberId",array_remove(member_ids,NULL) AS "memberIds"`;
const safe = (value: string) => {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount < 0)
        throw new Error('Invalid persisted financial amount');
    return amount;
};
type ItemRow = Omit<FinancialReviewItem, 'amountInCents'> & {
    amountInCents: string;
};
const item = (row: ItemRow): FinancialReviewItem => ({
    ...row,
    amountInCents: safe(row.amountInCents),
});
const metricNames = [
    'expenseAmountInCents',
    'realizedIncomeAmountInCents',
    'economicResultInCents',
    'paidAmountInCents',
    'receivedAmountInCents',
    'assumedAmountInCents',
    'externalSettledAmountInCents',
    'disbursedAmountInCents',
    'supportedAmountInCents',
    'internalTransfersSentAmountInCents',
    'internalTransfersReceivedAmountInCents',
] as const;
export function reviewMetrics(
    values: Partial<FinancialReviewMetrics> = {},
): FinancialReviewMetrics {
    const result = Object.fromEntries(
        metricNames.map((name) => [name, values[name] ?? '0']),
    ) as unknown as FinancialReviewMetrics;
    result.economicResultInCents = (
        BigInt(result.realizedIncomeAmountInCents) -
        BigInt(result.expenseAmountInCents)
    ).toString();
    result.disbursedAmountInCents = (
        BigInt(result.paidAmountInCents) +
        BigInt(result.externalSettledAmountInCents)
    ).toString();
    result.supportedAmountInCents = (
        BigInt(result.paidAmountInCents) + BigInt(result.assumedAmountInCents)
    ).toString();
    return result;
}
export interface IncomePeriodDelta {
    amount: string;
    before: string;
    after: string;
    splitInput: SplitInput;
}
export function realizedIncomeDeltas(
    receipts: IncomePeriodDelta[],
): Map<string, bigint> {
    const totals = new Map<string, bigint>();
    for (const receipt of receipts) {
        const split = ResponsibilitySplit.create(
            safe(receipt.amount),
            receipt.splitInput.shares.map((s) => s.memberId),
            receipt.splitInput,
        );
        const before = new Map(
            split
                .realizedShares(safe(receipt.before))
                .map((s) => [s.memberId, BigInt(s.amountInCents)]),
        );
        for (const share of split.realizedShares(safe(receipt.after)))
            totals.set(
                share.memberId,
                (totals.get(share.memberId) ?? 0n) +
                    BigInt(share.amountInCents) -
                    before.get(share.memberId)!,
            );
    }
    return totals;
}
@Injectable()
export class TypeOrmFinancialReviewReader implements FinancialReviewReader {
    constructor(private readonly managers: EntityManagerProvider) {}
    async timeline(
        scope: FinancialReviewScope,
        after: FinancialReviewKey | null,
    ) {
        const rows: ItemRow[] = await this.managers.get().query(
            `${facts}
            SELECT ${projection} FROM selected WHERE ($5::date IS NULL OR (relevant_date,registered_at,type,id)<($5::date,$6::timestamptz,$7::text,$8::uuid))
            ORDER BY relevant_date DESC,registered_at DESC,type DESC,id DESC LIMIT 21`,
            [
                scope.spaceId,
                scope.start,
                scope.end,
                scope.memberId,
                after?.relevantDate ?? null,
                after?.registeredAt ?? null,
                after?.type ?? null,
                after?.id ?? null,
            ],
        );
        return rows.map(item);
    }
    async forecast(
        scope: FinancialReviewScope,
        after: FinancialReviewKey | null,
    ) {
        const rows: {
            items: (ItemRow & {
                receivedAmountInCents: string;
                remainingAmountInCents: string;
            })[];
            expected: string;
            received: string;
            remaining: string;
        }[] = await this.managers.get().query(
            `${facts}, pending AS (
            SELECT s.*,COALESCE((SELECT SUM(r.amount_in_cents) FROM financial_receipts r WHERE r.space_id=$1 AND r.commitment_id=s.commitment_id),0) AS received
            FROM selected s WHERE type='EXPECTED_INCOME' AND relevant_date >= $5::date
        ), outstanding AS (SELECT *,amount_in_cents-received AS remaining FROM pending WHERE received<amount_in_cents), page AS (
            SELECT ${projection},received::text AS "receivedAmountInCents",remaining::text AS "remainingAmountInCents" FROM outstanding
            WHERE ($6::date IS NULL OR (relevant_date,id)>($6::date,$7::uuid)) ORDER BY relevant_date,id LIMIT 21
        ) SELECT COALESCE((SELECT jsonb_agg(p ORDER BY p."relevantDate",p.id) FROM page p),'[]'::jsonb) AS items,
            COALESCE(SUM(amount_in_cents),0)::text AS expected,COALESCE(SUM(received),0)::text AS received,COALESCE(SUM(remaining),0)::text AS remaining FROM outstanding`,
            [
                scope.spaceId,
                scope.start,
                scope.end,
                scope.memberId,
                scope.referenceDate,
                after?.relevantDate ?? null,
                after?.id ?? null,
            ],
        );
        return {
            items: rows[0].items.map((row) => ({
                ...item(row),
                type: 'EXPECTED_INCOME' as const,
                receivedAmountInCents: safe(row.receivedAmountInCents),
                remainingAmountInCents: safe(row.remainingAmountInCents),
            })) as FinancialForecastItem[],
            totals: {
                expectedAmountInCents: rows[0].expected,
                receivedAmountInCents: rows[0].received,
                remainingAmountInCents: rows[0].remaining,
            },
        };
    }
    async overview(scope: FinancialReviewScope) {
        type Row = {
            metrics: ({
                memberId: string | null;
            } & Partial<FinancialReviewMetrics>)[];
            income: IncomePeriodDelta[];
            open: { memberId: string | null; amount: string }[];
        };
        const rows: Row[] = await this.managers.get().query(
            `WITH
            expenses AS (SELECT v.*,c.personal_owner_person_id FROM financial_commitment_versions v JOIN financial_commitments c ON c.space_id=v.space_id AND c.id=v.commitment_id WHERE v.space_id=$1 AND v.fact_date >= $2::date AND v.fact_date < $3::date),
            period_receipts AS (SELECT r.* FROM financial_receipts r WHERE r.space_id=$1),
            contributions AS (
                SELECT NULL::uuid AS member_id,'expenseAmountInCents' AS metric,SUM(amount_in_cents)::numeric AS amount FROM expenses
                UNION ALL SELECT s.member_id,'expenseAmountInCents',SUM(s.amount_in_cents) FROM expenses e JOIN financial_commitment_shares s ON s.space_id=e.space_id AND s.commitment_id=e.commitment_id AND s.version=e.version GROUP BY s.member_id
                UNION ALL SELECT NULL,'realizedIncomeAmountInCents',SUM(amount_in_cents) FROM period_receipts WHERE fact_date >= $2::date AND fact_date < $3::date
                UNION ALL SELECT payer_member_id,'paidAmountInCents',SUM(amount_in_cents) FROM financial_disbursements WHERE space_id=$1 AND fact_date >= $2::date AND fact_date < $3::date GROUP BY GROUPING SETS((),(payer_member_id)) HAVING GROUPING(payer_member_id)=1 OR payer_member_id IS NOT NULL
                UNION ALL SELECT recipient_member_id,'receivedAmountInCents',SUM(amount_in_cents) FROM period_receipts WHERE fact_date >= $2::date AND fact_date < $3::date GROUP BY GROUPING SETS((),(recipient_member_id)) HAVING GROUPING(recipient_member_id)=1 OR recipient_member_id IS NOT NULL
                UNION ALL SELECT holder_member_id,'assumedAmountInCents',SUM(amount_in_cents) FROM financial_external_liabilities WHERE space_id=$1 AND fact_date >= $2::date AND fact_date < $3::date GROUP BY GROUPING SETS((),(holder_member_id)) HAVING GROUPING(holder_member_id)=1 OR holder_member_id IS NOT NULL
                UNION ALL SELECT holder_member_id,'externalSettledAmountInCents',SUM(amount_in_cents) FROM financial_external_liability_settlements WHERE space_id=$1 AND fact_date >= $2::date AND fact_date < $3::date GROUP BY GROUPING SETS((),(holder_member_id)) HAVING GROUPING(holder_member_id)=1 OR holder_member_id IS NOT NULL
                UNION ALL SELECT payer_member_id,'internalTransfersSentAmountInCents',SUM(amount_in_cents) FROM settlement_transfers WHERE space_id=$1 AND fact_date >= $2::date AND fact_date < $3::date GROUP BY GROUPING SETS((),(payer_member_id)) HAVING GROUPING(payer_member_id)=1 OR payer_member_id IS NOT NULL
                UNION ALL SELECT recipient_member_id,'internalTransfersReceivedAmountInCents',SUM(amount_in_cents) FROM settlement_transfers WHERE space_id=$1 AND fact_date >= $2::date AND fact_date < $3::date GROUP BY GROUPING SETS((),(recipient_member_id)) HAVING GROUPING(recipient_member_id)=1 OR recipient_member_id IS NOT NULL
            ), metrics AS (SELECT member_id,jsonb_object_agg(metric,COALESCE(amount,0)::text) AS payload FROM contributions GROUP BY member_id),
            income AS (SELECT v.amount_in_cents::text AS amount,COALESCE(SUM(r.amount_in_cents) FILTER (WHERE r.fact_date < $2::date),0)::text AS before,SUM(r.amount_in_cents)::text AS after,v.split_input AS "splitInput" FROM period_receipts r JOIN financial_income_versions v ON v.space_id=r.space_id AND v.commitment_id=r.commitment_id WHERE r.fact_date < $3::date AND v.split_input IS NOT NULL GROUP BY v.commitment_id,v.amount_in_cents,v.split_input HAVING COUNT(*) FILTER (WHERE r.fact_date >= $2::date)>0),
            open AS (SELECT holder_member_id AS "memberId",SUM(remaining_amount_in_cents)::text AS amount FROM financial_external_liabilities WHERE space_id=$1 AND remaining_amount_in_cents>0 GROUP BY GROUPING SETS((),(holder_member_id)) HAVING GROUPING(holder_member_id)=1 OR holder_member_id IS NOT NULL)
            SELECT COALESCE((SELECT jsonb_agg(payload || jsonb_build_object('memberId',member_id)) FROM metrics),'[]'::jsonb) AS metrics,
                COALESCE((SELECT jsonb_agg(i) FROM income i),'[]'::jsonb) AS income,COALESCE((SELECT jsonb_agg(o) FROM open o),'[]'::jsonb) AS open`,
            [scope.spaceId, scope.start, scope.end],
        );
        const row = rows[0];
        // SQL sums remain decimal strings; only bounded original amounts enter domain allocation.
        const income = realizedIncomeDeltas(row.income);
        const byMember = row.metrics
            .filter((m) => m.memberId !== null)
            .map((m) => ({
                ...reviewMetrics({
                    ...m,
                    realizedIncomeAmountInCents: (
                        income.get(m.memberId!) ?? 0n
                    ).toString(),
                }),
                memberId: m.memberId!,
            }));
        for (const [memberId, amount] of income)
            if (!byMember.some((m) => m.memberId === memberId))
                byMember.push({
                    ...reviewMetrics({
                        realizedIncomeAmountInCents: amount.toString(),
                    }),
                    memberId,
                });
        const global = reviewMetrics(
            row.metrics.find((m) => m.memberId === null),
        );
        const openByMember = row.open
            .filter((o) => o.memberId !== null)
            .map((o) => ({
                memberId: o.memberId!,
                outstandingAmountInCents: o.amount,
            }));
        return {
            totals: scope.memberId
                ? byMember.find((m) => m.memberId === scope.memberId)
                    ? reviewMetrics(
                          byMember.find((m) => m.memberId === scope.memberId),
                      )
                    : reviewMetrics()
                : global,
            byMember: scope.memberId
                ? byMember.filter((m) => m.memberId === scope.memberId)
                : byMember,
            currentExternalLiabilities: {
                referenceDate: scope.referenceDate,
                outstandingAmountInCents: scope.memberId
                    ? (openByMember.find((m) => m.memberId === scope.memberId)
                          ?.outstandingAmountInCents ?? '0')
                    : (row.open.find((o) => o.memberId === null)?.amount ??
                      '0'),
                byMember: scope.memberId
                    ? openByMember.filter((m) => m.memberId === scope.memberId)
                    : openByMember,
            },
        };
    }
}
