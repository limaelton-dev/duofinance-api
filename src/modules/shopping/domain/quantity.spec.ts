import { describe, expect, it } from 'vitest';
import { Quantity } from './quantity.js';

describe('exact shopping quantities', () => {
    it('normalizes decimal strings without losing thousandths or large values', () => {
        expect(Quantity.from('1.250').toString()).toBe('1.25');
        expect(Quantity.from('0.001').scaledUnits).toBe(1);
        expect(Quantity.from('999999999999.999').toString()).toBe(
            '999999999999.999',
        );
        expect(Quantity.from('0', 'purchasedQuantity', true).toString()).toBe(
            '0',
        );
    });
    it('adds exact fractional units and floors subtraction at zero', () => {
        expect(Quantity.from('0.1').add(Quantity.from('0.2')).toString()).toBe(
            '0.3',
        );
        expect(
            Quantity.from('1').subtractFloor(Quantity.from('0.001')).toString(),
        ).toBe('0.999');
        expect(
            Quantity.from('1').subtractFloor(Quantity.from('2')).toString(),
        ).toBe('0');
    });
    it.each([
        '0',
        '-1',
        '1.0001',
        '1000000000000',
        '1e3',
        '1,5',
        'NaN',
        '',
        ' 1 ',
        '001.25',
        1,
        null,
    ])('rejects invalid positive quantity %j', (value) =>
        expect(() => Quantity.from(value)).toThrow(),
    );
    it('rejects arithmetic overflow rather than rounding or truncating', () => {
        expect(() =>
            Quantity.from('999999999999.999').add(Quantity.from('0.001')),
        ).toThrow();
    });
});
