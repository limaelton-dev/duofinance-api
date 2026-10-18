import { describe, expect, it } from 'vitest';
import {
    changeItemNeed,
    itemProgress,
    validateItem,
    type ShoppingItem,
} from './shopping-item.js';

const item: ShoppingItem = {
    id: 'item',
    listId: 'list',
    description: 'Arroz',
    desiredQuantity: '1.25',
    unit: 'kg',
    creator: { personId: 'person', memberId: null, displayName: 'Pessoa' },
    createdAt: '2026-10-18T14:00:00.000Z',
};

describe('shopping item needs', () => {
    it('changes the requested quantity and preserves description, author, unit and creation', () => {
        const changed = changeItemNeed(item, { desiredQuantity: '0.500' });
        expect(changed).toEqual({ ...item, desiredQuantity: '0.5' });
        expect(item.desiredQuantity).toBe('1.25');
        expect(itemProgress(changed)).toMatchObject({
            desiredQuantity: '0.5',
            purchasedQuantity: '0',
            remainingQuantity: '0.5',
            status: 'PENDING',
        });
    });
    it('treats units as optional descriptive text without converting quantities', () => {
        expect(changeItemNeed(item, { unit: 'pacote' })).toEqual({
            ...item,
            unit: 'pacote',
        });
        expect(changeItemNeed(item, { unit: null })).toEqual({
            ...item,
            unit: null,
        });
    });
    it('requires at least one explicit need field and accepts an explicit repeated value', () => {
        expect(() => changeItemNeed(item, {})).toThrow();
        expect(changeItemNeed(item, { desiredQuantity: '1.25' })).toEqual(item);
    });
    it('allows unit-only changes and increases after an excess purchase, while rejecting a further reduction', () => {
        const exceeded = { ...item, desiredQuantity: '4' };
        expect(changeItemNeed(exceeded, { unit: 'pacote' }, '5')).toEqual({
            ...exceeded,
            unit: 'pacote',
        });
        expect(
            changeItemNeed(exceeded, { desiredQuantity: '4.5' }, '5'),
        ).toEqual({ ...exceeded, desiredQuantity: '4.5' });
        expect(() =>
            changeItemNeed(exceeded, { desiredQuantity: '3' }, '5'),
        ).toThrow();
    });
    it('derives partial, purchased and excess progress without rounding or negative remaining quantities', () => {
        const needed = { ...item, desiredQuantity: '4' };
        expect(itemProgress(needed, '2')).toMatchObject({
            purchasedQuantity: '2',
            remainingQuantity: '2',
            status: 'PARTIALLY_PURCHASED',
        });
        expect(itemProgress(needed, '4')).toMatchObject({
            purchasedQuantity: '4',
            remainingQuantity: '0',
            status: 'PURCHASED',
        });
        expect(itemProgress(needed, '5')).toMatchObject({
            purchasedQuantity: '5',
            remainingQuantity: '0',
            status: 'PURCHASED',
        });
        expect(
            itemProgress({ ...item, desiredQuantity: '0.301' }, '0.3'),
        ).toMatchObject({
            remainingQuantity: '0.001',
            status: 'PARTIALLY_PURCHASED',
        });
    });
    it.each([
        { description: '' },
        { description: ' arroz ' },
        { description: 'x'.repeat(501) },
        { desiredQuantity: '0' },
        { unit: '' },
        { unit: ' kg ' },
        { unit: 'x'.repeat(31) },
    ])('rejects invalid item fields %j', (invalid) => {
        expect(() => validateItem({ ...item, ...invalid })).toThrow();
    });
});
