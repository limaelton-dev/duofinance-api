const messages = {
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
