export class ShoppingError extends Error {
    constructor(
        public readonly code:
            | 'SHOPPING_LIST_NOT_FOUND'
            | 'CONCURRENT_MODIFICATION'
            | 'IDEMPOTENCY_KEY_REUSED'
            | 'SHOPPING_LIST_ARCHIVED'
            | 'VALIDATION_ERROR',
        public readonly field?: string,
    ) {
        super(
            {
                SHOPPING_LIST_NOT_FOUND: 'Lista de compras não encontrada.',
                CONCURRENT_MODIFICATION:
                    'Os dados foram alterados. Atualize e tente novamente.',
                IDEMPOTENCY_KEY_REUSED:
                    'Esta chave já foi utilizada com outros dados.',
                SHOPPING_LIST_ARCHIVED:
                    'Esta lista está arquivada e permite somente consulta.',
                VALIDATION_ERROR: 'Verifique os dados informados.',
            }[code],
        );
    }
}
