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
import {
    FINANCES_CLOCK,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import {
    EXTERNAL_LIABILITY_SETTLEMENT_REPOSITORY,
    type ExternalLiabilitySettlementRepository,
} from '../ports/private/external-liability-settlement.ports.js';
import {
    decodeExpenseCursor,
    encodeExpenseCursor,
} from './shared-cash-expense.queries.js';
@Injectable()
export class ExternalLiabilityQueries {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(EXTERNAL_LIABILITY_SETTLEMENT_REPOSITORY)
        private readonly settlements: ExternalLiabilitySettlementRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    private async authorized(actor: PersonId, space: SpaceId) {
        const access = await this.access.assertCanRead(actor, space);
        const context =
            access.type === 'SHARED'
                ? await this.context.read(actor, space)
                : null;
        return {
            access,
            context,
            common: {
                spaceId: space.value,
                spaceType: access.type,
                referenceDate: this.clock.today(),
                ...(context ? { expectedSpaceVersion: context.version } : {}),
                canSettle:
                    access.type === 'PERSONAL'
                        ? access.status === 'ACTIVE'
                        : access.status !== 'CLOSED',
            },
        };
    }
    async list(actor: PersonId, space: SpaceId, cursor?: string) {
        const { context, common } = await this.authorized(actor, space);
        const scope = `${space.value}:${actor.value}:external-liabilities`;
        const rows = await this.settlements.listOpen(
            space.value,
            context
                ? { memberId: context.actorMemberId }
                : { personId: actor.value },
            decodeExpenseCursor(cursor, scope),
        );
        const items = rows.slice(0, 20),
            last = items.at(-1);
        await this.authorized(actor, space);
        return {
            ...common,
            items,
            nextCursor:
                rows.length > 20 && last
                    ? encodeExpenseCursor(
                          scope,
                          last.externalLiability.factDate,
                          last.externalLiability.id,
                      )
                    : null,
        };
    }
    async options(
        actor: PersonId,
        space: SpaceId,
        commitmentId: string,
        externalLiabilityId: string,
    ) {
        const { access, context, common } = await this.authorized(actor, space);
        const detail = await this.settlements.findDetail(
            space.value,
            commitmentId,
            externalLiabilityId,
        );
        if (!detail) throw new FinancesError('EXTERNAL_LIABILITY_NOT_FOUND');
        const { externalLiability } = detail;
        if (
            (access.type === 'SHARED') !==
            'holderMemberId' in externalLiability
        )
            throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const own =
            'holderMemberId' in externalLiability
                ? externalLiability.holderMemberId === context?.actorMemberId
                : externalLiability.holderPersonId === actor.value;
        await this.authorized(actor, space);
        return {
            ...common,
            commitmentId,
            description: detail.description,
            expectedCommitmentVersion: detail.commitmentVersion,
            externalLiability,
            canSettle:
                common.canSettle &&
                own &&
                externalLiability.remainingAmountInCents > 0,
        };
    }
}
