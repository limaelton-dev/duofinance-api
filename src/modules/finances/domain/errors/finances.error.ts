export type FinancesErrorCode =
    | 'VALIDATION_ERROR'
    | 'SHARED_SPACE_REQUIRED'
    | 'CONCURRENT_MODIFICATION'
    | 'IDEMPOTENCY_KEY_REUSED'
    | 'EXPENSE_OPTIONS_CHANGED'
    | 'SETTLEMENT_CYCLE_FINALIZED'
    | 'SETTLEMENT_CYCLE_NOT_FOUND'
    | 'FINANCIAL_COMMITMENT_NOT_FOUND';
const messages: Record<FinancesErrorCode, string> = {
    VALIDATION_ERROR: 'Informe uma regra e uma data válidas.',
    SHARED_SPACE_REQUIRED:
        'A regra de acerto se aplica somente a espaços compartilhados.',
    CONCURRENT_MODIFICATION:
        'A regra foi alterada. Atualize os dados e confirme novamente.',
    IDEMPOTENCY_KEY_REUSED: 'Esta chave já foi usada para outra solicitação.',
    EXPENSE_OPTIONS_CHANGED:
        'As opções mudaram. Atualize e confirme novamente.',
    SETTLEMENT_CYCLE_FINALIZED: 'Este acerto já foi finalizado.',
    SETTLEMENT_CYCLE_NOT_FOUND: 'Acerto não encontrado.',
    FINANCIAL_COMMITMENT_NOT_FOUND: 'Despesa não encontrada.',
};
export class FinancesError extends Error {
    constructor(public readonly code: FinancesErrorCode) {
        super(messages[code]);
    }
}
