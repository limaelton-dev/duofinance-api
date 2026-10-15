import type {
    FinancialCommitment,
    ExpenseVersion,
} from '../../../domain/shared-expense/financial-commitment.js';
import type {
    SettleExternalLiabilityCommand,
    ExternalLiabilitySettlementResult,
    OpenExternalLiability,
} from '../../models/external-liability-settlement.js';
export const EXTERNAL_LIABILITY_SETTLEMENT_RECEIPTS = Symbol(
    'EXTERNAL_LIABILITY_SETTLEMENT_RECEIPTS',
);
export interface ExternalLiabilitySettlementReceipts {
    find(
        command: SettleExternalLiabilityCommand,
    ): Promise<ExternalLiabilitySettlementResult | null>;
    save(
        command: SettleExternalLiabilityCommand,
        result: ExternalLiabilitySettlementResult,
        registeredAt: string,
    ): Promise<void>;
}
export const EXTERNAL_LIABILITY_SETTLEMENT_REPOSITORY = Symbol(
    'EXTERNAL_LIABILITY_SETTLEMENT_REPOSITORY',
);
export interface ExternalLiabilitySettlementRepository {
    findDetail(
        spaceId: string,
        commitmentId: string,
        externalLiabilityId: string,
    ): Promise<OpenExternalLiability | null>;
    findHolder(
        spaceId: string,
        commitmentId: string,
        externalLiabilityId: string,
    ): Promise<{
        holderMemberId: string | null;
        holderPersonId: string | null;
        personalOwnerPersonId: string | null;
    } | null>;
    saveExternalLiabilitySettlement(
        commitment: FinancialCommitment<ExpenseVersion>,
        command: SettleExternalLiabilityCommand,
    ): Promise<void>;
    listOpen(
        spaceId: string,
        holder: { personId: string } | { memberId: string },
        after: { targetDate: string; id: string } | null,
    ): Promise<OpenExternalLiability[]>;
}
