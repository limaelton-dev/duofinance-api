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
import { SettlementRule } from '../../domain/settlement-rule/settlement-rule.js';
import {
    SETTLEMENT_ADJUSTMENT_REPOSITORY,
    type SettlementAdjustmentRepository,
} from '../ports/private/settlement-adjustment.repository.js';
import {
    INSTALLMENT_COMMITMENT_REPOSITORY,
    type InstallmentCommitmentRepository,
} from '../ports/private/installment-commitment.repository.js';
import {
    FINANCES_CLOCK,
    SETTLEMENT_CYCLE_REPOSITORY,
    type FinancesClock,
    type SettlementCycleRepository,
} from '../ports/private/shared-expense.repositories.js';
import { rootView, installmentView } from './installment-commitment.models.js';
@Injectable()
export class InstallmentCommitmentQueries {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(INSTALLMENT_COMMITMENT_REPOSITORY)
        private readonly repository: InstallmentCommitmentRepository,
        @Inject(SETTLEMENT_ADJUSTMENT_REPOSITORY)
        private readonly adjustments: SettlementAdjustmentRepository,
        @Inject(SETTLEMENT_CYCLE_REPOSITORY)
        private readonly cycles: SettlementCycleRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}

    async detail(actor: PersonId, space: SpaceId, id: string) {
        await this.access.assertCanRead(actor, space);
        const root = await this.repository.find(space.value, id);
        if (!root) throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        await this.access.assertCanRead(actor, space);
        return { commitment: rootView(root) };
    }

    async list(actor: PersonId, space: SpaceId, cursor?: string) {
        await this.access.assertCanRead(actor, space);
        let after: string | null = null;
        if (cursor)
            try {
                const value = JSON.parse(
                    Buffer.from(cursor, 'base64url').toString('utf8'),
                ) as [string, string, string];
                if (
                    !Array.isArray(value) ||
                    value.length !== 3 ||
                    value[0] !== actor.value ||
                    value[1] !== space.value ||
                    !/^[0-9a-f-]{36}$/.test(value[2]) ||
                    Buffer.from(JSON.stringify(value)).toString('base64url') !==
                        cursor
                )
                    throw new Error();
                after = value[2];
            } catch {
                throw new FinancesError('VALIDATION_ERROR', ['cursor']);
            }
        const result = await this.repository.list(space.value, after);
        await this.access.assertCanRead(actor, space);
        const items = result.items.slice(0, 20).map(rootView);
        const last = result.items.length > 20 ? items.at(-1) : null;
        return {
            spaceId: space.value,
            items,
            totalCount: result.totalCount,
            totalAmountInCents: result.totalAmountInCents,
            nextCursor: last
                ? Buffer.from(
                      JSON.stringify([actor.value, space.value, last.id]),
                  ).toString('base64url')
                : null,
        };
    }

    async installments(actor: PersonId, space: SpaceId, id: string) {
        await this.access.assertCanRead(actor, space);
        const root = await this.repository.find(space.value, id);
        if (!root) throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const items = [];
        for (const installment of root.plan.installments) {
            const occurrence = await this.repository.occurrence(
                root,
                installment.id,
            );
            items.push(installmentView(root, installment, occurrence));
        }
        await this.access.assertCanRead(actor, space);
        return {
            commitmentId: id,
            planId: root.plan.id,
            totalCount: items.length,
            items,
        };
    }

    async options(
        actor: PersonId,
        space: SpaceId,
        id: string,
        installmentId: string,
        cursor?: string,
    ) {
        const access = await this.access.assertCanRead(actor, space);
        const root = await this.repository.find(space.value, id);
        if (
            !root ||
            !root.plan.installments.some((item) => item.id === installmentId)
        )
            throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const occurrence = await this.repository.occurrence(
            root,
            installmentId,
        );
        if (!occurrence)
            throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const p = root.participation;
        const context =
            access.type === 'SHARED'
                ? await this.context.read(actor, space)
                : null;
        let after: { targetDate: string; id: string } | null = null;
        if (cursor)
            try {
                const value = JSON.parse(
                    Buffer.from(cursor, 'base64url').toString('utf8'),
                ) as [string, string, string, string, string];
                if (
                    !Array.isArray(value) ||
                    value.length !== 5 ||
                    value[0] !== actor.value ||
                    value[1] !== space.value ||
                    value[2] !== id ||
                    value[3] !== installmentId
                )
                    throw new Error();
                const [targetDate, cycleId] = value[4].split(':');
                if (
                    !targetDate ||
                    !/^[0-9a-f-]{36}$/.test(cycleId) ||
                    cursor.length > 512 ||
                    Buffer.from(JSON.stringify(value)).toString('base64url') !==
                        cursor
                )
                    throw new Error();
                after = { targetDate: civilDate(targetDate), id: cycleId };
            } catch {
                throw new FinancesError('VALIDATION_ERROR', ['cursor']);
            }
        if (cursor && !context)
            throw new FinancesError('VALIDATION_ERROR', ['cursor']);
        const effective =
            p.type === 'SHARED'
                ? await this.adjustments.effectiveRule(
                      space.value,
                      id,
                      p.settlementRuleSnapshot,
                      p.settlementRuleSourceVersion,
                  )
                : null;
        const cycles = context
            ? await this.cycles.listOpen(space.value, after)
            : [];
        const page = cycles.slice(0, 20),
            last = page.at(-1);
        await this.access.assertCanRead(actor, space);
        return {
            commitment: rootView(root),
            installment: installmentView(
                root,
                root.plan.installments.find(
                    (item) => item.id === installmentId,
                )!,
                occurrence,
            ),
            ...(context
                ? {
                      expectedSpaceVersion: context.version,
                      members: context.members,
                  }
                : {}),
            settlementRule: effective,
            suggestedSettlement: effective?.rule
                ? {
                      referenceDate: this.clock.today(),
                      expectedRuleVersion: effective.version,
                      targetDate: SettlementRule.from(
                          effective.rule,
                      ).suggestTargetDate(this.clock.today()),
                  }
                : null,
            openCycles: page.map((cycle) => ({
                id: cycle.id,
                targetDate: cycle.targetDate,
                version: cycle.version,
            })),
            nextCursor:
                cycles.length > 20 && last
                    ? Buffer.from(
                          JSON.stringify([
                              actor.value,
                              space.value,
                              id,
                              installmentId,
                              `${last.targetDate}:${last.id}`,
                          ]),
                      ).toString('base64url')
                    : null,
        };
    }
}
