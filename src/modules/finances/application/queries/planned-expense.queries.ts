import { Inject, Injectable } from '@nestjs/common';
import { EntityManagerProvider } from '../../../../shared/technical/database/typeorm/entity-manager.provider.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../../spaces/application/ports/public/space-access.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import { financialMonth } from './financial-review.queries.js';

type PlannedKey = { date: string; id: string };

function scope(actor: PersonId, space: SpaceId, month: string) {
    return `${actor.value}:${space.value}:${month}:PLANNED_EXPENSE`;
}

function encode(scopeValue: string, key: PlannedKey) {
    return Buffer.from(JSON.stringify([scopeValue, key.date, key.id])).toString(
        'base64url',
    );
}

function decode(
    value: string | undefined,
    scopeValue: string,
): PlannedKey | null {
    if (value === undefined) return null;
    try {
        if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value))
            throw new Error();
        const data: unknown = JSON.parse(
            Buffer.from(value, 'base64url').toString('utf8'),
        );
        if (
            !Array.isArray(data) ||
            data.length !== 3 ||
            data[0] !== scopeValue ||
            typeof data[1] !== 'string' ||
            typeof data[2] !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(data[2])
        )
            throw new Error();
        const key = { date: civilDate(data[1]), id: data[2] };
        if (encode(scopeValue, key) !== value) throw new Error();
        return key;
    } catch {
        throw new FinancesError('VALIDATION_ERROR', ['cursor']);
    }
}

@Injectable()
export class ListPlannedExpensesQuery {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
        private readonly managers: EntityManagerProvider,
    ) {}

    async execute(
        actor: PersonId,
        space: SpaceId,
        month: string,
        cursor?: string,
    ) {
        const bounds = financialMonth(month);
        await this.access.assertCanRead(actor, space);
        const cursorScope = scope(actor, space, month);
        const after = decode(cursor, cursorScope);
        type Row = {
            items: {
                id: string;
                description: string;
                amountInCents: string;
                expectedPaymentDate: string;
                paidAmountInCents: string;
                assumedAmountInCents: string;
                remainingAmountInCents: string;
                version: number;
                registeredAt: string;
                createdByPersonId: string;
                ownerPersonId: string | null;
            }[];
            expected: string;
            remaining: string;
        };
        const [result]: Row[] = await this.managers.readSnapshot(() =>
            this.managers.get().query(
                `WITH planned AS MATERIALIZED (
                    SELECT c.id,c.description,c.version,c.registered_at,c.created_by,c.personal_owner_person_id,
                        v.amount_in_cents,v.expected_payment_date,
                        COALESCE((SELECT SUM(d.amount_in_cents) FROM financial_disbursements d WHERE d.space_id=c.space_id AND d.commitment_id=c.id),0) AS paid,
                        COALESCE((SELECT SUM(l.amount_in_cents) FROM financial_external_liabilities l WHERE l.space_id=c.space_id AND l.commitment_id=c.id),0) AS assumed
                    FROM financial_commitments c JOIN financial_commitment_versions v
                        ON v.space_id=c.space_id AND v.commitment_id=c.id AND v.version=1
                    WHERE c.space_id=$1 AND c.kind='EXPENSE' AND c.modality='ONE_TIME'
                        AND v.expected_payment_date >= $2::date AND v.expected_payment_date < $3::date
                ), page AS (
                    SELECT id,description,version,registered_at,created_by,personal_owner_person_id,
                        amount_in_cents,expected_payment_date,paid,assumed,
                        amount_in_cents-paid-assumed AS remaining
                    FROM planned
                    WHERE ($4::date IS NULL OR (expected_payment_date,id)>($4::date,$5::uuid))
                    ORDER BY expected_payment_date,id LIMIT 21
                ) SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object(
                    'id',id,'description',description,'version',version,
                    'registeredAt',to_char(registered_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                    'createdByPersonId',created_by,'ownerPersonId',personal_owner_person_id,
                    'amountInCents',amount_in_cents::text,'expectedPaymentDate',expected_payment_date::text,
                    'paidAmountInCents',paid::text,'assumedAmountInCents',assumed::text,
                    'remainingAmountInCents',remaining::text
                ) ORDER BY expected_payment_date,id) FROM page),'[]'::jsonb) AS items,
                COALESCE((SELECT SUM(amount_in_cents) FROM planned),0)::text AS expected,
                COALESCE((SELECT SUM(amount_in_cents-paid-assumed) FROM planned),0)::text AS remaining`,
                [
                    space.value,
                    bounds.start,
                    bounds.end,
                    after?.date ?? null,
                    after?.id ?? null,
                ],
            ),
        );
        await this.access.assertCanRead(actor, space);
        const items = result.items.slice(0, 20).map((row) => ({
            ...row,
            amountInCents: Number(row.amountInCents),
            paidAmountInCents: Number(row.paidAmountInCents),
            assumedAmountInCents: Number(row.assumedAmountInCents),
            remainingAmountInCents: Number(row.remainingAmountInCents),
            status:
                Number(row.remainingAmountInCents) === 0
                    ? 'FULFILLED'
                    : Number(row.paidAmountInCents) +
                            Number(row.assumedAmountInCents) ===
                        0
                      ? 'PENDING'
                      : 'PARTIALLY_FULFILLED',
            overdue:
                row.expectedPaymentDate < this.clock.today() &&
                Number(row.remainingAmountInCents) > 0,
        }));
        const last = items.at(-1);
        return {
            spaceId: space.value,
            month,
            items,
            totals: {
                expectedExpenseAmountInCents: result.expected,
                remainingExpenseAmountInCents: result.remaining,
            },
            nextCursor:
                result.items.length > 20 && last
                    ? encode(cursorScope, {
                          date: last.expectedPaymentDate,
                          id: last.id,
                      })
                    : null,
        };
    }
}
