import { Inject, Injectable } from '@nestjs/common';
import {
    UNIT_OF_WORK,
    type UnitOfWork,
} from '../../../../shared/application/unit-of-work.js';
import {
    SPACE_ACCESS_PORT,
    type SpaceAccessPort,
} from '../../../spaces/application/ports/public/space-access.port.js';
import {
    SPACE_FINANCIAL_CONTEXT_PORT,
    type SpaceFinancialContextPort,
} from '../../../spaces/application/ports/public/space-financial-context.port.js';
import {
    DEFAULT_SETTLEMENT_RULE_REPOSITORY,
    type DefaultSettlementRuleRepository,
} from '../ports/private/default-settlement-rule.repository.js';
import {
    FINANCES_COMMAND_RECEIPTS,
    type FinancesCommandReceipts,
    FinancesReceiptRaceError,
} from '../ports/private/finances-command-receipts.js';
import { FinancesError } from '../../domain/errors/finances.error.js';
import { DefaultSettlementRule } from '../../domain/default-settlement-rule/default-settlement-rule.js';
import { SettlementRule } from '../../domain/settlement-rule/settlement-rule.js';
import type {
    ConfigureDefaultSettlementRuleCommand,
    ConfigureDefaultSettlementRuleResult,
} from '../models/default-settlement-rule.view.js';
import { settlementRuleView } from '../models/settlement-rule-view.js';
@Injectable()
export class ConfigureDefaultSettlementRuleHandler {
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SPACE_ACCESS_PORT) private readonly access: SpaceAccessPort,
        @Inject(DEFAULT_SETTLEMENT_RULE_REPOSITORY)
        private readonly repository: DefaultSettlementRuleRepository,
        @Inject(FINANCES_COMMAND_RECEIPTS)
        private readonly receipts: FinancesCommandReceipts,
        @Inject(SPACE_FINANCIAL_CONTEXT_PORT)
        private readonly contexts: SpaceFinancialContextPort,
    ) {}
    private async authorize(command: ConfigureDefaultSettlementRuleCommand) {
        const context = await this.access.assertCanRead(
            command.actorId,
            command.spaceId,
        );
        if (context.type !== 'SHARED')
            throw new FinancesError('SHARED_SPACE_REQUIRED');
    }
    async execute(
        command: ConfigureDefaultSettlementRuleCommand,
    ): Promise<ConfigureDefaultSettlementRuleResult> {
        if (
            !Number.isSafeInteger(command.expectedVersion) ||
            command.expectedVersion < 0
        )
            throw new FinancesError('VALIDATION_ERROR');
        SettlementRule.from(command.rule);
        try {
            return await this.uow.execute(async () => {
                await this.authorize(command);
                const receipt = await this.receipts.find(command);
                if (receipt) return { ...receipt, replayed: true };
                await this.access.assertCanWrite(
                    command.actorId,
                    command.spaceId,
                );
                await this.contexts.lockForWrite(
                    command.actorId,
                    command.spaceId,
                );
                const existing = await this.repository.find(
                    command.spaceId.value,
                );
                if ((existing?.version ?? 0) !== command.expectedVersion)
                    throw new FinancesError('CONCURRENT_MODIFICATION');
                const now = new Date();
                const previous = existing?.rule.snapshot ?? null;
                const rule = SettlementRule.from(command.rule);
                const aggregate =
                    existing ??
                    DefaultSettlementRule.create(
                        command.spaceId.value,
                        rule,
                        now,
                    );
                const changed = existing
                    ? existing.configure(rule, command.expectedVersion, now)
                    : true;
                await this.access.assertCanWrite(
                    command.actorId,
                    command.spaceId,
                );
                if (changed)
                    await this.repository.save(
                        aggregate,
                        command.expectedVersion,
                        command.actorId.value,
                        previous,
                    );
                const result = {
                    ...settlementRuleView(command.spaceId.value, aggregate),
                    changed,
                    replayed: false,
                };
                await this.receipts.save(command, result, now);
                return result;
            });
        } catch (error: unknown) {
            if (
                !(error instanceof FinancesReceiptRaceError) &&
                !(
                    error instanceof FinancesError &&
                    error.code === 'CONCURRENT_MODIFICATION'
                )
            )
                throw error;
            return this.uow.execute(async () => {
                await this.authorize(command);
                const receipt = await this.receipts.find(command);
                if (!receipt) throw error;
                return { ...receipt, replayed: true };
            });
        }
    }
}
