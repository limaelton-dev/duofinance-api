export type FinancesErrorCode =
    | 'EXTERNAL_LIABILITY_NOT_FOUND'
    | 'EXTERNAL_LIABILITY_ALREADY_SETTLED'
    | 'EXTERNAL_LIABILITY_HOLDER_REQUIRED'
    | 'VALIDATION_ERROR'
    | 'SHARED_SPACE_REQUIRED'
    | 'PERSONAL_SPACE_REQUIRED'
    | 'CONCURRENT_MODIFICATION'
    | 'IDEMPOTENCY_KEY_REUSED'
    | 'EXPENSE_OPTIONS_CHANGED'
    | 'SETTLEMENT_CYCLE_FINALIZED'
    | 'SETTLEMENT_CYCLE_NOT_FOUND'
    | 'FINANCIAL_COMMITMENT_NOT_FOUND'
    | 'INTER_MEMBER_OBLIGATION_NOT_FOUND'
    | 'SETTLEMENT_TRANSFER_NOT_FOUND'
    | 'INCOME_ALREADY_RECEIVED'
    | 'EXPENSE_ALREADY_PAID'
    | 'INCOME_OPTIONS_CHANGED';
const messages: Record<FinancesErrorCode, string> = {
    EXTERNAL_LIABILITY_NOT_FOUND:
        'Obriga\u00e7\u00e3o externa n\u00e3o encontrada.',
    EXTERNAL_LIABILITY_ALREADY_SETTLED:
        'Esta obriga\u00e7\u00e3o externa j\u00e1 foi liquidada.',
    EXTERNAL_LIABILITY_HOLDER_REQUIRED:
        'Somente o titular pode registrar este pagamento.',
    VALIDATION_ERROR: 'Verifique os dados informados.',
    SHARED_SPACE_REQUIRED: 'Esta ação requer um espaço compartilhado.',
    PERSONAL_SPACE_REQUIRED: 'Esta ação requer um espaço pessoal.',
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
    INCOME_ALREADY_RECEIVED: 'Esta receita já foi recebida.',
    EXPENSE_ALREADY_PAID: 'Esta despesa já foi integralmente realizada.',
    INCOME_OPTIONS_CHANGED: 'As opções mudaram. Atualize e confirme novamente.',
};
export class FinancesError extends Error {
    constructor(
        public readonly code: FinancesErrorCode,
        public readonly fields: readonly string[] = [],
    ) {
        super(messages[code]);
    }
}
