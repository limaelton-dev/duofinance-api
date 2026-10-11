import { Module } from '@nestjs/common';
import {
    GetSettlementCycleQuery,
    GetSettlementCyclesQuery,
} from './application/queries/settlement-cycle.queries.js';
import { SETTLEMENT_CYCLE_READER } from './application/ports/private/settlement-cycle-reader.js';
import { SETTLEMENT_CYCLE_QUERY_PORT } from './application/ports/public/settlement-cycle-query.port.js';
import { TypeOrmSettlementCycleReader } from './infrastructure/typeorm/queries/typeorm-settlement-cycle-reader.js';
import { SettlementCycleController } from './http/controllers/settlement-cycle.controller.js';
import { GetInterMemberPositionQuery } from './application/queries/inter-member-position.query.js';
import { INTER_MEMBER_POSITION_READER } from './application/ports/private/inter-member-position-reader.js';
import { TypeOrmInterMemberPositionReader } from './infrastructure/typeorm/queries/typeorm-inter-member-position-reader.js';
import { InterMemberPositionController } from './http/controllers/inter-member-position.controller.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../../shared/technical/database/database.module.js';
import { SpacesModule } from '../spaces/spaces.module.js';
import { DEFAULT_SETTLEMENT_RULE_REPOSITORY } from './application/ports/private/default-settlement-rule.repository.js';
import { FINANCES_COMMAND_RECEIPTS } from './application/ports/private/finances-command-receipts.js';
import { ConfigureDefaultSettlementRuleHandler } from './application/handlers/configure-default-settlement-rule.handler.js';
import { GetDefaultSettlementRuleQuery } from './application/queries/get-default-settlement-rule.query.js';
import { DefaultSettlementRuleController } from './http/controllers/default-settlement-rule.controller.js';
import { DefaultSettlementRuleOrmEntity } from './infrastructure/typeorm/entities/default-settlement-rule.orm-entity.js';
import { DefaultSettlementRuleChangeOrmEntity } from './infrastructure/typeorm/entities/default-settlement-rule-change.orm-entity.js';
import { FinancesCommandReceiptOrmEntity } from './infrastructure/typeorm/entities/finances-command-receipt.orm-entity.js';
import { TypeOrmDefaultSettlementRuleRepository } from './infrastructure/typeorm/repositories/typeorm-default-settlement-rule.repository.js';
import { TypeOrmFinancesCommandReceipts } from './infrastructure/typeorm/repositories/typeorm-finances-command-receipts.js';
import { sharedExpenseEntities } from './infrastructure/typeorm/entities/shared-expense.orm-entity.js';
import { RecordSharedCashExpenseHandler } from './application/handlers/record-shared-cash-expense.handler.js';
import { SharedCashExpenseController } from './http/controllers/shared-cash-expense.controller.js';
import {
    GetSharedCashExpenseOptionsQuery,
    GetFinancialCommitmentQuery,
} from './application/queries/shared-cash-expense.queries.js';
import { RecordSharedCashExpensePipe } from './http/dto/record-shared-cash-expense.dto.js';
import {
    TypeOrmFinancialCommitmentRepository,
    TypeOrmInterMemberObligationRepository,
    TypeOrmSettlementCycleRepository,
    TypeOrmExpenseCommandReceipts,
} from './infrastructure/typeorm/repositories/typeorm-shared-expense.repositories.js';
import {
    FINANCIAL_COMMITMENT_REPOSITORY,
    INTER_MEMBER_OBLIGATION_REPOSITORY,
    SETTLEMENT_CYCLE_REPOSITORY,
    EXPENSE_COMMAND_RECEIPTS,
    FINANCES_CLOCK,
} from './application/ports/private/shared-expense.repositories.js';
@Module({
    imports: [
        DatabaseModule,
        SpacesModule,
        TypeOrmModule.forFeature([
            ...sharedExpenseEntities,
            DefaultSettlementRuleOrmEntity,
            DefaultSettlementRuleChangeOrmEntity,
            FinancesCommandReceiptOrmEntity,
        ]),
    ],
    controllers: [
        SettlementCycleController,
        DefaultSettlementRuleController,
        SharedCashExpenseController,
        InterMemberPositionController,
    ],
    providers: [
        GetSettlementCyclesQuery,
        GetSettlementCycleQuery,
        {
            provide: SETTLEMENT_CYCLE_READER,
            useClass: TypeOrmSettlementCycleReader,
        },
        {
            provide: SETTLEMENT_CYCLE_QUERY_PORT,
            useExisting: GetSettlementCyclesQuery,
        },
        GetInterMemberPositionQuery,
        {
            provide: INTER_MEMBER_POSITION_READER,
            useClass: TypeOrmInterMemberPositionReader,
        },
        GetSharedCashExpenseOptionsQuery,
        GetFinancialCommitmentQuery,
        RecordSharedCashExpensePipe,
        RecordSharedCashExpenseHandler,
        {
            provide: FINANCIAL_COMMITMENT_REPOSITORY,
            useClass: TypeOrmFinancialCommitmentRepository,
        },
        {
            provide: INTER_MEMBER_OBLIGATION_REPOSITORY,
            useClass: TypeOrmInterMemberObligationRepository,
        },
        {
            provide: SETTLEMENT_CYCLE_REPOSITORY,
            useClass: TypeOrmSettlementCycleRepository,
        },
        {
            provide: EXPENSE_COMMAND_RECEIPTS,
            useClass: TypeOrmExpenseCommandReceipts,
        },
        {
            provide: FINANCES_CLOCK,
            useValue: {
                now: () => new Date(),
                today: () =>
                    new Intl.DateTimeFormat('en-CA', {
                        timeZone: 'America/Sao_Paulo',
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                    }).format(new Date()),
            },
        },
        ConfigureDefaultSettlementRuleHandler,
        GetDefaultSettlementRuleQuery,
        {
            provide: DEFAULT_SETTLEMENT_RULE_REPOSITORY,
            useClass: TypeOrmDefaultSettlementRuleRepository,
        },
        {
            provide: FINANCES_COMMAND_RECEIPTS,
            useClass: TypeOrmFinancesCommandReceipts,
        },
    ],
    exports: [SETTLEMENT_CYCLE_QUERY_PORT],
})
export class FinancesModule {}
