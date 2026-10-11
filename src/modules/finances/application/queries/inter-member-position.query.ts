import { Inject, Injectable } from '@nestjs/common';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import type {
    InterMemberPositionView,
    PositionDirection,
    PositionKey,
    PositionSummary,
} from '../models/inter-member-position.js';
import {
    INTER_MEMBER_POSITION_READER,
    type InterMemberPositionReader,
} from '../ports/private/inter-member-position-reader.js';
export function positionSummary(
    payable: string,
    receivable: string,
): PositionSummary {
    const difference = BigInt(payable) - BigInt(receivable);
    return {
        payableAmountInCents: payable,
        receivableAmountInCents: receivable,
        net: {
            direction:
                difference > 0n
                    ? 'PAYABLE'
                    : difference < 0n
                      ? 'RECEIVABLE'
                      : 'BALANCED',
            amountInCents: (difference < 0n
                ? -difference
                : difference
            ).toString(),
        },
    };
}
export function encodePositionCursor(
    space: string,
    actor: string,
    direction: PositionDirection,
    key: PositionKey,
): string {
    return Buffer.from(
        JSON.stringify([1, space, actor, direction, key.registeredAt, key.id]),
    ).toString('base64url');
}
export function decodePositionCursor(
    cursor: string | undefined,
    space: string,
    actor: string,
    direction: PositionDirection,
): PositionKey | null {
    if (cursor === undefined) return null;
    try {
        if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor))
            throw new Error();
        const value: unknown = JSON.parse(
            Buffer.from(cursor, 'base64url').toString('utf8'),
        );
        if (
            !Array.isArray(value) ||
            value.length !== 6 ||
            value[0] !== 1 ||
            value[1] !== space ||
            value[2] !== actor ||
            value[3] !== direction ||
            typeof value[4] !== 'string' ||
            typeof value[5] !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/.test(
                value[4],
            ) ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
                value[5],
            )
        )
            throw new Error();
        civilDate(value[4].slice(0, 10));
        const key = { registeredAt: value[4], id: value[5] };
        if (encodePositionCursor(space, actor, direction, key) !== cursor)
            throw new Error();
        return key;
    } catch {
        throw new FinancesError('VALIDATION_ERROR', ['cursor']);
    }
}
@Injectable()
export class GetInterMemberPositionQuery {
    constructor(
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly access: SpaceFinancialContextPort,
        @Inject(INTER_MEMBER_POSITION_READER)
        private readonly reader: InterMemberPositionReader,
    ) {}
    async execute(
        actor: PersonId,
        space: SpaceId,
        direction: PositionDirection = 'ALL',
        cursor?: string,
    ): Promise<InterMemberPositionView> {
        const authorized = await this.access.read(actor, space);
        const after = decodePositionCursor(
            cursor,
            space.value,
            actor.value,
            direction,
        );
        const result = await this.reader.read(
            space.value,
            authorized.actorMemberId,
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
            scope: 'OPEN_OBLIGATIONS',
            summary: positionSummary(
                result.payableAmountInCents,
                result.receivableAmountInCents,
            ),
            items,
            page: {
                direction,
                pageSize: 20,
                nextCursor:
                    result.items.length > 20 && last
                        ? encodePositionCursor(
                              space.value,
                              actor.value,
                              direction,
                              last,
                          )
                        : null,
            },
        };
    }
}
