import { describe, expect, it } from 'vitest';
import {
    renameList,
    archiveList,
    validateListName,
    type ShoppingList,
} from './shopping-list.js';

const list: ShoppingList = {
    id: 'list',
    spaceId: 'space',
    name: 'Mercado',
    status: 'ACTIVE',
    version: 1,
    creator: { personId: 'person', memberId: null, displayName: 'Pessoa' },
    createdAt: '2026-10-18T14:00:00.000Z',
    archivedAt: null,
};

describe('shopping list invariants', () => {
    it('archives explicitly and preserves the list identity, author and creation', () => {
        const archived = archiveList(list, '2026-10-18T15:00:00.000Z');
        expect(archived).toEqual({
            ...list,
            status: 'ARCHIVED',
            archivedAt: '2026-10-18T15:00:00.000Z',
            version: 2,
        });
        expect(list.status).toBe('ACTIVE');
        expect(() =>
            archiveList(archived, '2026-10-18T16:00:00.000Z'),
        ).toThrow();
    });
    it('renames or clears a name without altering the original author or creation', () => {
        const changed = renameList(list, null);
        expect(changed).toEqual({ ...list, name: null, version: 2 });
        expect(list).toMatchObject({ name: 'Mercado', version: 1 });
        expect(renameList(changed, 'Feira')).toMatchObject({
            name: 'Feira',
            version: 3,
        });
    });
    it('rejects changing an archived list', () => {
        expect(() =>
            renameList({ ...list, status: 'ARCHIVED' }, 'Nova'),
        ).toThrow();
    });
    it.each(['', ' ', ' com espaços ', 'x'.repeat(121)])(
        'rejects invalid normalized names %j',
        (name) => expect(() => validateListName(name)).toThrow(),
    );
    it.each([null, 'Feira', 'x'.repeat(120)])(
        'accepts optional or bounded names %j',
        (name) => expect(() => validateListName(name)).not.toThrow(),
    );
});
