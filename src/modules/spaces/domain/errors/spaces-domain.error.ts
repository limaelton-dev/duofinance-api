const messages = {
    CLOSURE_CONFIRMATION_NOT_READY:
        'A confirmação exige plano aprovado por todos e todas as pendências financeiras resolvidas.',
    CLOSURE_FINANCIAL_STATE_CHANGED:
        'O estado financeiro mudou. Consulte o resumo final antes de confirmar.',
    CLOSURE_ALREADY_CONFIRMED:
        'Você já confirmou o encerramento para este estado financeiro.',
    CLOSURE_COMPLETION_NOT_PREPARED:
        'A conclusão precisa finalizar os contextos do espaço na mesma operação.',
    CLOSURE_CANCELLATION_PENDING:
        'Há um pedido de cancelamento pendente. Decida o cancelamento ou proponha novamente o plano.',
    CLOSURE_ALREADY_REQUESTED_CANCELLATION:
        'Você já concordou com este pedido de cancelamento.',
    CLOSURE_CANCELLATION_NOT_ALLOWED:
        'Somente o solicitante pode cancelar antes da aprovação do outro participante.',
    CLOSURE_PARTICIPANTS_CHANGED:
        'A participação histórica do espaço mudou. Consulte o estado atual do encerramento.',
    CLOSURE_PLAN_INCOMPLETE:
        'Defina o destino de todos os compromissos futuros antes de propor ou aprovar.',
    CLOSURE_PLAN_OBSOLETE:
        'As consequências financeiras mudaram. Revise o plano antes de concordar.',
    CLOSURE_PLAN_DECISION_NOT_ALLOWED:
        'Somente o outro participante pode aprovar ou rejeitar esta proposta.',
    CLOSURE_PLAN_NOT_PROPOSED:
        'O plano precisa estar proposto para receber esta decisão.',
    CLOSURE_PROPOSAL_CHANGED:
        'As consequências financeiras mudaram. Revise e proponha uma nova versão do plano.',
    CLOSURE_DESTINATION_INVALID:
        'O destino informado não é válido para esta origem ou participante do plano.',
    CLOSURE_PROCESS_NOT_FOUND: 'Não há processo de encerramento neste espaço.',
    CLOSURE_PROCESS_NOT_OPEN:
        'O encerramento não está aberto. Consulte o estado atual do espaço.',
    CLOSURE_CUTOFF_INVALID:
        'Informe uma data de corte válida, igual ou posterior ao corte vigente.',
    CLOSURE_PLAN_UNCHANGED:
        'A data de corte já está definida nesta revisão do plano.',
    CLOSURE_HISTORY_CURSOR_INVALID:
        'O cursor do histórico de encerramento é inválido.',
    SHARED_SPACE_REQUIRED:
        'Esta ação se aplica somente a espaços compartilhados.',
    VALIDATION_ERROR: 'Informe um nome válido para o espaço.',
    SPACE_NOT_FOUND: 'Espaço não encontrado.',
    SPACE_NOT_ACTIVE: 'O espaço não está ativo.',
    SPACE_MEMBER_LIMIT_REACHED: 'O espaço já possui dois membros ativos.',
    INVITATION_ISSUER_REQUIRED: 'Somente o criador pode gerar convites.',
    INVITATION_ALREADY_PENDING: 'Já existe um convite pendente válido.',
    INVITATION_NOT_REPLACEABLE: 'Este convite não pode ser substituído.',
    INVITATION_UNAVAILABLE:
        'Não foi possível usar este convite. Ele pode ter sido cancelado, expirado ou já utilizado.',
    INVITATION_RESPONSE_NOT_ALLOWED:
        'O criador e os membros atuais não podem responder a este convite.',
} as const;

export type SpacesDomainErrorCode = keyof typeof messages;

export class SpacesDomainError extends Error {
    constructor(public readonly code: SpacesDomainErrorCode) {
        super(messages[code]);
        this.name = 'SpacesDomainError';
    }
}
