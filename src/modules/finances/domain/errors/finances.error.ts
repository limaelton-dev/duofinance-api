export type FinancesErrorCode =
    | 'VALIDATION_ERROR'
    | 'SHARED_SPACE_REQUIRED'
    | 'CONCURRENT_MODIFICATION'
    | 'IDEMPOTENCY_KEY_REUSED'
    | 'EXPENSE_OPTIONS_CHANGED'
    | 'SETTLEMENT_CYCLE_FINALIZED'
    | 'SETTLEMENT_CYCLE_NOT_FOUND'
    | 'FINANCIAL_COMMITMENT_NOT_FOUND'
    | 'INTER_MEMBER_OBLIGATION_NOT_FOUND'
    | 'SETTLEMENT_TRANSFER_NOT_FOUND';
const messages: Record<FinancesErrorCode, string> = {
    VALIDATION_ERROR: 'Verifique os dados informados.',
    SHARED_SPACE_REQUIRED: 'Esta ação requer um espaço compartilhado.',
    CONCURRENT_MODIFICATION:
        'A regra foi alterada. Atualize os dados e confirme novamente.',
    IDEMPOTENCY_KEY_REUSED: 'Esta chave já foi usada para outra solicitação.',
    EXPENSE_OPTIONS_CHANGED:
        'As opções mudaram. Atualize e confirme novamente.',
    SETTLEMENT_CYCLE_FINALIZED: 'Este acerto já foi finalizado.',
    SETTLEMENT_CYCLE_NOT_FOUND: 'Acerto não encontrado.',
    FINANCIAL_COMMITMENT_NOT_FOUND: 'Despesa não encontrada.',
    INTER_MEMBER_OBLIGATION_NOT_FOUND: 'Pendência não encontrada.',
    SETTLEMENT_TRANSFER_NOT_FOUND: 'Transferência não encontrada.',
};
export class FinancesError extends Error {
    constructor(
        public readonly code: FinancesErrorCode,
        public readonly fields: readonly string[] = [],
    ) {
        super(messages[code]);
    }
}
