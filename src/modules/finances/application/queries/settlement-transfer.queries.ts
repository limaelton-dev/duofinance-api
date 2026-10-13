import { Inject, Injectable } from '@nestjs/common';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import type { PositionKey } from '../models/inter-member-position.js';
import {
    SETTLEMENT_TRANSFER_REPOSITORY,
    type SettlementTransferRepository,
} from '../ports/private/settlement-transfer.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import { positionSummary } from './inter-member-position.query.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function cursor(
    space: string,
    actor: string,
    type: string,
    filters: (string | null)[],
    key: PositionKey,
) {
    return Buffer.from(
        JSON.stringify([
            1,
            space,
            actor,
            type,
            ...filters,
            key.registeredAt,
            key.id,
        ]),
    ).toString('base64url');
}
function decode(
    input: string | undefined,
    space: string,
    actor: string,
    type: string,
    filters: (string | null)[],
): PositionKey | null {
    if (input === undefined) return null;
    try {
        if (input.length > 512 || !/^[A-Za-z0-9_-]+$/.test(input))
            throw new Error();
        const value: unknown = JSON.parse(
            Buffer.from(input, 'base64url').toString('utf8'),
        );
        if (
            !Array.isArray(value) ||
            value.length !== 6 + filters.length ||
            value[0] !== 1 ||
            value[1] !== space ||
            value[2] !== actor ||
            value[3] !== type ||
            filters.some((f, i) => f !== value[4 + i])
        )
            throw new Error();
        const at = value[4 + filters.length],
            id = value[5 + filters.length];
        if (
            typeof at !== 'string' ||
            typeof id !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/.test(
                at,
            ) ||
            !uuid.test(id)
        )
            throw new Error();
        const key = { registeredAt: at, id };
        if (cursor(space, actor, type, filters, key) !== input)
            throw new Error();
        return key;
    } catch {
        throw new FinancesError('VALIDATION_ERROR', ['cursor']);
    }
}
@Injectable()
export class GetSettlementTransferOptionsQuery {
    constructor(
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly access: SpaceFinancialContextPort,
        @Inject(SETTLEMENT_TRANSFER_REPOSITORY)
        private readonly repo: SettlementTransferRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    async execute(
        actor: PersonId,
        space: SpaceId,
        direction: 'PAYABLE' | 'RECEIVABLE' = 'PAYABLE',
        cycleId: string | null = null,
        cursorValue?: string,
    ) {
        const authorized = await this.access.read(actor, space);
        if (!['PAYABLE', 'RECEIVABLE'].includes(direction))
            throw new FinancesError('VALIDATION_ERROR', ['direction']);
        if (
            cycleId &&
            (!uuid.test(cycleId) ||
                !(await this.repo.hasCycle(space.value, cycleId)))
        )
            throw new FinancesError('SETTLEMENT_CYCLE_NOT_FOUND');
        const after = decode(
            cursorValue,
            space.value,
            actor.value,
            'TRANSFER_OPTIONS',
            [direction, cycleId],
        );
        const result = await this.repo.options(
            space.value,
            authorized.actorMemberId,
            direction,
            cycleId,
            after,
        );
        const context = await this.access.read(actor, space);
        const items = result.items.slice(0, 20),
            last = items.at(-1);
        return {
            spaceId: space.value,
            spaceStatus: context.status,
            spaceVersion: context.version,
            actorMemberId: context.actorMemberId,
            members: context.members,
            referenceDate: this.clock.today(),
            canRecord:
                context.status === 'ACTIVE' || context.status === 'CLOSING',
            summary: positionSummary(result.payable, result.receivable),
            items,
            page: {
                direction,
                cycleId,
                pageSize: 20 as const,
                nextCursor:
                    result.items.length > 20 && last
                        ? cursor(
                              space.value,
                              actor.value,
                              'TRANSFER_OPTIONS',
                              [direction, cycleId],
                              last,
                          )
                        : null,
            },
        };
    }
}
@Injectable()
export class GetSettlementTransferQuery {
    constructor(
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly access: SpaceFinancialContextPort,
        @Inject(SETTLEMENT_TRANSFER_REPOSITORY)
        private readonly repo: SettlementTransferRepository,
    ) {}
    async execute(actor: PersonId, space: SpaceId, id: string) {
        await this.access.read(actor, space);
        if (!uuid.test(id))
            throw new FinancesError('VALIDATION_ERROR', ['transferId']);
        const result = await this.repo.detail(space.value, id);
        const context = await this.access.read(actor, space);
        if (!result) throw new FinancesError('SETTLEMENT_TRANSFER_NOT_FOUND');
        return {
            ...result,
            spaceStatus: context.status,
            actorMemberId: context.actorMemberId,
            members: context.members,
        };
    }
}
@Injectable()
export class ListSettlementTransfersQuery {
    constructor(
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly access: SpaceFinancialContextPort,
        @Inject(SETTLEMENT_TRANSFER_REPOSITORY)
        private readonly repo: SettlementTransferRepository,
    ) {}
    async execute(
        actor: PersonId,
        space: SpaceId,
        cycleId: string | null = null,
        obligationId: string | null = null,
        cursorValue?: string,
    ) {
        await this.access.read(actor, space);
        if (
            cycleId &&
            (!uuid.test(cycleId) ||
                !(await this.repo.hasCycle(space.value, cycleId)))
        )
            throw new FinancesError('SETTLEMENT_CYCLE_NOT_FOUND');
        if (
            obligationId &&
            (!uuid.test(obligationId) ||
                !(await this.repo.hasObligation(space.value, obligationId)))
        )
            throw new FinancesError('INTER_MEMBER_OBLIGATION_NOT_FOUND');
        const after = decode(
            cursorValue,
            space.value,
            actor.value,
            'TRANSFER_HISTORY',
            [cycleId, obligationId],
        );
        const result = await this.repo.history(
            space.value,
            cycleId,
            obligationId,
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
            items,
            page: {
                cycleId,
                obligationId,
                pageSize: 20 as const,
                nextCursor:
                    result.items.length > 20 && last
                        ? cursor(
                              space.value,
                              actor.value,
                              'TRANSFER_HISTORY',
                              [cycleId, obligationId],
                              {
                                  registeredAt: last.transfer.registeredAt,
                                  id: last.transfer.id,
                              },
                          )
                        : null,
            },
        };
    }
}
