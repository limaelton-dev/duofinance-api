import { financialChangeEntities } from './infrastructure/typeorm/entities/financial-change.orm-entity.js';
import {
    FinancialCommitmentAdjustmentOrmEntity,
    FinancialCommitmentCancellationOrmEntity,
} from './infrastructure/typeorm/entities/financial-correction.orm-entity.js';
import { FinancialCorrectionController } from './http/controllers/financial-correction.controller.js';
import { FinancialReversalController } from './http/controllers/financial-reversal.controller.js';
import { FinancialFulfillmentReversals } from './application/handlers/financial-fulfillment-reversals.js';
import {
    FinancialReversalPipe,
    FinancialReversalListPipe,
} from './http/dto/financial-reversal.dto.js';
import { FINANCIAL_FULFILLMENT_REVERSAL_REPOSITORY } from './application/ports/private/financial-fulfillment-reversal.repository.js';
import { TypeOrmFinancialFulfillmentReversalRepository } from './infrastructure/typeorm/repositories/typeorm-financial-fulfillment-reversal.repository.js';
import { FinancialFulfillmentReversalOrmEntity } from './infrastructure/typeorm/entities/financial-fulfillment-reversal.orm-entity.js';
import { FinancialCommitmentAdjustments } from './application/handlers/financial-commitment-adjustments.js';
import { FinancialCommitmentCancellations } from './application/handlers/financial-commitment-cancellations.js';
import {
    AdjustmentPipe,
    CancellationPipe,
} from './http/dto/financial-correction.dto.js';
import { FINANCIAL_CORRECTION_REPOSITORY } from './application/ports/private/financial-correction.repository.js';
import { TypeOrmFinancialCorrectionRepository } from './infrastructure/typeorm/repositories/typeorm-financial-correction.repository.js';
import { FinancialNonRecurringVersionOrmEntity } from './infrastructure/typeorm/entities/non-recurring-version.orm-entity.js';
import { FinancialChangeController } from './http/controllers/financial-change.controller.js';
import {
    FinancialChangePipe,
    FinancialChangeDecisionPipe,
    FinancialChangeListPipe,
} from './http/dto/financial-change.dto.js';
import { FinancialCommitmentChangesHandler } from './application/handlers/financial-commitment-changes.handler.js';
import { FinancialIntegrityCommands } from './application/handlers/financial-integrity-commands.js';
import { NonRecurringCommitmentChanges } from './application/handlers/non-recurring-commitment-changes.js';
import { FINANCIAL_CHANGE_REPOSITORY } from './application/ports/private/financial-change.repository.js';
import { NON_RECURRING_CHANGE_REPOSITORY } from './application/ports/private/non-recurring-change.repository.js';
import { TypeOrmFinancialChangeRepository } from './infrastructure/typeorm/repositories/typeorm-financial-change.repository.js';
import { TypeOrmNonRecurringChangeRepository } from './infrastructure/typeorm/repositories/typeorm-non-recurring-change.repository.js';
import { settlementAdjustmentEntities } from './infrastructure/typeorm/entities/settlement-adjustment.orm-entity.js';
import { settlementOffsetEntities } from './infrastructure/typeorm/entities/settlement-offset.orm-entity.js';
import { SettlementCycleChangeOrmEntity } from './infrastructure/typeorm/entities/settlement-cycle-change.orm-entity.js';
import { ObligationWaiverOrmEntity } from './infrastructure/typeorm/entities/obligation-waiver.orm-entity.js';
import { settlementReversalEntities } from './infrastructure/typeorm/entities/settlement-reversal.orm-entity.js';
import { SETTLEMENT_REVERSAL_REPOSITORY } from './application/ports/private/settlement-reversal.repository.js';
import { TypeOrmSettlementReversalRepository } from './infrastructure/typeorm/repositories/typeorm-settlement-reversal.repository.js';
import { ReverseSettlementHandler } from './application/handlers/reverse-settlement.handler.js';
import { SettlementReversalOptionsQuery } from './application/queries/settlement-reversal-options.query.js';
import { ReverseSettlementPipe } from './http/dto/settlement-reversal.dto.js';
import { SettlementReversalController } from './http/controllers/settlement-reversal.controller.js';
import { OBLIGATION_WAIVER_REPOSITORY } from './application/ports/private/obligation-waiver.repository.js';
import { TypeOrmObligationWaiverRepository } from './infrastructure/typeorm/repositories/typeorm-obligation-waiver.repository.js';
import { WaiveObligationHandler } from './application/handlers/waive-obligation.handler.js';
import { ObligationWaiverQueries } from './application/queries/obligation-waiver.queries.js';
import { WaiveObligationPipe } from './http/dto/obligation-waiver.dto.js';
import { ObligationWaiverController } from './http/controllers/obligation-waiver.controller.js';
import { SETTLEMENT_CYCLE_FINALIZATION_REPOSITORY } from './application/ports/private/settlement-cycle-finalization.repository.js';
import { TypeOrmSettlementCycleFinalizationRepository } from './infrastructure/typeorm/repositories/typeorm-settlement-cycle-finalization.repository.js';
import { FinalizeSettlementCycleHandler } from './application/handlers/finalize-settlement-cycle.handler.js';
import { FinalizeSettlementCyclePipe } from './http/dto/finalize-settlement-cycle.dto.js';
import { SettlementCycleFinalizationController } from './http/controllers/settlement-cycle-finalization.controller.js';
import { SETTLEMENT_OFFSET_REPOSITORY } from './application/ports/private/settlement-offset.repository.js';
import { TypeOrmSettlementOffsetRepository } from './infrastructure/typeorm/repositories/typeorm-settlement-offset.repository.js';
import { RecordSettlementOffsetHandler } from './application/handlers/record-settlement-offset.handler.js';
import { SettlementOffsetQueries } from './application/queries/settlement-offset.queries.js';
import { SettlementOffsetController } from './http/controllers/settlement-offset.controller.js';
import { RecordSettlementOffsetPipe } from './http/dto/settlement-offset.dto.js';
import { SETTLEMENT_ADJUSTMENT_REPOSITORY } from './application/ports/private/settlement-adjustment.repository.js';
import { TypeOrmSettlementAdjustmentRepository } from './infrastructure/typeorm/repositories/typeorm-settlement-adjustment.repository.js';
import { SettlementAdjustmentHandler } from './application/handlers/settlement-adjustment.handler.js';
import { SettlementAssignmentOptionsQuery } from './application/queries/settlement-assignment-options.query.js';
import { SettlementAdjustmentController } from './http/controllers/settlement-adjustment.controller.js';
import {
    ConfigureCommitmentSettlementRulePipe,
    MoveObligationPipe,
} from './http/dto/settlement-adjustment.dto.js';
import { FinancialCommandAuditOrmEntity } from './infrastructure/typeorm/entities/financial-command-audit.orm-entity.js';
import { FinancialReviewController } from './http/controllers/financial-review.controller.js';
import { FinancialReviewQueries } from './application/queries/financial-review.queries.js';
import { FINANCIAL_REVIEW_READER } from './application/ports/private/financial-review-reader.js';
import { TypeOrmFinancialReviewReader } from './infrastructure/typeorm/queries/typeorm-financial-review-reader.js';
import { ExternalLiabilityController } from './http/controllers/external-liability.controller.js';
import { SettleExternalLiabilityPipe } from './http/dto/settle-external-liability.dto.js';
import { SettleExternalLiabilityHandler } from './application/handlers/settle-external-liability.handler.js';
import { ExternalLiabilityQueries } from './application/queries/external-liability.queries.js';
import {
    EXTERNAL_LIABILITY_SETTLEMENT_RECEIPTS,
    EXTERNAL_LIABILITY_SETTLEMENT_REPOSITORY,
} from './application/ports/private/external-liability-settlement.ports.js';
import { TypeOrmExternalLiabilitySettlementReceipts } from './infrastructure/typeorm/repositories/typeorm-external-liability-settlement-receipts.js';
import { TypeOrmExternalLiabilitySettlementRepository } from './infrastructure/typeorm/repositories/typeorm-external-liability-settlement.repository.js';
import { FinancialExternalLiabilitySettlementOrmEntity } from './infrastructure/typeorm/entities/external-liability-settlement.orm-entity.js';
import { CreditCardPurchaseController } from './http/controllers/credit-card-purchase.controller.js';
import {
    RecordCreditCardPurchasePipe,
    RecordExternalLiabilityPipe,
} from './http/dto/record-credit-card-purchase.dto.js';
import { RecordCreditCardPurchaseHandler } from './application/handlers/record-credit-card-purchase.handler.js';
import { CreditCardPurchaseQueries } from './application/queries/credit-card-purchase.queries.js';
import { CREDIT_CARD_RECEIPTS } from './application/ports/private/credit-card-receipts.js';
import { TypeOrmCreditCardReceipts } from './infrastructure/typeorm/repositories/typeorm-credit-card-receipts.js';
import { Module } from '@nestjs/common';
import { RecurringCommitmentController } from './http/controllers/recurring-commitment.controller.js';
import { PlannedTodayQuery } from './application/queries/planned-today.query.js';
import { PLANNED_TODAY_QUERY_PORT } from './application/ports/public/planned-today-query.port.js';
import { RecurringCommitmentHandler } from './application/handlers/recurring-commitment.handler.js';
import {
    CreateRecurringCommitmentPipe,
    RecurringDisbursementPipe,
    RecurringReceiptPipe,
    RecurringExternalLiabilityPipe,
    RecurringExternalSettlementPipe,
} from './http/dto/recurring-commitment.dto.js';
import { RECURRING_COMMITMENT_REPOSITORY } from './application/ports/private/recurring-commitment.repository.js';
import { TypeOrmRecurringCommitmentRepository } from './infrastructure/typeorm/repositories/typeorm-recurring-commitment.repository.js';
import { recurrenceEntities } from './infrastructure/typeorm/entities/recurrence.orm-entity.js';
import { installmentEntities } from './infrastructure/typeorm/entities/installment.orm-entity.js';
import { InstallmentCommitmentController } from './http/controllers/installment-commitment.controller.js';
import { InstallmentCommitmentHandler } from './application/handlers/installment-commitment.handler.js';
import { CreateInstallmentCommitmentHandler } from './application/handlers/create-installment-commitment.handler.js';
import { InstallmentCommitmentQueries } from './application/handlers/installment-commitment.queries.js';
import { AnticipateInstallmentCommitmentHandler } from './application/handlers/anticipate-installment-commitment.handler.js';
import { ResolveInstallmentCommitmentHandler } from './application/handlers/resolve-installment-commitment.handler.js';
import { CancelInstallmentCommitmentHandler } from './application/handlers/cancel-installment-commitment.handler.js';
import { RecordInstallmentCommitmentHandler } from './application/handlers/record-installment-commitment.handler.js';
import {
    InstallmentCommitmentPipe,
    InstallmentDisbursementPipe,
    InstallmentLiabilityPipe,
    InstallmentSettlementPipe,
} from './http/dto/installment-commitment.dto.js';
import { INSTALLMENT_COMMITMENT_REPOSITORY } from './application/ports/private/installment-commitment.repository.js';
import { TypeOrmInstallmentCommitmentRepository } from './infrastructure/typeorm/repositories/typeorm-installment-commitment.repository.js';
import { PlannedExpenseController } from './http/controllers/planned-expense.controller.js';
import { CreatePlannedExpenseHandler } from './application/handlers/create-planned-expense.handler.js';
import { ListPlannedExpensesQuery } from './application/queries/planned-expense.queries.js';
import { CreatePlannedExpensePipe } from './http/dto/create-planned-expense.dto.js';
import { PLANNED_EXPENSE_RECEIPTS } from './application/ports/private/planned-expense.receipts.js';
import { TypeOrmPlannedExpenseReceipts } from './infrastructure/typeorm/repositories/typeorm-planned-expense-receipts.js';
import { ExpenseDisbursementController } from './http/controllers/expense-disbursement.controller.js';
import { RecordExpenseDisbursementPipe } from './http/dto/record-expense-disbursement.dto.js';
import { RecordExpenseDisbursementHandler } from './application/handlers/record-expense-disbursement.handler.js';
import { ReconcileFinancialOrigin } from './application/handlers/reconcile-financial-origin.js';
import { GetExpenseDisbursementOptionsQuery } from './application/queries/expense-disbursement.queries.js';
import { EXPENSE_DISBURSEMENT_RECEIPTS } from './application/ports/private/expense-disbursement.ports.js';
import { TypeOrmExpenseDisbursementReceipts } from './infrastructure/typeorm/repositories/typeorm-expense-disbursement-receipts.js';
import { GetIncomeTodayQuery } from './application/queries/income-today.query.js';
import { INCOME_TODAY_QUERY_PORT } from './application/ports/public/income-today-query.port.js';
import { incomeEntities } from './infrastructure/typeorm/entities/income.orm-entity.js';
import { IncomeController } from './http/controllers/income.controller.js';
import {
    RecordIncomePipe,
    RecordIncomeReceiptPipe,
} from './http/dto/record-income.dto.js';
import { RecordIncomeHandler } from './application/handlers/record-income.handler.js';
import { IncomeQueries } from './application/queries/income.queries.js';
import {
    INCOME_REPOSITORY,
    INCOME_COMMAND_RECEIPTS,
} from './application/ports/private/income.ports.js';
import { TypeOrmIncomeRepository } from './infrastructure/typeorm/repositories/typeorm-income.repository.js';
import { TypeOrmIncomeCommandReceipts } from './infrastructure/typeorm/repositories/typeorm-income-command-receipts.js';
import { PersonalExpenseController } from './http/controllers/personal-expense.controller.js';
import { RecordPersonalExpensePipe } from './http/dto/record-personal-expense.dto.js';
import { RecordPersonalExpenseHandler } from './application/handlers/record-personal-expense.handler.js';
import {
    GetPersonalExpenseOptionsQuery,
    ListPersonalExpensesQuery,
} from './application/queries/personal-expense.queries.js';
import {
    PERSONAL_EXPENSE_RECEIPTS,
    PERSONAL_EXPENSE_READER,
} from './application/ports/private/personal-expense.ports.js';
import { TypeOrmPersonalExpenseReceipts } from './infrastructure/typeorm/repositories/typeorm-personal-expense-receipts.js';
import { TypeOrmPersonalExpenseReader } from './infrastructure/typeorm/queries/typeorm-personal-expense-reader.js';
import { GetFinanceTodayQuery } from './application/queries/finance-today.query.js';
import { FINANCE_TODAY_QUERY_PORT } from './application/ports/public/finance-today-query.port.js';
import { FinanceTodayCompositionQuery } from './application/queries/finance-today-composition.query.js';
import { FINANCE_TODAY_COMPOSITION_QUERY_PORT } from './application/ports/public/finance-today-composition-query.port.js';
import {
    SettlementTransferOrmEntity,
    SettlementAllocationOrmEntity,
    FinancialSettlementCommandReceiptOrmEntity,
    FinancialSettlementAuditOrmEntity,
} from './infrastructure/typeorm/entities/settlement-transfer.orm-entity.js';
import { SettlementTransferController } from './http/controllers/settlement-transfer.controller.js';
import { RecordManualSettlementTransferHandler } from './application/handlers/record-manual-settlement-transfer.handler.js';
import {
    GetSettlementTransferOptionsQuery,
    GetSettlementTransferQuery,
    ListSettlementTransfersQuery,
} from './application/queries/settlement-transfer.queries.js';
import { RecordManualSettlementTransferPipe } from './http/dto/record-manual-settlement-transfer.dto.js';
import {
    SETTLEMENT_TRANSFER_REPOSITORY,
    SETTLEMENT_TRANSFER_RECEIPTS,
} from './application/ports/private/settlement-transfer.repository.js';
import { TypeOrmSettlementTransferRepository } from './infrastructure/typeorm/repositories/typeorm-settlement-transfer.repository.js';
import { TypeOrmSettlementTransferReceipts } from './infrastructure/typeorm/repositories/typeorm-settlement-transfer-receipts.js';
import {
    GetSettlementCycleQuery,
    GetSettlementCyclesQuery,
    GetSelectedSettlementCyclesQuery,
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
            ...financialChangeEntities,
            FinancialCommitmentAdjustmentOrmEntity,
            FinancialCommitmentCancellationOrmEntity,
            FinancialFulfillmentReversalOrmEntity,
            FinancialNonRecurringVersionOrmEntity,
            ...settlementAdjustmentEntities,
            ...settlementOffsetEntities,
            SettlementCycleChangeOrmEntity,
            ObligationWaiverOrmEntity,
            ...settlementReversalEntities,
            FinancialCommandAuditOrmEntity,
            ...sharedExpenseEntities,
            ...recurrenceEntities,
            ...installmentEntities,
            FinancialExternalLiabilitySettlementOrmEntity,
            ...incomeEntities,
            SettlementTransferOrmEntity,
            SettlementAllocationOrmEntity,
            FinancialSettlementCommandReceiptOrmEntity,
            FinancialSettlementAuditOrmEntity,
            DefaultSettlementRuleOrmEntity,
            DefaultSettlementRuleChangeOrmEntity,
            FinancesCommandReceiptOrmEntity,
        ]),
    ],
    controllers: [
        FinancialChangeController,
        FinancialCorrectionController,
        FinancialReversalController,
        PlannedExpenseController,
        RecurringCommitmentController,
        InstallmentCommitmentController,
        SettlementReversalController,
        ObligationWaiverController,
        SettlementCycleFinalizationController,
        SettlementOffsetController,
        SettlementAdjustmentController,
        FinancialReviewController,
        ExternalLiabilityController,
        CreditCardPurchaseController,
        ExpenseDisbursementController,
        PersonalExpenseController,
        IncomeController,
        SettlementCycleController,
        DefaultSettlementRuleController,
        SharedCashExpenseController,
        InterMemberPositionController,
        SettlementTransferController,
    ],
    providers: [
        FinancialCommitmentChangesHandler,
        FinancialCommitmentAdjustments,
        FinancialCommitmentCancellations,
        FinancialFulfillmentReversals,
        FinancialReversalPipe,
        FinancialReversalListPipe,
        {
            provide: FINANCIAL_FULFILLMENT_REVERSAL_REPOSITORY,
            useClass: TypeOrmFinancialFulfillmentReversalRepository,
        },
        AdjustmentPipe,
        CancellationPipe,
        {
            provide: FINANCIAL_CORRECTION_REPOSITORY,
            useClass: TypeOrmFinancialCorrectionRepository,
        },
        FinancialIntegrityCommands,
        NonRecurringCommitmentChanges,
        FinancialChangePipe,
        FinancialChangeDecisionPipe,
        FinancialChangeListPipe,
        {
            provide: FINANCIAL_CHANGE_REPOSITORY,
            useClass: TypeOrmFinancialChangeRepository,
        },
        {
            provide: NON_RECURRING_CHANGE_REPOSITORY,
            useClass: TypeOrmNonRecurringChangeRepository,
        },
        CreatePlannedExpenseHandler,
        RecurringCommitmentHandler,
        InstallmentCommitmentHandler,
        CreateInstallmentCommitmentHandler,
        InstallmentCommitmentQueries,
        AnticipateInstallmentCommitmentHandler,
        ResolveInstallmentCommitmentHandler,
        CancelInstallmentCommitmentHandler,
        RecordInstallmentCommitmentHandler,
        InstallmentCommitmentPipe,
        InstallmentDisbursementPipe,
        InstallmentLiabilityPipe,
        InstallmentSettlementPipe,
        {
            provide: INSTALLMENT_COMMITMENT_REPOSITORY,
            useClass: TypeOrmInstallmentCommitmentRepository,
        },
        PlannedTodayQuery,
        { provide: PLANNED_TODAY_QUERY_PORT, useExisting: PlannedTodayQuery },
        CreateRecurringCommitmentPipe,
        RecurringDisbursementPipe,
        RecurringReceiptPipe,
        RecurringExternalLiabilityPipe,
        RecurringExternalSettlementPipe,
        {
            provide: RECURRING_COMMITMENT_REPOSITORY,
            useClass: TypeOrmRecurringCommitmentRepository,
        },
        ListPlannedExpensesQuery,
        CreatePlannedExpensePipe,
        {
            provide: PLANNED_EXPENSE_RECEIPTS,
            useClass: TypeOrmPlannedExpenseReceipts,
        },
        ReverseSettlementHandler,
        SettlementReversalOptionsQuery,
        ReverseSettlementPipe,
        {
            provide: SETTLEMENT_REVERSAL_REPOSITORY,
            useClass: TypeOrmSettlementReversalRepository,
        },
        WaiveObligationHandler,
        ObligationWaiverQueries,
        WaiveObligationPipe,
        {
            provide: OBLIGATION_WAIVER_REPOSITORY,
            useClass: TypeOrmObligationWaiverRepository,
        },
        FinalizeSettlementCycleHandler,
        FinalizeSettlementCyclePipe,
        {
            provide: SETTLEMENT_CYCLE_FINALIZATION_REPOSITORY,
            useClass: TypeOrmSettlementCycleFinalizationRepository,
        },
        SettlementAdjustmentHandler,
        RecordSettlementOffsetHandler,
        RecordSettlementOffsetPipe,
        SettlementOffsetQueries,
        {
            provide: SETTLEMENT_OFFSET_REPOSITORY,
            useClass: TypeOrmSettlementOffsetRepository,
        },
        SettlementAssignmentOptionsQuery,
        ConfigureCommitmentSettlementRulePipe,
        MoveObligationPipe,
        {
            provide: SETTLEMENT_ADJUSTMENT_REPOSITORY,
            useClass: TypeOrmSettlementAdjustmentRepository,
        },
        FinancialReviewQueries,
        {
            provide: FINANCIAL_REVIEW_READER,
            useClass: TypeOrmFinancialReviewReader,
        },
        SettleExternalLiabilityPipe,
        SettleExternalLiabilityHandler,
        ExternalLiabilityQueries,
        {
            provide: EXTERNAL_LIABILITY_SETTLEMENT_RECEIPTS,
            useClass: TypeOrmExternalLiabilitySettlementReceipts,
        },
        {
            provide: EXTERNAL_LIABILITY_SETTLEMENT_REPOSITORY,
            useClass: TypeOrmExternalLiabilitySettlementRepository,
        },
        RecordCreditCardPurchasePipe,
        RecordExternalLiabilityPipe,
        RecordCreditCardPurchaseHandler,
        CreditCardPurchaseQueries,
        { provide: CREDIT_CARD_RECEIPTS, useClass: TypeOrmCreditCardReceipts },
        RecordExpenseDisbursementPipe,
        RecordExpenseDisbursementHandler,
        ReconcileFinancialOrigin,
        GetExpenseDisbursementOptionsQuery,
        {
            provide: EXPENSE_DISBURSEMENT_RECEIPTS,
            useClass: TypeOrmExpenseDisbursementReceipts,
        },
        RecordPersonalExpensePipe,
        RecordIncomePipe,
        RecordIncomeReceiptPipe,
        RecordIncomeHandler,
        IncomeQueries,
        GetIncomeTodayQuery,
        { provide: INCOME_TODAY_QUERY_PORT, useExisting: GetIncomeTodayQuery },
        { provide: INCOME_REPOSITORY, useClass: TypeOrmIncomeRepository },
        {
            provide: INCOME_COMMAND_RECEIPTS,
            useClass: TypeOrmIncomeCommandReceipts,
        },
        RecordPersonalExpenseHandler,
        GetPersonalExpenseOptionsQuery,
        ListPersonalExpensesQuery,
        {
            provide: PERSONAL_EXPENSE_RECEIPTS,
            useClass: TypeOrmPersonalExpenseReceipts,
        },
        {
            provide: PERSONAL_EXPENSE_READER,
            useClass: TypeOrmPersonalExpenseReader,
        },
        GetFinanceTodayQuery,
        {
            provide: FINANCE_TODAY_COMPOSITION_QUERY_PORT,
            useClass: FinanceTodayCompositionQuery,
        },
        {
            provide: FINANCE_TODAY_QUERY_PORT,
            useExisting: GetFinanceTodayQuery,
        },
        GetSettlementCyclesQuery,
        GetSelectedSettlementCyclesQuery,
        GetSettlementTransferOptionsQuery,
        GetSettlementTransferQuery,
        ListSettlementTransfersQuery,
        RecordManualSettlementTransferHandler,
        RecordManualSettlementTransferPipe,
        {
            provide: SETTLEMENT_TRANSFER_REPOSITORY,
            useClass: TypeOrmSettlementTransferRepository,
        },
        {
            provide: SETTLEMENT_TRANSFER_RECEIPTS,
            useClass: TypeOrmSettlementTransferReceipts,
        },
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
    exports: [
        SETTLEMENT_CYCLE_QUERY_PORT,
        FINANCE_TODAY_QUERY_PORT,
        FINANCE_TODAY_COMPOSITION_QUERY_PORT,
        INCOME_TODAY_QUERY_PORT,
        PLANNED_TODAY_QUERY_PORT,
    ],
})
export class FinancesModule {}
