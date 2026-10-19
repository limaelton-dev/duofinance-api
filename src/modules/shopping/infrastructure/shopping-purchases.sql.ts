export const effectivePurchaseJoinSql = `LEFT JOIN LATERAL (
    SELECT c.quantity FROM shopping_purchase_corrections c
    WHERE c.space_id=p.space_id AND c.list_id=p.list_id AND c.item_id=p.item_id AND c.purchase_id=p.id
    ORDER BY c.sequence DESC LIMIT 1
) correction ON true`;
export const effectivePurchaseQuantitySql =
    'COALESCE(correction.quantity,p.quantity)';
