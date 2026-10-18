export class RoutineError extends Error {
    constructor(
        public readonly code:
            | 'TASK_NOT_FOUND'
            | 'RECURRENCE_NOT_FOUND'
            | 'OCCURRENCE_NOT_FOUND'
            | 'CONCURRENT_MODIFICATION'
            | 'IDEMPOTENCY_KEY_REUSED'
            | 'INVALID_TASK_TRANSITION'
            | 'INVALID_ASSIGNEE'
            | 'VALIDATION_ERROR',
        public readonly field?: string,
    ) {
        super(
            {
                TASK_NOT_FOUND: 'Tarefa não encontrada.',
                RECURRENCE_NOT_FOUND: 'Repetição não encontrada.',
                OCCURRENCE_NOT_FOUND:
                    'Ocorrência não encontrada nesta repetição.',
                CONCURRENT_MODIFICATION:
                    'Os dados foram alterados. Atualize e tente novamente.',
                IDEMPOTENCY_KEY_REUSED:
                    'Esta chave já foi utilizada com outros dados.',
                INVALID_TASK_TRANSITION:
                    'Esta ação não é permitida no estado atual da tarefa.',
                INVALID_ASSIGNEE: 'Escolha um responsável ativo deste espaço.',
                VALIDATION_ERROR: 'Verifique os dados informados.',
            }[code],
        );
    }
}
