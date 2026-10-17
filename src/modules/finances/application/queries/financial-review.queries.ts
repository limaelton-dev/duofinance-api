import { Inject, Injectable } from '@nestjs/common';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../../spaces/application/ports/public/space-access.port.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import type {
    FinancialReviewContext,
    FinancialReviewKey,
    FinancialReviewScope,
    FinancialReviewView,
} from '../models/financial-review.js';
import {
    FINANCIAL_REVIEW_READER,
    type FinancialReviewReader,
} from '../ports/private/financial-review-reader.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';

export function financialMonth(month: string) {
    if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month))
        throw new FinancesError('VALIDATION_ERROR', ['month']);
    const year = Number(month.slice(0, 4)),
        value = Number(month.slice(5));
    return {
        start: `${month}-01`,
        end:
            value === 12
                ? `${String(year + 1).padStart(4, '0')}-01-01`
                : `${month.slice(0, 4)}-${String(value + 1).padStart(2, '0')}-01`,
    };
}
export function encodeReviewCursor(scope: string, key: FinancialReviewKey) {
    return Buffer.from(
        JSON.stringify([
            1,
            scope,
            key.relevantDate,
            key.registeredAt,
            key.type,
            key.id,
        ]),
    ).toString('base64url');
}
export function decodeReviewCursor(
    cursor: string | undefined,
    scope: string,
): FinancialReviewKey | null {
    if (cursor === undefined) return null;
    try {
        if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
            throw new Error();
        const values: unknown = JSON.parse(
            Buffer.from(cursor, 'base64url').toString('utf8'),
        );
        if (
            !Array.isArray(values) ||
            values.length !== 6 ||
            values[0] !== 1 ||
            values[1] !== scope ||
            values.slice(2).some((v) => typeof v !== 'string')
        )
            throw new Error();
        const [, , relevantDate, registeredAt, type, id] = values as string[];
        civilDate(relevantDate);
        if (
            !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/.test(
                registeredAt,
            ) ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
                id,
            ) ||
            ![
                'EXPENSE',
                'EXPECTED_INCOME',
                'EXPECTED_EXPENSE',
                'DISBURSEMENT',
                'RECEIPT',
                'EXTERNAL_LIABILITY',
                'EXTERNAL_SETTLEMENT',
                'INTERNAL_TRANSFER',
                'INTERNAL_OFFSET',
                'INTERNAL_WAIVER',
                'INTERNAL_REVERSAL',
            ].includes(type)
        )
            throw new Error();
        civilDate(registeredAt.slice(0, 10));
        const key = {
            relevantDate,
            registeredAt,
            type: type as FinancialReviewKey['type'],
            id,
        };
        if (encodeReviewCursor(scope, key) !== cursor) throw new Error();
        return key;
    } catch {
        throw new FinancesError('VALIDATION_ERROR', ['cursor']);
    }
}
@Injectable()
export class FinancialReviewQueries {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(FINANCIAL_REVIEW_READER)
        private readonly reader: FinancialReviewReader,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    private async authorize(
        actor: PersonId,
        space: SpaceId,
        memberId?: string,
    ) {
        const access = await this.access.assertCanRead(actor, space);
        const context =
            access.type === 'SHARED'
                ? await this.context.read(actor, space)
                : null;
        if (
            memberId !== undefined &&
            (!context || !context.members.some((m) => m.memberId === memberId))
        )
            throw new FinancesError('VALIDATION_ERROR', ['memberId']);
        return { access, members: context?.members ?? [] };
    }
    async execute(
        actor: PersonId,
        space: SpaceId,
        operation: 'timeline' | 'forecast' | 'overview',
        month: string,
        memberId?: string,
        cursor?: string,
        view: FinancialReviewView = 'HISTORY',
    ) {
        const bounds = financialMonth(month);
        memberId = memberId?.toLowerCase();
        const authorized = await this.authorize(actor, space, memberId);
        const referenceDate = this.clock.today();
        const scope: FinancialReviewScope = {
            spaceId: space.value,
            month,
            ...bounds,
            referenceDate,
            memberId: memberId ?? null,
        };
        const common: FinancialReviewContext = {
            spaceId: space.value,
            spaceType: authorized.access.type,
            month,
            referenceDate,
            memberId: scope.memberId,
            members: authorized.members,
        };
        if (operation === 'overview') {
            const result = await this.reader.overview(scope);
            await this.authorize(actor, space, memberId);
            return { ...common, ...result };
        }
        const cursorScope = `${actor.value}:${space.value}:${operation}:${view}:${month}:${memberId ?? ''}`;
        const after = decodeReviewCursor(cursor, cursorScope);
        const result =
            operation === 'timeline'
                ? { items: await this.reader.timeline(scope, after) }
                : await this.reader.forecast(scope, after);
        await this.authorize(actor, space, memberId);
        const items = result.items.slice(0, 20),
            last = items.at(-1);
        return {
            ...common,
            ...(operation === 'timeline' ? { view } : {}),
            ...result,
            items,
            nextCursor:
                result.items.length > 20 && last
                    ? encodeReviewCursor(cursorScope, last)
                    : null,
        };
    }
}
