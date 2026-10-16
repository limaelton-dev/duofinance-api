import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import type {
    PositionDirection,
    PositionKey,
} from '../models/inter-member-position.js';
import type {
    SettlementCycleDetail,
    SettlementCycleKey,
    SettlementCycleResponse,
    SettlementCyclesResponse,
    SettlementCycleView,
    SelectedSettlementCyclesResponse,
} from '../models/settlement-cycle.js';
import {
    SETTLEMENT_CYCLE_READER,
    type SettlementCycleReader,
    type SettlementCycleRead,
} from '../ports/private/settlement-cycle-reader.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import type { SettlementCycleQueryPort } from '../ports/public/settlement-cycle-query.port.js';
import { positionSummary } from './inter-member-position.query.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const encode = (value: unknown[]) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(cursor: string): unknown[] {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor))
        throw new Error();
    const value: unknown = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (!Array.isArray(value) || encode(value) !== cursor) throw new Error();
    return value;
}
export function encodeSettlementListCursor(
    space: string,
    actor: string,
    view: SettlementCycleView,
    referenceDate: string,
    key: SettlementCycleKey,
): string {
    return encode([
        1,
        'SETTLEMENT_LIST',
        space,
        actor,
        view,
        view === 'UPCOMING' || view === 'OVERDUE' ? referenceDate : null,
        key.targetDate,
        key.id,
    ]);
}
export function decodeSettlementListCursor(
    cursor: string | undefined,
    space: string,
    actor: string,
    view: SettlementCycleView,
    referenceDate: string,
): SettlementCycleKey | null {
    if (cursor === undefined) return null;
    try {
        const v = decode(cursor);
        if (
            v.length !== 8 ||
            v[0] !== 1 ||
            v[1] !== 'SETTLEMENT_LIST' ||
            v[2] !== space ||
            v[3] !== actor ||
            v[4] !== view ||
            v[5] !==
                (view === 'UPCOMING' || view === 'OVERDUE'
                    ? referenceDate
                    : null) ||
            typeof v[6] !== 'string' ||
            typeof v[7] !== 'string' ||
            !uuid.test(v[7])
        )
            throw new Error();
        return { targetDate: civilDate(v[6]), id: v[7] };
    } catch {
        throw new FinancesError('VALIDATION_ERROR', ['cursor']);
    }
}
export function encodeSettlementDetailCursor(
    space: string,
    actor: string,
    cycleId: string,
    direction: PositionDirection,
    key: PositionKey,
): string {
    return encode([
        1,
        'SETTLEMENT_DETAIL',
        space,
        actor,
        cycleId,
        direction,
        key.registeredAt,
        key.id,
    ]);
}
export function decodeSettlementDetailCursor(
    cursor: string | undefined,
    space: string,
    actor: string,
    cycleId: string,
    direction: PositionDirection,
): PositionKey | null {
    if (cursor === undefined) return null;
    try {
        const v = decode(cursor);
        if (
            v.length !== 8 ||
            v[0] !== 1 ||
            v[1] !== 'SETTLEMENT_DETAIL' ||
            v[2] !== space ||
            v[3] !== actor ||
            v[4] !== cycleId ||
            v[5] !== direction ||
            typeof v[6] !== 'string' ||
            typeof v[7] !== 'string' ||
            !uuid.test(v[7]) ||
            !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/.test(
                v[6],
            )
        )
            throw new Error();
        civilDate(v[6].slice(0, 10));
        return { registeredAt: v[6], id: v[7] };
    } catch {
        throw new FinancesError('VALIDATION_ERROR', ['cursor']);
    }
}
export function settlementCycleSummary(
    result: SettlementCycleRead,
    referenceDate: string,
): SettlementCycleDetail {
    const { payableAmountInCents, receivableAmountInCents, ...cycle } = result;
    return {
        ...cycle,
        isOverdue:
            cycle.status === 'OPEN' &&
            cycle.targetDate < referenceDate &&
            BigInt(cycle.totals.remainingAmountInCents) > 0n,
        position: positionSummary(
            payableAmountInCents,
            receivableAmountInCents,
        ),
    };
}
@Injectable()
export class GetSettlementCyclesQuery implements SettlementCycleQueryPort {
    constructor(
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly access: SpaceFinancialContextPort,
        @Inject(SETTLEMENT_CYCLE_READER)
        private readonly reader: SettlementCycleReader,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    upcoming(actor: PersonId, space: SpaceId, cursor?: string) {
        return this.execute(actor, space, 'UPCOMING', cursor);
    }
    async execute(
        actor: PersonId,
        space: SpaceId,
        view: SettlementCycleView = 'OPEN',
        cursor?: string,
    ): Promise<SettlementCyclesResponse> {
        const authorized = await this.access.read(actor, space);
        if (!['OPEN', 'UPCOMING', 'OVERDUE', 'FINALIZED'].includes(view))
            throw new FinancesError('VALIDATION_ERROR', ['view']);
        const referenceDate = civilDate(this.clock.today());
        const after = decodeSettlementListCursor(
            cursor,
            space.value,
            actor.value,
            view,
            referenceDate,
        );
        const result = await this.reader.list(
            space.value,
            authorized.actorMemberId,
            view,
            referenceDate,
            after,
        );
        const context = await this.access.read(actor, space);
        const items = result.slice(0, 20).map((row) => {
            const { finalizedAt: _, ...cycle } = settlementCycleSummary(
                row,
                referenceDate,
            );
            return cycle;
        });
        const last = items.at(-1);
        return {
            spaceId: space.value,
            spaceStatus: context.status,
            actorMemberId: context.actorMemberId,
            members: context.members,
            referenceDate,
            items,
            page: {
                view,
                pageSize: 20,
                nextCursor:
                    result.length > 20 && last
                        ? encodeSettlementListCursor(
                              space.value,
                              actor.value,
                              view,
                              referenceDate,
                              last,
                          )
                        : null,
            },
        };
    }
}
@Injectable()
export class GetSelectedSettlementCyclesQuery {
    constructor(
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly access: SpaceFinancialContextPort,
        @Inject(SETTLEMENT_CYCLE_READER)
        private readonly reader: SettlementCycleReader,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    async execute(
        actor: PersonId,
        space: SpaceId,
        input: string[],
        direction: PositionDirection = 'ALL',
        cursor?: string,
    ): Promise<SelectedSettlementCyclesResponse> {
        const authorized = await this.access.read(actor, space);
        const ids = input.map((id) => id.toLowerCase()).sort();
        if (
            ids.length < 2 ||
            ids.length > 50 ||
            new Set(ids).size !== ids.length ||
            ids.some((id) => !uuid.test(id))
        )
            throw new FinancesError('VALIDATION_ERROR', ['cycleIds']);
        if (!['ALL', 'PAYABLE', 'RECEIVABLE'].includes(direction))
            throw new FinancesError('VALIDATION_ERROR', ['direction']);
        const binding =
            'SUMMARY:' +
            createHash('sha256').update(JSON.stringify(ids)).digest('hex');
        const after = decodeSettlementDetailCursor(
            cursor,
            space.value,
            actor.value,
            binding,
            direction,
        );
        const referenceDate = civilDate(this.clock.today());
        const result = await this.reader.summary(
            space.value,
            authorized.actorMemberId,
            ids,
            direction,
            after,
        );
        const context = await this.access.read(actor, space);
        const items = result.items.slice(0, 20),
            last = items.at(-1);
        return {
            spaceId: space.value,
            spaceStatus: context.status,
            actorMemberId: context.actorMemberId,
            members: context.members,
            referenceDate,
            selectedCycles: result.cycles.map((row) => ({
                ...settlementCycleSummary(row, referenceDate),
                readOnly:
                    row.status === 'FINALIZED' || context.status === 'CLOSED',
            })),
            totals: result.totals,
            position: positionSummary(
                result.payableAmountInCents,
                result.receivableAmountInCents,
            ),
            items,
            page: {
                direction,
                pageSize: 20,
                nextCursor:
                    result.items.length > 20 && last
                        ? encodeSettlementDetailCursor(
                              space.value,
                              actor.value,
                              binding,
                              direction,
                              last,
                          )
                        : null,
            },
        };
    }
}
@Injectable()
export class GetSettlementCycleQuery {
    constructor(
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly access: SpaceFinancialContextPort,
        @Inject(SETTLEMENT_CYCLE_READER)
        private readonly reader: SettlementCycleReader,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    async execute(
        actor: PersonId,
        space: SpaceId,
        cycleId: string,
        direction: PositionDirection = 'ALL',
        cursor?: string,
    ): Promise<SettlementCycleResponse> {
        const authorized = await this.access.read(actor, space);
        if (!uuid.test(cycleId))
            throw new FinancesError('VALIDATION_ERROR', ['cycleId']);
        if (!['ALL', 'PAYABLE', 'RECEIVABLE'].includes(direction))
            throw new FinancesError('VALIDATION_ERROR', ['direction']);
        const referenceDate = civilDate(this.clock.today());
        const after = decodeSettlementDetailCursor(
            cursor,
            space.value,
            actor.value,
            cycleId,
            direction,
        );
        const result = await this.reader.detail(
            space.value,
            authorized.actorMemberId,
            cycleId,
            direction,
            after,
        );
        const context = await this.access.read(actor, space);
        if (!result) throw new FinancesError('SETTLEMENT_CYCLE_NOT_FOUND');
        const items = result.items.slice(0, 20),
            last = items.at(-1);
        return {
            spaceId: space.value,
            spaceStatus: context.status,
            actorMemberId: context.actorMemberId,
            members: context.members,
            referenceDate,
            cycle: {
                ...settlementCycleSummary(result.cycle, referenceDate),
                canFinalize:
                    context.status !== 'CLOSED' &&
                    result.cycle.status === 'OPEN' &&
                    result.cycle.openObligationCount === 0,
                finalizationBlockReason:
                    context.status === 'CLOSED'
                        ? 'SPACE_CLOSED'
                        : result.cycle.status === 'FINALIZED'
                          ? 'SETTLEMENT_CYCLE_FINALIZED'
                          : result.cycle.openObligationCount > 0
                            ? 'OPEN_OBLIGATIONS'
                            : null,
            },
            items,
            page: {
                direction,
                pageSize: 20,
                nextCursor:
                    result.items.length > 20 && last
                        ? encodeSettlementDetailCursor(
                              space.value,
                              actor.value,
                              cycleId,
                              direction,
                              last,
                          )
                        : null,
            },
        };
    }
}
