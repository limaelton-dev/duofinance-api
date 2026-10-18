import {
    effectivePurchaseJoinSql,
    effectivePurchaseQuantitySql,
} from './shopping-purchases.sql.js';

export const shoppingProgressSql = `WITH scoped_items AS (
    SELECT * FROM shopping_items WHERE space_id=$1 AND list_id=ANY($2::uuid[])
), purchase_totals AS (
    SELECT p.item_id,SUM(${effectivePurchaseQuantitySql}) AS purchased_quantity FROM shopping_purchase_records p
    JOIN scoped_items i ON i.space_id=p.space_id AND i.list_id=p.list_id AND i.id=p.item_id
    ${effectivePurchaseJoinSql}
    GROUP BY p.item_id
), item_progress AS (
    SELECT i.*,COALESCE(p.purchased_quantity,0) AS purchased_quantity,
        CASE WHEN COALESCE(p.purchased_quantity,0)>=i.desired_quantity THEN 1 ELSE 0 END AS item_group
    FROM scoped_items i LEFT JOIN purchase_totals p ON p.item_id=i.id
)`;
export const shoppingItemFilterSql = `($3 IN ('ALL','ACTIVE') OR ($3='PENDING' AND purchased_quantity<desired_quantity) OR ($3='PURCHASED' AND purchased_quantity>=desired_quantity))`;
export const shoppingItemColumnsSql = `id,list_id AS "listId",description,desired_quantity AS "desiredQuantity",unit,
    creator_person_id AS "creatorPersonId",creator_member_id AS "creatorMemberId",creator_display_name AS "creatorDisplayName",created_at AS "createdAt",purchased_quantity::text AS "purchasedQuantity"`;
