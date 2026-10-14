import { Inject, Injectable } from '@nestjs/common';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../../spaces/application/ports/public/space-access.port.js';
import {
    PERSONAL_EXPENSE_READER,
    type PersonalExpenseReader,
} from '../ports/private/personal-expense.ports.js';
import type { PersonalExpenseView } from '../models/personal-expense.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import type { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { SpaceId } from '../../../spaces/domain/space/space-id.js';
import {
    DEFAULT_SETTLEMENT_RULE_REPOSITORY,
    type DefaultSettlementRuleRepository,
} from '../ports/private/default-settlement-rule.repository.js';
import {
    SETTLEMENT_CYCLE_REPOSITORY,
    FINANCIAL_COMMITMENT_REPOSITORY,
    FINANCES_CLOCK,
    type SettlementCycleRepository,
    type FinancialCommitmentRepository,
    type FinancesClock,
} from '../ports/private/shared-expense.repositories.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import { civilDate } from '../../domain/shared-expense/settlement-cycle.js';
import type {
    SharedCashExpenseOptions,
    SharedCashExpenseView,
} from '../models/shared-cash-expense.js';
export function encodeExpenseCursor(
    spaceId: string,
    targetDate: string,
    id: string,
): string {
    return Buffer.from(JSON.stringify([spaceId, targetDate, id])).toString(
        'base64url',
    );
}
export function decodeExpenseCursor(
    cursor: string | undefined,
    spaceId: string,
): { targetDate: string; id: string } | null {
    if (cursor === undefined) return null;
    try {
        if (cursor.length > 300 || !/^[A-Za-z0-9_-]+$/.test(cursor))
            throw new Error();
        const value = JSON.parse(
            Buffer.from(cursor, 'base64url').toString('utf8'),
        );
        if (
            !Array.isArray(value) ||
            value.length !== 3 ||
            value[0] !== spaceId ||
            typeof value[2] !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
                value[2],
            ) ||
            encodeExpenseCursor(spaceId, civilDate(value[1]), value[2]) !==
                cursor
        )
            throw new Error();
        return { targetDate: value[1], id: value[2] };
    } catch {
        throw new FinancesError('VALIDATION_ERROR', ['cursor']);
    }
}
@Injectable()
export class GetSharedCashExpenseOptionsQuery {
    constructor(
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly access: SpaceFinancialContextPort,
        @Inject(DEFAULT_SETTLEMENT_RULE_REPOSITORY)
        private readonly rules: DefaultSettlementRuleRepository,
        @Inject(SETTLEMENT_CYCLE_REPOSITORY)
        private readonly cycles: SettlementCycleRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}
    async execute(
        actor: PersonId,
        space: SpaceId,
        cursor?: string,
    ): Promise<SharedCashExpenseOptions> {
        const context = await this.access.read(actor, space),
            after = decodeExpenseCursor(cursor, space.value);
        const rule = await this.rules.find(space.value),
            referenceDate = this.clock.today(),
            cycles = await this.cycles.listOpen(space.value, after);
        await this.access.read(actor, space);
        const page = cycles.slice(0, 20),
            last = page.at(-1);
        return {
            ...context,
            referenceDate,
            defaultSettlementRule: {
                rule: rule?.rule.snapshot ?? null,
                version: rule?.version ?? 0,
            },
            suggestedTargetDate:
                rule?.rule.suggestTargetDate(referenceDate) ?? null,
            openCycles: page.map((c) => ({
                id: c.id,
                targetDate: c.targetDate,
                version: c.version,
            })),
            nextCursor:
                cycles.length > 20 && last
                    ? encodeExpenseCursor(space.value, last.targetDate, last.id)
                    : null,
        };
    }
}
@Injectable()
export class GetFinancialCommitmentQuery {
    constructor(
        @Inject(SPACE_ACCESS_PORT)
        private readonly spaceAccess: SpaceAccessPort,
        @Inject(PERSONAL_EXPENSE_READER)
        private readonly personal: PersonalExpenseReader,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly access: SpaceFinancialContextPort,
        @Inject(FINANCIAL_COMMITMENT_REPOSITORY)
        private readonly commitments: FinancialCommitmentRepository,
    ) {}
    async execute(
        actor: PersonId,
        space: SpaceId,
        commitmentId: string,
    ): Promise<
        | PersonalExpenseView
        | (SharedCashExpenseView & {
              members: {
                  memberId: string;
                  personId: string;
                  displayName: string;
              }[];
          })
    > {
        const access = await this.spaceAccess.assertCanRead(actor, space);
        if (access.type === 'PERSONAL') {
            const detail = await this.personal.detail(
                space.value,
                commitmentId,
            );
            if (!detail)
                throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
            await this.spaceAccess.assertCanRead(actor, space);
            return detail;
        }
        await this.access.read(actor, space);
        const detail = await this.commitments.detail(space.value, commitmentId);
        if (!detail) throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const context = await this.access.read(actor, space);
        return { ...detail, members: context.members };
    }
}
