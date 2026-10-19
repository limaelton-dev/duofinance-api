import { describe, expect, it } from 'vitest';
import { correctedPurchased } from './purchase-correction.js';

describe('purchase correction arithmetic', () => {
    it('replaces the previous effective quantity, including a correction to zero', () => {
        expect(correctedPurchased('4', '2', '1')).toBe('3');
        expect(correctedPurchased('3', '1', '0')).toBe('2');
        expect(correctedPurchased('0.301', '0.2', '0.1')).toBe('0.201');
    });
    it('subtracts the replaced quantity before testing the new total limit', () => {
        expect(
            correctedPurchased(
                '999999999999.999',
                '999999999999.999',
                '999999999999.999',
            ),
        ).toBe('999999999999.999');
        expect(() =>
            correctedPurchased('999999999999.999', '0.001', '0.002'),
        ).toThrow();
    });
    it('rejects negative corrections and inconsistent previous totals', () => {
        expect(() => correctedPurchased('2', '1', '-1')).toThrow();
        expect(() => correctedPurchased('1', '2', '0')).toThrow();
    });
});
