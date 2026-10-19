export class ShoppingError extends Error {
    constructor(
        public readonly code:
            | 'SHOPPING_LIST_NOT_FOUND'
            | 'SHOPPING_ITEM_NOT_FOUND'
            | 'SHOPPING_PURCHASE_NOT_FOUND'
            | 'CONCURRENT_MODIFICATION'
            | 'IDEMPOTENCY_KEY_REUSED'
            | 'SHOPPING_LIST_ARCHIVED'
            | 'SHOPPING_ITEM_REMOVED'
            | 'DESIRED_QUANTITY_BELOW_PURCHASED'
            | 'VALIDATION_ERROR',
        public readonly field?: string,
    ) {
        super(
            {
                SHOPPING_LIST_NOT_FOUND: 'Lista de compras não encontrada.',
                SHOPPING_ITEM_NOT_FOUND:
                    'Item não encontrado nesta lista de compras.',
                SHOPPING_PURCHASE_NOT_FOUND:
                    'Registro de compra não encontrado neste item.',
                CONCURRENT_MODIFICATION:
                    'Os dados foram alterados. Atualize e tente novamente.',
                IDEMPOTENCY_KEY_REUSED:
                    'Esta chave já foi utilizada com outros dados.',
                SHOPPING_LIST_ARCHIVED:
                    'Esta lista está arquivada e permite somente consulta.',
                SHOPPING_ITEM_REMOVED:
                    'Este item foi removido e permite somente consulta.',
                DESIRED_QUANTITY_BELOW_PURCHASED:
                    'A quantidade desejada não pode ser menor que a quantidade já comprada.',
                VALIDATION_ERROR: 'Verifique os dados informados.',
            }[code],
        );
    }
}
