import { ShoppingError } from './shopping-error.js';

export interface ShoppingAuthor {
    personId: string;
    memberId: string | null;
    displayName: string;
}
export interface ShoppingList {
    id: string;
    spaceId: string;
    name: string | null;
    status: 'ACTIVE' | 'ARCHIVED';
    version: number;
    creator: ShoppingAuthor;
    createdAt: string;
    archivedAt: string | null;
}
export function validateListName(name: string | null) {
    if (
        name !== null &&
        (typeof name !== 'string' ||
            !name.length ||
            name.length > 120 ||
            name !== name.trim())
    )
        throw new ShoppingError('VALIDATION_ERROR', 'name');
}
export function requireActiveList(list: ShoppingList) {
    if (list.status !== 'ACTIVE')
        throw new ShoppingError('SHOPPING_LIST_ARCHIVED');
}
export function renameList(
    list: ShoppingList,
    name: string | null,
): ShoppingList {
    requireActiveList(list);
    validateListName(name);
    return { ...list, name, version: list.version + 1 };
}
