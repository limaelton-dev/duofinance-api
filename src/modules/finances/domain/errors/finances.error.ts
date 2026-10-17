export type FinancesErrorCode =
    | 'INSTALLMENT_SELECTION_CHANGED'
    | 'SETTLEMENT_RESOLUTION_ALREADY_REVERSED'
    | 'REVERSAL_CORRECTION_CYCLE_REQUIRED'
    | 'OBLIGATION_WAIVER_NOT_FOUND'
    | 'SETTLEMENT_OFFSET_NOT_FOUND'
    | 'EXTERNAL_LIABILITY_NOT_FOUND'
    | 'EXTERNAL_LIABILITY_ALREADY_SETTLED'
    | 'EXTERNAL_LIABILITY_HOLDER_REQUIRED'
    | 'VALIDATION_ERROR'
    | 'OBLIGATION_CREDITOR_REQUIRED'
    | 'SHARED_SPACE_REQUIRED'
    | 'PERSONAL_SPACE_REQUIRED'
    | 'CONCURRENT_MODIFICATION'
    | 'IDEMPOTENCY_KEY_REUSED'
    | 'EXPENSE_OPTIONS_CHANGED'
    | 'SETTLEMENT_CYCLE_FINALIZED'
    | 'SETTLEMENT_CYCLE_HAS_OPEN_OBLIGATIONS'
    | 'SETTLEMENT_CYCLE_NOT_FOUND'
    | 'FINANCIAL_COMMITMENT_NOT_FOUND'
    | 'INTER_MEMBER_OBLIGATION_NOT_FOUND'
    | 'SETTLEMENT_TRANSFER_NOT_FOUND'
    | 'INCOME_ALREADY_RECEIVED'
    | 'EXPENSE_ALREADY_PAID'
    | 'OCCURRENCE_ALREADY_RESOLVED'
    | 'OCCURRENCE_VALUE_REQUIRED'
    | 'INCOME_OPTIONS_CHANGED'
    | 'RECURRENCE_ACCEPTANCE_REQUIRED'
    | 'RECURRENCE_ALREADY_TERMINATED';
const messages: Record<FinancesErrorCode, string> = {
    INSTALLMENT_SELECTION_CHANGED:
        'A seleção ou o estado das parcelas mudou. Atualize a prévia e confirme novamente.',
    SETTLEMENT_RESOLUTION_ALREADY_REVERSED:
        'Este acerto já foi integralmente revertido.',
    REVERSAL_CORRECTION_CYCLE_REQUIRED:
        'Escolha um ciclo aberto para registrar a correção sem alterar o acerto finalizado.',
    OBLIGATION_WAIVER_NOT_FOUND: 'Dispensa não encontrada.',
    SETTLEMENT_OFFSET_NOT_FOUND: 'Compensação não encontrada.',
    EXTERNAL_LIABILITY_NOT_FOUND:
        'Obriga\u00e7\u00e3o externa n\u00e3o encontrada.',
    EXTERNAL_LIABILITY_ALREADY_SETTLED:
        'Esta obriga\u00e7\u00e3o externa j\u00e1 foi liquidada.',
    EXTERNAL_LIABILITY_HOLDER_REQUIRED:
        'Somente o titular pode registrar este pagamento.',
    VALIDATION_ERROR: 'Verifique os dados informados.',
    OBLIGATION_CREDITOR_REQUIRED:
        'Somente o credor pode dispensar esta pendência.',
    SHARED_SPACE_REQUIRED: 'Esta ação requer um espaço compartilhado.',
    PERSONAL_SPACE_REQUIRED: 'Esta ação requer um espaço pessoal.',
    CONCURRENT_MODIFICATION:
        'A regra foi alterada. Atualize os dados e confirme novamente.',
    IDEMPOTENCY_KEY_REUSED: 'Esta chave já foi usada para outra solicitação.',
    EXPENSE_OPTIONS_CHANGED:
        'As opções mudaram. Atualize e confirme novamente.',
    SETTLEMENT_CYCLE_FINALIZED: 'Este acerto já foi finalizado.',
    SETTLEMENT_CYCLE_HAS_OPEN_OBLIGATIONS:
        'Ainda existem pendências abertas neste acerto. Resolva os valores antes de finalizar.',
    SETTLEMENT_CYCLE_NOT_FOUND: 'Acerto não encontrado.',
    FINANCIAL_COMMITMENT_NOT_FOUND: 'Despesa não encontrada.',
    INTER_MEMBER_OBLIGATION_NOT_FOUND: 'Pendência não encontrada.',
    SETTLEMENT_TRANSFER_NOT_FOUND: 'Transferência não encontrada.',
    INCOME_ALREADY_RECEIVED: 'Esta receita já foi recebida.',
    EXPENSE_ALREADY_PAID: 'Esta despesa já foi integralmente realizada.',
    OCCURRENCE_ALREADY_RESOLVED:
        'Esta ocorrência já foi realizada ou cancelada. Atualize e confirme novamente.',
    OCCURRENCE_VALUE_REQUIRED:
        'Informe o valor efetivo desta ocorrência antes de registrar a realização.',
    INCOME_OPTIONS_CHANGED: 'As opções mudaram. Atualize e confirme novamente.',
    RECURRENCE_ACCEPTANCE_REQUIRED:
        'Esta alteração exige aceite dos demais membros e ainda não pode ser aplicada.',
    RECURRENCE_ALREADY_TERMINATED: 'Esta recorrência já foi encerrada.',
};
export class FinancesError extends Error {
    constructor(
        public readonly code: FinancesErrorCode,
        public readonly fields: readonly string[] = [],
    ) {
        super(messages[code]);
    }
}
