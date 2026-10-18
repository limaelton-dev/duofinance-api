import { shoppingProgressCtesSql } from './shopping-items.sql.js';

export const shoppingAttentionSql = `WITH active_lists AS MATERIALIZED (
    SELECT id,name,created_at FROM shopping_lists WHERE space_id=$1 AND status='ACTIVE'
), scoped_items AS (
    SELECT i.* FROM shopping_items i JOIN active_lists l ON l.id=i.list_id
    WHERE i.space_id=$1 AND i.removed_at IS NULL
), ${shoppingProgressCtesSql}, list_summaries AS (
    SELECT l.id,l.name,l.created_at,COUNT(i.id)::integer AS active_count,
        COUNT(i.id) FILTER (WHERE i.purchased_quantity<i.desired_quantity)::integer AS actionable_count,
        COUNT(i.id) FILTER (WHERE i.purchased_quantity>0 AND i.purchased_quantity<i.desired_quantity)::integer AS partial_count
    FROM active_lists l LEFT JOIN item_progress i ON i.list_id=l.id GROUP BY l.id,l.name,l.created_at
), preview_lists AS MATERIALIZED (
    SELECT * FROM list_summaries WHERE actionable_count>0 ORDER BY (partial_count>0) DESC,created_at,id LIMIT 4
), ranked_items AS (
    SELECT i.*,ROW_NUMBER() OVER (PARTITION BY i.list_id ORDER BY (i.purchased_quantity>0) DESC,i.created_at,i.id) ordinal
    FROM item_progress i JOIN preview_lists l ON l.id=i.list_id WHERE i.purchased_quantity<i.desired_quantity
), item_previews AS (
    SELECT list_id,JSONB_AGG(JSONB_BUILD_OBJECT(
        'id',id,'description',description,'unit',unit,'desiredQuantity',desired_quantity::text,
        'purchasedQuantity',purchased_quantity::text,'remainingQuantity',GREATEST(desired_quantity-purchased_quantity,0)::text,
        'status',CASE WHEN purchased_quantity=0 THEN 'PENDING' ELSE 'PARTIALLY_PURCHASED' END
    ) ORDER BY (purchased_quantity>0) DESC,created_at,id) AS items FROM ranked_items WHERE ordinal<=4 GROUP BY list_id
)
SELECT (SELECT COUNT(*)::integer FROM list_summaries WHERE actionable_count>0) AS "totalCount",
    (SELECT COUNT(*)::integer FROM active_lists) AS "activeListCount",
    COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'id',l.id,'name',l.name,'status','ACTIVE',
        'summary',JSONB_BUILD_OBJECT('activeItemCount',l.active_count,'actionableItemCount',l.actionable_count,'isComplete',l.actionable_count=0),
        'pendingItems',JSONB_BUILD_OBJECT('items',COALESCE(i.items,'[]'::jsonb),'totalCount',l.actionable_count,'hasMore',l.actionable_count>4)
    ) ORDER BY (l.partial_count>0) DESC,l.created_at,l.id) FROM preview_lists l LEFT JOIN item_previews i ON i.list_id=l.id),'[]'::jsonb) AS items`;
