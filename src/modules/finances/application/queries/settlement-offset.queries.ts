import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import type { PositionDirection } from '../models/inter-member-position.js';
import type { SettlementOffsetScope } from '../models/settlement-offset.js';
import {
    SETTLEMENT_OFFSET_REPOSITORY,
    type SettlementOffsetRepository,
} from '../ports/private/settlement-offset.repository.js';
import {
    SETTLEMENT_TRANSFER_REPOSITORY,
    type SettlementTransferRepository,
} from '../ports/private/settlement-transfer.repository.js';
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import { validateOffsetScope } from '../handlers/record-settlement-offset.handler.js';
import {
    encodeSettlementDetailCursor,
    decodeSettlementDetailCursor,
} from './settlement-cycle.queries.js';
function binding(type: string, value: unknown) {
    return (
        type +
        ':' +
        createHash('sha256').update(JSON.stringify(value)).digest('hex')
    );
}
@Injectable()
export class SettlementOffsetQueries {
    constructor(
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly access: SpaceFinancialContextPort,
        @Inject(SETTLEMENT_OFFSET_REPOSITORY)
        private readonly offsets: SettlementOffsetRepository,
        @Inject(SETTLEMENT_TRANSFER_REPOSITORY)
        private readonly references: SettlementTransferRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    async options(
        actor: PersonId,
        space: SpaceId,
        scope: SettlementOffsetScope,
        direction: PositionDirection = 'ALL',
        cursor?: string,
    ) {
        const authorized = await this.access.read(actor, space);
        validateOffsetScope(scope);
        if (!['ALL', 'PAYABLE', 'RECEIVABLE'].includes(direction))
            throw new FinancesError('VALIDATION_ERROR', ['direction']);
        const canonical = {
            cycleIds: [...scope.cycleIds].sort(),
            obligationIds: [...scope.obligationIds].sort(),
        };
        const key = binding('OFFSET_OPTIONS', canonical);
        const after = decodeSettlementDetailCursor(
            cursor,
            space.value,
            actor.value,
            key,
            direction,
        );
        const data = await this.offsets.options(
            space.value,
            authorized.actorMemberId,
            canonical,
            direction,
            after,
        );
        const context = await this.access.read(actor, space);
        const min = (...v: bigint[]) => v.reduce((a, b) => (a < b ? a : b));
        const maximum = min(
            BigInt(data.payable),
            BigInt(data.receivable),
            BigInt(Number.MAX_SAFE_INTEGER),
        );
        const payable = data.previewCandidates.filter(
                (o) => o.debtorMemberId === context.actorMemberId,
            ),
            receivable = data.previewCandidates.filter(
                (o) => o.creditorMemberId === context.actorMemberId,
            );
        const previewAmount = min(
            maximum,
            payable.reduce(
                (sum, o) => sum + BigInt(o.remainingAmountInCents),
                0n,
            ),
            receivable.reduce(
                (sum, o) => sum + BigInt(o.remainingAmountInCents),
                0n,
            ),
        );
        const allocations = [payable, receivable].flatMap((items) => {
            let remaining = previewAmount;
            return items.flatMap((o) => {
                const amount = min(remaining, BigInt(o.remainingAmountInCents));
                remaining -= amount;
                return amount === 0n
                    ? []
                    : [
                          {
                              obligationId: o.id,
                              expectedObligationVersion: o.version,
                              amountInCents: Number(amount),
                          },
                      ];
            });
        });
        const reason =
            context.status === 'CLOSED'
                ? 'SPACE_CLOSED'
                : data.cycles.some((c) => c.status === 'FINALIZED')
                  ? 'SETTLEMENT_CYCLE_FINALIZED'
                  : maximum === 0n
                    ? 'NO_RECIPROCAL_OBLIGATIONS'
                    : null;
        const items = data.items.slice(0, 20),
            last = items.at(-1);
        return {
            spaceId: space.value,
            spaceStatus: context.status,
            spaceVersion: context.version,
            actorMemberId: context.actorMemberId,
            members: context.members,
            referenceDate: this.clock.today(),
            canRecord: reason === null,
            scope: canonical,
            cycles: data.cycles,
            maximumAmountInCents: maximum.toString(),
            reason,
            items,
            preview: {
                amountInCents: previewAmount.toString(),
                allocations,
                complete: previewAmount === maximum,
            },
            page: {
                direction,
                pageSize: 20 as const,
                nextCursor:
                    data.items.length > 20 && last
                        ? encodeSettlementDetailCursor(
                              space.value,
                              actor.value,
                              key,
                              direction,
                              last,
                          )
                        : null,
            },
        };
    }
    async detail(actor: PersonId, space: SpaceId, id: string) {
        await this.access.read(actor, space);
        const result = await this.offsets.detail(space.value, id);
        await this.access.read(actor, space);
        if (!result) throw new FinancesError('SETTLEMENT_OFFSET_NOT_FOUND');
        return result;
    }
    async history(
        actor: PersonId,
        space: SpaceId,
        cycleId: string | null = null,
        obligationId: string | null = null,
        cursor?: string,
    ) {
        await this.access.read(actor, space);
        if (cycleId && !(await this.references.hasCycle(space.value, cycleId)))
            throw new FinancesError('SETTLEMENT_CYCLE_NOT_FOUND');
        if (
            obligationId &&
            !(await this.references.hasObligation(space.value, obligationId))
        )
            throw new FinancesError('INTER_MEMBER_OBLIGATION_NOT_FOUND');
        const key = binding('OFFSET_HISTORY', [cycleId, obligationId]);
        const rows = await this.offsets.history(
            space.value,
            cycleId,
            obligationId,
            decodeSettlementDetailCursor(
                cursor,
                space.value,
                actor.value,
                key,
                'ALL',
            ),
        );
        await this.access.read(actor, space);
        const items = rows.slice(0, 20),
            last = items.at(-1);
        return {
            spaceId: space.value,
            items,
            page: {
                cycleId,
                obligationId,
                pageSize: 20 as const,
                nextCursor:
                    rows.length > 20 && last
                        ? encodeSettlementDetailCursor(
                              space.value,
                              actor.value,
                              key,
                              'ALL',
                              last.offset,
                          )
                        : null,
            },
        };
    }
}
