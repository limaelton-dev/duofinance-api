import {
    Check,
    Column,
    Entity,
    ForeignKey,
    Index,
    PrimaryColumn,
    Unique,
} from 'typeorm';
import type { ShoppingList, ShoppingAuthor } from '../domain/shopping-list.js';
import type { ShoppingItem } from '../domain/shopping-item.js';
import { Quantity } from '../domain/quantity.js';
import type { PurchaseRecord } from '../domain/purchase-record.js';

@Entity('shopping_lists')
@Index('IDX_shopping_list_page', ['spaceId', 'status', 'createdAt', 'id'])
@Unique('UQ_shopping_list_space', ['spaceId', 'id'])
@Check(
    'CHK_shopping_list_values',
    `version > 0 AND (name IS NULL OR (length(name) BETWEEN 1 AND 120 AND name=btrim(name))) AND status IN ('ACTIVE','ARCHIVED') AND ((status='ARCHIVED')=(archived_at IS NOT NULL))`,
)
@ForeignKey('spaces', ['spaceId'], ['id'], {
    name: 'FK_shopping_list_space',
    onDelete: 'RESTRICT',
})
@ForeignKey('persons', ['creatorPersonId'], ['id'], {
    name: 'FK_shopping_list_creator',
    onDelete: 'RESTRICT',
})
@ForeignKey(
    'space_members',
    ['spaceId', 'creatorMemberId'],
    ['spaceId', 'id'],
    { name: 'FK_shopping_list_creator_member', onDelete: 'RESTRICT' },
)
export class ShoppingListOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ type: 'varchar', length: 120, nullable: true })
    name!: string | null;
    @Column({ type: 'varchar', length: 8 }) status!: ShoppingList['status'];
    @Column({ type: 'integer' }) version!: number;
    @Column({ name: 'creator_person_id', type: 'uuid' })
    creatorPersonId!: string;
    @Column({ name: 'creator_member_id', type: 'uuid', nullable: true })
    creatorMemberId!: string | null;
    @Column({ name: 'creator_display_name', type: 'varchar', length: 80 })
    creatorDisplayName!: string;
    @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
    @Column({ name: 'archived_at', type: 'timestamptz', nullable: true })
    archivedAt!: Date | null;
}
@Entity('shopping_items')
@Index('IDX_shopping_item_page', ['spaceId', 'listId', 'createdAt', 'id'])
@Unique('UQ_shopping_item_context', ['spaceId', 'listId', 'id'])
@Check(
    'CHK_shopping_item_values',
    `length(description) BETWEEN 1 AND 500 AND description=btrim(description) AND desired_quantity > 0 AND (unit IS NULL OR (length(unit) BETWEEN 1 AND 30 AND unit=btrim(unit)))`,
)
@ForeignKey('shopping_lists', ['spaceId', 'listId'], ['spaceId', 'id'], {
    name: 'FK_shopping_item_list',
    onDelete: 'RESTRICT',
})
@ForeignKey('persons', ['creatorPersonId'], ['id'], {
    name: 'FK_shopping_item_creator',
    onDelete: 'RESTRICT',
})
@ForeignKey(
    'space_members',
    ['spaceId', 'creatorMemberId'],
    ['spaceId', 'id'],
    { name: 'FK_shopping_item_creator_member', onDelete: 'RESTRICT' },
)
export class ShoppingItemOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'list_id', type: 'uuid' }) listId!: string;
    @Column({ type: 'varchar', length: 500 }) description!: string;
    @Column({
        name: 'desired_quantity',
        type: 'numeric',
        precision: 15,
        scale: 3,
    })
    desiredQuantity!: string;
    @Column({ type: 'varchar', length: 30, nullable: true }) unit!:
        string | null;
    @Column({ name: 'creator_person_id', type: 'uuid' })
    creatorPersonId!: string;
    @Column({ name: 'creator_member_id', type: 'uuid', nullable: true })
    creatorMemberId!: string | null;
    @Column({ name: 'creator_display_name', type: 'varchar', length: 80 })
    creatorDisplayName!: string;
    @Column({ name: 'created_at', type: 'timestamptz' }) createdAt!: Date;
}
@Entity('shopping_purchase_records')
@Index('IDX_shopping_purchase_page', [
    'spaceId',
    'listId',
    'itemId',
    'registeredAt',
    'id',
])
@Unique('UQ_shopping_purchase_context', ['spaceId', 'listId', 'itemId', 'id'])
@Check(
    'CHK_shopping_purchase_values',
    `quantity > 0 AND (unit IS NULL OR (length(unit) BETWEEN 1 AND 30 AND unit=btrim(unit)))`,
)
@ForeignKey(
    'shopping_items',
    ['spaceId', 'listId', 'itemId'],
    ['spaceId', 'listId', 'id'],
    { name: 'FK_shopping_purchase_item', onDelete: 'RESTRICT' },
)
@ForeignKey('persons', ['registeredByPersonId'], ['id'], {
    name: 'FK_shopping_purchase_author',
    onDelete: 'RESTRICT',
})
@ForeignKey(
    'space_members',
    ['spaceId', 'registeredByMemberId'],
    ['spaceId', 'id'],
    { name: 'FK_shopping_purchase_member', onDelete: 'RESTRICT' },
)
export class PurchaseRecordOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'list_id', type: 'uuid' }) listId!: string;
    @Column({ name: 'item_id', type: 'uuid' }) itemId!: string;
    @Column({ type: 'numeric', precision: 15, scale: 3 }) quantity!: string;
    @Column({ type: 'varchar', length: 30, nullable: true }) unit!:
        string | null;
    @Column({ name: 'registered_by_person_id', type: 'uuid' })
    registeredByPersonId!: string;
    @Column({ name: 'registered_by_member_id', type: 'uuid', nullable: true })
    registeredByMemberId!: string | null;
    @Column({ name: 'registered_by_display_name', type: 'varchar', length: 80 })
    registeredByDisplayName!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
