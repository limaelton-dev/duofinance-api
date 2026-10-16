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
const recurringDate = `make_date(EXTRACT(YEAR FROM $2::date)::integer,EXTRACT(MONTH FROM $2::date)::integer,LEAST(v.day_of_month,EXTRACT(DAY FROM (date_trunc('month',$2::date)+interval '1 month - 1 day')::date)::integer))`;
// Only facts owned by Finances are read. All branches retain their own date and author.
const facts = `WITH facts AS (
    SELECT c.id,'EXPENSE'::text AS type,c.id AS commitment_id,NULL::uuid AS external_liability_id,c.description,v.amount_in_cents,
        COALESCE(v.fact_date,(SELECT MIN(first_fact.fact_date) FROM (
            SELECT d.fact_date FROM financial_disbursements d WHERE d.space_id=c.space_id AND d.commitment_id=c.id
            UNION ALL SELECT l.fact_date FROM financial_external_liabilities l WHERE l.space_id=c.space_id AND l.commitment_id=c.id
        ) first_fact)) AS relevant_date,c.registered_at,c.created_by AS recorded_by_person_id,
        NULL::uuid AS participant_member_id,c.personal_owner_person_id AS participant_person_id,NULL::uuid AS recipient_member_id,
        ARRAY(SELECT s.member_id FROM financial_commitment_shares s WHERE s.space_id=c.space_id AND s.commitment_id=c.id AND s.version=v.version) AS member_ids
    FROM financial_commitments c JOIN financial_commitment_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id WHERE c.space_id=$1 AND c.kind='EXPENSE'
    UNION ALL
    SELECT o.id,'EXPENSE',c.id,NULL,c.description,o.amount_in_cents,
        (SELECT MIN(f.fact_date) FROM (
            SELECT d.fact_date FROM financial_disbursements d WHERE d.space_id=o.space_id AND d.occurrence_id=o.id
            UNION ALL SELECT l.fact_date FROM financial_external_liabilities l WHERE l.space_id=o.space_id AND l.occurrence_id=o.id
        ) f),o.materialized_at,c.created_by,NULL,c.personal_owner_person_id,NULL,
        ARRAY(SELECT s.member_id FROM financial_recurrence_shares s WHERE s.space_id=c.space_id AND s.commitment_id=c.id AND s.version=o.economic_version)
    FROM financial_occurrences o JOIN financial_commitments c ON c.space_id=o.space_id AND c.id=o.commitment_id
    WHERE o.space_id=$1 AND c.kind='EXPENSE'
    UNION ALL
    SELECT c.id,'EXPECTED_EXPENSE',c.id,NULL,c.description,v.amount_in_cents,v.expected_payment_date,c.registered_at,c.created_by,
        v.expected_payer_member_id,c.personal_owner_person_id,NULL,
        ARRAY(SELECT s.member_id FROM financial_commitment_shares s WHERE s.space_id=c.space_id AND s.commitment_id=c.id AND s.version=v.version)
    FROM financial_commitments c JOIN financial_commitment_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id
    WHERE c.space_id=$1 AND c.kind='EXPENSE' AND v.expected_payment_date IS NOT NULL
    UNION ALL
    SELECT COALESCE(o.id,c.id),'EXPECTED_EXPENSE',c.id,NULL,c.description,v.amount_in_cents,${recurringDate},c.registered_at,c.created_by,
        v.expected_member_id,v.owner_person_id,NULL,
        ARRAY(SELECT s.member_id FROM financial_recurrence_shares s WHERE s.space_id=c.space_id AND s.commitment_id=c.id AND s.version=v.version)
    FROM financial_commitments c JOIN financial_recurrence_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id AND v.version=1
    LEFT JOIN financial_occurrences o ON o.space_id=c.space_id AND o.commitment_id=c.id AND o.reference_date=${recurringDate}
    WHERE c.space_id=$1 AND c.kind='EXPENSE' AND c.modality='RECURRING'
        AND (v.frequency='MONTHLY' OR v.month_of_year=EXTRACT(MONTH FROM $2::date)::integer)
        AND ${recurringDate}>=v.starts_on AND (v.ends_on IS NULL OR ${recurringDate}<=v.ends_on)
    UNION ALL
    SELECT c.id,'EXPECTED_INCOME',c.id,NULL,c.description,v.amount_in_cents,v.expected_receipt_date,c.registered_at,c.created_by,
        v.expected_recipient_member_id,v.owner_person_id,NULL,
        ARRAY(SELECT s.member_id FROM financial_income_shares s WHERE s.space_id=c.space_id AND s.commitment_id=c.id)
    FROM financial_commitments c JOIN financial_income_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id WHERE c.space_id=$1 AND c.kind='INCOME'
    UNION ALL
    SELECT COALESCE(o.id,c.id),'EXPECTED_INCOME',c.id,NULL,c.description,v.amount_in_cents,${recurringDate},c.registered_at,c.created_by,
        v.expected_member_id,v.owner_person_id,NULL,
        ARRAY(SELECT s.member_id FROM financial_recurrence_shares s WHERE s.space_id=c.space_id AND s.commitment_id=c.id AND s.version=v.version)
    FROM financial_commitments c JOIN financial_recurrence_versions v ON v.space_id=c.space_id AND v.commitment_id=c.id AND v.version=1
    LEFT JOIN financial_occurrences o ON o.space_id=c.space_id AND o.commitment_id=c.id AND o.reference_date=${recurringDate}
    WHERE c.space_id=$1 AND c.kind='INCOME' AND c.modality='RECURRING'
        AND (v.frequency='MONTHLY' OR v.month_of_year=EXTRACT(MONTH FROM $2::date)::integer)
        AND ${recurringDate}>=v.starts_on AND (v.ends_on IS NULL OR ${recurringDate}<=v.ends_on)
    UNION ALL
    SELECT f.id,'DISBURSEMENT',c.id,NULL,c.description,f.amount_in_cents,f.fact_date,f.registered_at,f.recorded_by_person_id,f.payer_member_id,f.payer_person_id,NULL,ARRAY[f.payer_member_id]
    FROM financial_disbursements f JOIN financial_commitments c ON c.space_id=f.space_id AND c.id=f.commitment_id WHERE f.space_id=$1
    UNION ALL
    SELECT f.id,'RECEIPT',c.id,NULL,c.description,f.amount_in_cents,f.fact_date,f.registered_at,f.recorded_by_person_id,f.recipient_member_id,f.recipient_person_id,NULL,
        ARRAY(SELECT s.member_id FROM financial_income_shares s WHERE s.space_id=c.space_id AND s.commitment_id=c.id)
            || ARRAY(SELECT s.member_id FROM financial_recurrence_shares s JOIN financial_occurrences o
                ON o.space_id=s.space_id AND o.commitment_id=s.commitment_id AND o.economic_version=s.version
                WHERE o.id=f.occurrence_id AND o.space_id=f.space_id)
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
    UNION ALL
    SELECT f.id,'INTERNAL_REVERSAL',NULL,NULL,CASE WHEN f.original_kind='TRANSFER' THEN 'Reversão de transferência' ELSE 'Reversão de compensação' END,f.amount_in_cents,f.fact_date,f.registered_at,f.created_by,NULL,NULL,NULL,
        ARRAY(SELECT DISTINCT a.debtor_member_id FROM settlement_reversal_applications a WHERE a.space_id=f.space_id AND a.reversal_id=f.id UNION SELECT DISTINCT a.creditor_member_id FROM settlement_reversal_applications a WHERE a.space_id=f.space_id AND a.reversal_id=f.id)
    FROM settlement_reversals f WHERE f.space_id=$1
), selected AS (
    SELECT * FROM facts WHERE relevant_date >= $2::date AND relevant_date < $3::date AND ($4::uuid IS NULL OR $4::uuid=ANY(member_ids))
)`;
const projection = `id,type,commitment_id AS "commitmentId",external_liability_id AS "externalLiabilityId",description,amount_in_cents::text AS "amountInCents",to_char(relevant_date,'YYYY-MM-DD') AS "relevantDate",
    CASE WHEN type IN ('EXPECTED_INCOME','EXPECTED_EXPENSE') THEN 'EXPECTED' ELSE 'ACTUAL' END AS "dateNature",${instant('registered_at')} AS "registeredAt",recorded_by_person_id AS "recordedByPersonId",participant_member_id AS "participantMemberId",participant_person_id AS "participantPersonId",recipient_member_id AS "recipientMemberId",array_remove(member_ids,NULL) AS "memberIds"`;
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
    'internalTransfersSentReversedAmountInCents',
    'internalTransfersReceivedReversedAmountInCents',
    'internalTransfersSentEffectiveAmountInCents',
    'internalTransfersReceivedEffectiveAmountInCents',
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
    result.internalTransfersSentEffectiveAmountInCents = (
        BigInt(result.internalTransfersSentAmountInCents) -
        BigInt(result.internalTransfersSentReversedAmountInCents ?? '0')
    ).toString();
    result.internalTransfersReceivedEffectiveAmountInCents = (
        BigInt(result.internalTransfersReceivedAmountInCents) -
        BigInt(result.internalTransfersReceivedReversedAmountInCents ?? '0')
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
            expectedExpense: string;
            fulfilledExpense: string;
            remainingExpense: string;
        }[] = await this.managers.get().query(
            `${facts}, pending AS (
            SELECT s.*,CASE WHEN s.type='EXPECTED_INCOME'
                THEN COALESCE((SELECT SUM(r.amount_in_cents) FROM financial_receipts r JOIN financial_commitments c ON c.space_id=r.space_id AND c.id=r.commitment_id WHERE r.space_id=$1 AND r.commitment_id=s.commitment_id AND (c.modality='ONE_TIME' OR r.occurrence_id=s.id)),0)
                ELSE COALESCE((SELECT SUM(d.amount_in_cents) FROM financial_disbursements d JOIN financial_commitments c ON c.space_id=d.space_id AND c.id=d.commitment_id WHERE d.space_id=$1 AND d.commitment_id=s.commitment_id AND (c.modality='ONE_TIME' OR d.occurrence_id=s.id)),0)
                    + COALESCE((SELECT SUM(l.amount_in_cents) FROM financial_external_liabilities l JOIN financial_commitments c ON c.space_id=l.space_id AND c.id=l.commitment_id WHERE l.space_id=$1 AND l.commitment_id=s.commitment_id AND (c.modality='ONE_TIME' OR l.occurrence_id=s.id)),0)
                END AS received
            FROM selected s WHERE type='EXPECTED_EXPENSE' OR (type='EXPECTED_INCOME' AND relevant_date >= $5::date)
        ), outstanding AS (SELECT *,amount_in_cents-received AS remaining FROM pending WHERE received<amount_in_cents), page AS (
            SELECT ${projection},received::text AS "receivedAmountInCents",remaining::text AS "remainingAmountInCents" FROM outstanding
            WHERE ($6::date IS NULL OR (relevant_date,id)>($6::date,$7::uuid)) ORDER BY relevant_date,id LIMIT 21
        ) SELECT COALESCE((SELECT jsonb_agg(p ORDER BY p."relevantDate",p.id) FROM page p),'[]'::jsonb) AS items,
            COALESCE(SUM(amount_in_cents) FILTER (WHERE type='EXPECTED_INCOME'),0)::text AS expected,
            COALESCE(SUM(received) FILTER (WHERE type='EXPECTED_INCOME'),0)::text AS received,
            COALESCE(SUM(remaining) FILTER (WHERE type='EXPECTED_INCOME'),0)::text AS remaining,
            COALESCE(SUM(amount_in_cents) FILTER (WHERE type='EXPECTED_EXPENSE'),0)::text AS "expectedExpense",
            COALESCE(SUM(received) FILTER (WHERE type='EXPECTED_EXPENSE'),0)::text AS "fulfilledExpense",
            COALESCE(SUM(remaining) FILTER (WHERE type='EXPECTED_EXPENSE'),0)::text AS "remainingExpense" FROM outstanding`,
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
                type: row.type as 'EXPECTED_INCOME' | 'EXPECTED_EXPENSE',
                receivedAmountInCents: safe(row.receivedAmountInCents),
                ...(row.type === 'EXPECTED_EXPENSE'
                    ? {
                          fulfilledAmountInCents: safe(
                              row.receivedAmountInCents,
                          ),
                      }
                    : {}),
                remainingAmountInCents: safe(row.remainingAmountInCents),
                ...(row.type === 'EXPECTED_EXPENSE'
                    ? {
                          overdue:
                              row.relevantDate < scope.referenceDate &&
                              safe(row.remainingAmountInCents) > 0,
                      }
                    : {}),
            })) as FinancialForecastItem[],
            totals: {
                expectedAmountInCents: rows[0].expected,
                receivedAmountInCents: rows[0].received,
                remainingAmountInCents: rows[0].remaining,
                ...(rows[0].expectedExpense !== '0'
                    ? {
                          expectedExpenseAmountInCents: rows[0].expectedExpense,
                          fulfilledExpenseAmountInCents:
                              rows[0].fulfilledExpense,
                          remainingExpenseAmountInCents:
                              rows[0].remainingExpense,
                      }
                    : {}),
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
            expenses AS (
                SELECT v.space_id,v.commitment_id,v.version,v.amount_in_cents,c.personal_owner_person_id,'ONE_TIME'::text AS modality FROM financial_commitment_versions v
                JOIN financial_commitments c ON c.space_id=v.space_id AND c.id=v.commitment_id
                WHERE v.space_id=$1 AND COALESCE(v.fact_date,(
                    SELECT MIN(first_fact.fact_date) FROM (
                        SELECT d.fact_date FROM financial_disbursements d WHERE d.space_id=v.space_id AND d.commitment_id=v.commitment_id
                        UNION ALL SELECT l.fact_date FROM financial_external_liabilities l WHERE l.space_id=v.space_id AND l.commitment_id=v.commitment_id
                    ) first_fact
                )) >= $2::date AND COALESCE(v.fact_date,(
                    SELECT MIN(first_fact.fact_date) FROM (
                        SELECT d.fact_date FROM financial_disbursements d WHERE d.space_id=v.space_id AND d.commitment_id=v.commitment_id
                        UNION ALL SELECT l.fact_date FROM financial_external_liabilities l WHERE l.space_id=v.space_id AND l.commitment_id=v.commitment_id
                    ) first_fact
                )) < $3::date
                UNION ALL
                SELECT o.space_id,o.commitment_id,o.economic_version,o.amount_in_cents,c.personal_owner_person_id,'RECURRING'
                FROM financial_occurrences o JOIN financial_commitments c ON c.space_id=o.space_id AND c.id=o.commitment_id
                WHERE o.space_id=$1 AND c.kind='EXPENSE' AND (
                    SELECT MIN(f.fact_date) FROM (
                        SELECT d.fact_date FROM financial_disbursements d WHERE d.space_id=o.space_id AND d.occurrence_id=o.id
                        UNION ALL SELECT l.fact_date FROM financial_external_liabilities l WHERE l.space_id=o.space_id AND l.occurrence_id=o.id
                    ) f
                ) >= $2::date AND (
                    SELECT MIN(f.fact_date) FROM (
                        SELECT d.fact_date FROM financial_disbursements d WHERE d.space_id=o.space_id AND d.occurrence_id=o.id
                        UNION ALL SELECT l.fact_date FROM financial_external_liabilities l WHERE l.space_id=o.space_id AND l.occurrence_id=o.id
                    ) f
                ) < $3::date
            ),
            period_receipts AS (SELECT r.* FROM financial_receipts r WHERE r.space_id=$1),
            contributions AS (
                SELECT NULL::uuid AS member_id,'expenseAmountInCents' AS metric,SUM(amount_in_cents)::numeric AS amount FROM expenses
                UNION ALL SELECT s.member_id,'expenseAmountInCents',SUM(s.amount_in_cents) FROM expenses e JOIN financial_commitment_shares s ON s.space_id=e.space_id AND s.commitment_id=e.commitment_id AND s.version=e.version WHERE e.modality='ONE_TIME' GROUP BY s.member_id
                UNION ALL SELECT s.member_id,'expenseAmountInCents',SUM(s.amount_in_cents) FROM expenses e JOIN financial_recurrence_shares s ON s.space_id=e.space_id AND s.commitment_id=e.commitment_id AND s.version=e.version WHERE e.modality='RECURRING' GROUP BY s.member_id
                UNION ALL SELECT NULL,'realizedIncomeAmountInCents',SUM(amount_in_cents) FROM period_receipts WHERE fact_date >= $2::date AND fact_date < $3::date
                UNION ALL SELECT payer_member_id,'paidAmountInCents',SUM(amount_in_cents) FROM financial_disbursements WHERE space_id=$1 AND fact_date >= $2::date AND fact_date < $3::date GROUP BY GROUPING SETS((),(payer_member_id)) HAVING GROUPING(payer_member_id)=1 OR payer_member_id IS NOT NULL
                UNION ALL SELECT recipient_member_id,'receivedAmountInCents',SUM(amount_in_cents) FROM period_receipts WHERE fact_date >= $2::date AND fact_date < $3::date GROUP BY GROUPING SETS((),(recipient_member_id)) HAVING GROUPING(recipient_member_id)=1 OR recipient_member_id IS NOT NULL
                UNION ALL SELECT holder_member_id,'assumedAmountInCents',SUM(amount_in_cents) FROM financial_external_liabilities WHERE space_id=$1 AND fact_date >= $2::date AND fact_date < $3::date GROUP BY GROUPING SETS((),(holder_member_id)) HAVING GROUPING(holder_member_id)=1 OR holder_member_id IS NOT NULL
                UNION ALL SELECT holder_member_id,'externalSettledAmountInCents',SUM(amount_in_cents) FROM financial_external_liability_settlements WHERE space_id=$1 AND fact_date >= $2::date AND fact_date < $3::date GROUP BY GROUPING SETS((),(holder_member_id)) HAVING GROUPING(holder_member_id)=1 OR holder_member_id IS NOT NULL
                UNION ALL SELECT payer_member_id,'internalTransfersSentAmountInCents',SUM(amount_in_cents) FROM settlement_transfers WHERE space_id=$1 AND fact_date >= $2::date AND fact_date < $3::date GROUP BY GROUPING SETS((),(payer_member_id)) HAVING GROUPING(payer_member_id)=1 OR payer_member_id IS NOT NULL
                UNION ALL SELECT recipient_member_id,'internalTransfersReceivedAmountInCents',SUM(amount_in_cents) FROM settlement_transfers WHERE space_id=$1 AND fact_date >= $2::date AND fact_date < $3::date GROUP BY GROUPING SETS((),(recipient_member_id)) HAVING GROUPING(recipient_member_id)=1 OR recipient_member_id IS NOT NULL
                UNION ALL SELECT t.payer_member_id,'internalTransfersSentReversedAmountInCents',SUM(r.amount_in_cents) FROM settlement_reversals r JOIN settlement_transfers t ON t.space_id=r.space_id AND t.id=r.original_transfer_id WHERE r.space_id=$1 AND t.fact_date >= $2::date AND t.fact_date < $3::date GROUP BY GROUPING SETS((),(t.payer_member_id)) HAVING GROUPING(t.payer_member_id)=1 OR t.payer_member_id IS NOT NULL
                UNION ALL SELECT t.recipient_member_id,'internalTransfersReceivedReversedAmountInCents',SUM(r.amount_in_cents) FROM settlement_reversals r JOIN settlement_transfers t ON t.space_id=r.space_id AND t.id=r.original_transfer_id WHERE r.space_id=$1 AND t.fact_date >= $2::date AND t.fact_date < $3::date GROUP BY GROUPING SETS((),(t.recipient_member_id)) HAVING GROUPING(t.recipient_member_id)=1 OR t.recipient_member_id IS NOT NULL
            ), metrics AS (SELECT member_id,jsonb_object_agg(metric,COALESCE(amount,0)::text) AS payload FROM contributions GROUP BY member_id),
            income AS (
                SELECT v.amount_in_cents::text AS amount,COALESCE(SUM(r.amount_in_cents) FILTER (WHERE r.fact_date < $2::date),0)::text AS before,SUM(r.amount_in_cents)::text AS after,v.split_input AS "splitInput" FROM period_receipts r JOIN financial_income_versions v ON v.space_id=r.space_id AND v.commitment_id=r.commitment_id WHERE r.fact_date < $3::date AND v.split_input IS NOT NULL GROUP BY v.commitment_id,v.amount_in_cents,v.split_input HAVING COUNT(*) FILTER (WHERE r.fact_date >= $2::date)>0
                UNION ALL
                SELECT v.amount_in_cents::text,COALESCE(SUM(r.amount_in_cents) FILTER (WHERE r.fact_date < $2::date),0)::text,SUM(r.amount_in_cents)::text,v.split_input
                FROM period_receipts r JOIN financial_occurrences o ON o.space_id=r.space_id AND o.id=r.occurrence_id
                JOIN financial_recurrence_versions v ON v.space_id=o.space_id AND v.commitment_id=o.commitment_id AND v.version=o.economic_version
                WHERE r.fact_date < $3::date AND v.split_input IS NOT NULL
                GROUP BY o.id,v.amount_in_cents,v.split_input HAVING COUNT(*) FILTER (WHERE r.fact_date >= $2::date)>0
            ),
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
