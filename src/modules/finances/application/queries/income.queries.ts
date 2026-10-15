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
import { SettlementRule } from '../../domain/settlement-rule/settlement-rule.js';
import {
    DEFAULT_SETTLEMENT_RULE_REPOSITORY,
    type DefaultSettlementRuleRepository,
} from '../ports/private/default-settlement-rule.repository.js';
import {
    INCOME_REPOSITORY,
    type IncomeRepository,
} from '../ports/private/income.ports.js';
import {
    FINANCES_CLOCK,
    SETTLEMENT_CYCLE_REPOSITORY,
    type FinancesClock,
    type SettlementCycleRepository,
} from '../ports/private/shared-expense.repositories.js';
import {
    decodeExpenseCursor,
    encodeExpenseCursor,
} from './shared-cash-expense.queries.js';

function encodeCursor(
    spaceId: string,
    status: string,
    registeredAt: string,
    id: string,
) {
    return Buffer.from(
        JSON.stringify([spaceId, status, registeredAt, id]),
    ).toString('base64url');
}

function decodeCursor(
    value: string | undefined,
    spaceId: string,
    status: string,
): { registeredAt: string; id: string } | null {
    if (value === undefined) return null;
    try {
        if (value.length > 400 || !/^[A-Za-z0-9_-]+$/.test(value))
            throw new Error();
        const parts = JSON.parse(
            Buffer.from(value, 'base64url').toString('utf8'),
        );
        if (
            !Array.isArray(parts) ||
            parts.length !== 4 ||
            parts[0] !== spaceId ||
            parts[1] !== status ||
            typeof parts[2] !== 'string' ||
            !Number.isFinite(Date.parse(parts[2])) ||
            typeof parts[3] !== 'string' ||
            !/^[0-9a-f-]{36}$/.test(parts[3]) ||
            encodeCursor(spaceId, status, parts[2], parts[3]) !== value
        )
            throw new Error();
        return { registeredAt: parts[2], id: parts[3] };
    } catch {
        throw new FinancesError('VALIDATION_ERROR', ['cursor']);
    }
}

@Injectable()
export class IncomeQueries {
    constructor(
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly context: SpaceFinancialContextPort,
        @Inject(DEFAULT_SETTLEMENT_RULE_REPOSITORY)
        private readonly rules: DefaultSettlementRuleRepository,
        @Inject(SETTLEMENT_CYCLE_REPOSITORY)
        private readonly cycles: SettlementCycleRepository,
        @Inject(INCOME_REPOSITORY) private readonly incomes: IncomeRepository,
        @Inject(FINANCES_CLOCK) private readonly clock: FinancesClock,
    ) {}

    async options(actor: PersonId, space: SpaceId, cursor?: string) {
        const access = await this.access.assertCanRead(actor, space);
        const referenceDate = this.clock.today();
        if (access.type === 'PERSONAL') {
            if (cursor !== undefined)
                throw new FinancesError('VALIDATION_ERROR', ['cursor']);
            await this.access.assertCanRead(actor, space);
            return {
                spaceId: space.value,
                spaceType: 'PERSONAL' as const,
                status: access.status,
                canCreate: access.status === 'ACTIVE',
                referenceDate,
            };
        }
        const context = await this.context.read(actor, space);
        const rule = await this.rules.find(space.value);
        const after = decodeExpenseCursor(cursor, space.value);
        const cycles = await this.cycles.listOpen(space.value, after);
        await this.context.read(actor, space);
        const page = cycles.slice(0, 20);
        const last = page.at(-1);
        return {
            spaceId: space.value,
            spaceType: 'SHARED' as const,
            status: context.status,
            canCreate: context.status === 'ACTIVE',
            version: context.version,
            members: context.members,
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

    async list(
        actor: PersonId,
        space: SpaceId,
        status: 'ALL' | 'PENDING' | 'RECEIVED',
        cursor?: string,
    ) {
        await this.access.assertCanRead(actor, space);
        const after = decodeCursor(cursor, space.value, status);
        const rows = await this.incomes.list(space.value, status, after);
        await this.access.assertCanRead(actor, space);
        const items = rows.slice(0, 20);
        const last = items.at(-1);
        return {
            spaceId: space.value,
            items,
            nextCursor:
                rows.length > 20 && last
                    ? encodeCursor(
                          space.value,
                          status,
                          last.registeredAt,
                          last.id,
                      )
                    : null,
        };
    }

    async receiptOptions(
        actor: PersonId,
        space: SpaceId,
        commitmentId: string,
        cursor?: string,
    ) {
        const access = await this.access.assertCanRead(actor, space);
        const income = await this.incomes.find(space.value, commitmentId);
        if (!income || income.participation.type !== access.type)
            throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const referenceDate = this.clock.today();
        if (access.type === 'PERSONAL') {
            if (cursor !== undefined)
                throw new FinancesError('VALIDATION_ERROR', ['cursor']);
            await this.access.assertCanRead(actor, space);
            return {
                spaceId: space.value,
                spaceType: 'PERSONAL' as const,
                commitmentId,
                expectedCommitmentVersion: income.version,
                amountInCents: income.amountInCents,
                referenceDate,
                canReceive: !income.receipt && access.status === 'ACTIVE',
            };
        }
        const context = await this.context.read(actor, space);
        const p = income.participation;
        if (p.type !== 'SHARED')
            throw new FinancesError('FINANCIAL_COMMITMENT_NOT_FOUND');
        const after = decodeExpenseCursor(cursor, space.value);
        const cycles = await this.cycles.listOpen(space.value, after);
        await this.context.read(actor, space);
        const page = cycles.slice(0, 20);
        const last = page.at(-1);
        return {
            spaceId: space.value,
            spaceType: 'SHARED' as const,
            commitmentId,
            expectedCommitmentVersion: income.version,
            expectedSpaceVersion: context.version,
            amountInCents: income.amountInCents,
            referenceDate,
            canReceive: !income.receipt && context.status !== 'CLOSED',
            members: context.members.filter((m) =>
                p.split.shares.some((s) => s.memberId === m.memberId),
            ),
            participationSplit: {
                ...p.split.original,
                calculatedShares: p.split.shares.map((s) => ({
                    memberId: s.memberId,
                    amountInCents: s.amountInCents,
                })),
            },
            expectedRecipientMemberId: p.expectedRecipientMemberId,
            defaultSettlementRule: {
                rule: p.settlementRuleSnapshot,
                version: p.settlementRuleSourceVersion,
            },
            suggestedTargetDate: p.settlementRuleSnapshot
                ? SettlementRule.from(
                      p.settlementRuleSnapshot,
                  ).suggestTargetDate(referenceDate)
                : null,
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