@Entity('shopping_history')
@Index('IDX_shopping_history_page', ['spaceId', 'aggregateId', 'sequence'])
@Unique('UQ_shopping_history_version', ['aggregateId', 'sequence'])
@Check('CHK_shopping_history_sequence', 'sequence > 0')
@ForeignKey('shopping_lists', ['spaceId', 'aggregateId'], ['spaceId', 'id'], {
    name: 'FK_shopping_history_list',
    onDelete: 'RESTRICT',
})
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_shopping_history_actor',
    onDelete: 'RESTRICT',
})
@ForeignKey('space_members', ['spaceId', 'actorMemberId'], ['spaceId', 'id'], {
    name: 'FK_shopping_history_member',
    onDelete: 'RESTRICT',
})
export class ShoppingHistoryOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'aggregate_id', type: 'uuid' }) aggregateId!: string;
    @Column({ type: 'integer' }) sequence!: number;
    @Column({ type: 'varchar', length: 40 }) type!: string;
    @Column({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @Column({ name: 'actor_member_id', type: 'uuid', nullable: true })
    actorMemberId!: string | null;
    @Column({ name: 'actor_display_name', type: 'varchar', length: 80 })
    actorDisplayName!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
    @Column({ type: 'jsonb' }) data!: object;
}
@Entity('shopping_command_receipts')
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_shopping_receipt_actor',
    onDelete: 'RESTRICT',
})
export class ShoppingReceiptOrmEntity {
    @PrimaryColumn({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @PrimaryColumn({ type: 'varchar', length: 60 }) operation!: string;
    @PrimaryColumn({ type: 'uuid' }) key!: string;
    @Column({ type: 'varchar', length: 64 }) digest!: string;
    @Column({ type: 'jsonb' }) result!: object;
}
@Entity('shopping_command_audit')
@Index('IDX_shopping_audit_space', ['spaceId', 'registeredAt'])
@ForeignKey('shopping_lists', ['spaceId', 'aggregateId'], ['spaceId', 'id'], {
    name: 'FK_shopping_audit_list',
    onDelete: 'RESTRICT',
})
@ForeignKey('persons', ['actorId'], ['id'], {
    name: 'FK_shopping_audit_actor',
    onDelete: 'RESTRICT',
})
export class ShoppingAuditOrmEntity {
    @PrimaryColumn('uuid') id!: string;
    @Column({ name: 'actor_id', type: 'uuid' }) actorId!: string;
    @Column({ name: 'space_id', type: 'uuid' }) spaceId!: string;
    @Column({ name: 'aggregate_id', type: 'uuid' }) aggregateId!: string;
    @Column({ type: 'varchar', length: 60 }) action!: string;
    @Column({ type: 'uuid' }) key!: string;
    @Column({ name: 'registered_at', type: 'timestamptz' }) registeredAt!: Date;
}
export function listToRow(list: ShoppingList): ShoppingListOrmEntity {
    const { creator, createdAt, archivedAt, ...rest } = list;
    return {
        ...rest,
        creatorPersonId: creator.personId,
        creatorMemberId: creator.memberId,
        creatorDisplayName: creator.displayName,
        createdAt: new Date(createdAt),
        archivedAt: archivedAt ? new Date(archivedAt) : null,
    };
}
export function rowToList(row: ShoppingListOrmEntity): ShoppingList {
    const {
        creatorPersonId,
        creatorMemberId,
        creatorDisplayName,
        createdAt,
        archivedAt,
        ...rest
    } = row;
    const creator: ShoppingAuthor = {
        personId: creatorPersonId,
        memberId: creatorMemberId,
        displayName: creatorDisplayName,
    };
    return {
        ...rest,
        creator,
        createdAt: createdAt.toISOString(),
        archivedAt: archivedAt?.toISOString() ?? null,
    };
}
export function itemToRow(
    spaceId: string,
    item: ShoppingItem,
): ShoppingItemOrmEntity {
    const { creator, createdAt, ...rest } = item;
    return {
        ...rest,
        spaceId,
        creatorPersonId: creator.personId,
        creatorMemberId: creator.memberId,
        creatorDisplayName: creator.displayName,
        createdAt: new Date(createdAt),
    };
}
export function rowToItem(row: ShoppingItemOrmEntity): ShoppingItem {
    return {
        id: row.id,
        listId: row.listId,
        description: row.description,
        desiredQuantity: Quantity.from(
            row.desiredQuantity,
            'desiredQuantity',
        ).toString(),
        unit: row.unit,
        creator: {
            personId: row.creatorPersonId,
            memberId: row.creatorMemberId,
            displayName: row.creatorDisplayName,
        },
        createdAt: row.createdAt.toISOString(),
    };
}
export function purchaseToRow(
    spaceId: string,
    purchase: PurchaseRecord,
): PurchaseRecordOrmEntity {
    const { registeredBy, registeredAt, ...rest } = purchase;
    return {
        ...rest,
        spaceId,
        registeredByPersonId: registeredBy.personId,
        registeredByMemberId: registeredBy.memberId,
        registeredByDisplayName: registeredBy.displayName,
        registeredAt: new Date(registeredAt),
    };
}
export function rowToPurchase(row: PurchaseRecordOrmEntity): PurchaseRecord {
    return {
        id: row.id,
        listId: row.listId,
        itemId: row.itemId,
        quantity: Quantity.from(row.quantity).toString(),
        unit: row.unit,
        registeredBy: {
            personId: row.registeredByPersonId,
            memberId: row.registeredByMemberId,
            displayName: row.registeredByDisplayName,
        },
        registeredAt: row.registeredAt.toISOString(),
    };
}
