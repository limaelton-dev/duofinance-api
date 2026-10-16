import { describe, expect, it } from 'vitest';
import { RecurrenceRule } from './recurrence-rule.js';

describe('fixed recurrence schedule', () => {
    it('clamps days to the last day of each month and uses inclusive endpoints', () => {
        const rule = new RecurrenceRule(
            { frequency: 'MONTHLY', dayOfMonth: 31 },
            '2026-01-31',
            '2026-04-30',
        );
        expect(rule.dateInMonth('2026-02')).toBe('2026-02-28');
        expect(rule.dateInMonth('2026-04')).toBe('2026-04-30');
        expect(rule.dateInMonth('2026-05')).toBeNull();
        expect(rule.firstOnOrAfter('2026-02-28')).toBe('2026-02-28');
        expect(rule.firstOnOrAfter('2026-03-01')).toBe('2026-03-31');
        expect(rule.firstOnOrAfter('2026-05-01')).toBeNull();
    });

    it('projects an annual leap-day commitment without materialization', () => {
        const rule = new RecurrenceRule(
            { frequency: 'ANNUAL', monthOfYear: 2, dayOfMonth: 29 },
            '2026-01-01',
        );
        expect(rule.dateInMonth('2027-02')).toBe('2027-02-28');
        expect(rule.dateInMonth('2028-02')).toBe('2028-02-29');
        expect(rule.dateInMonth('2028-03')).toBeNull();
        expect(rule.contains('2028-02-29')).toBe(true);
        expect(rule.contains('2028-02-28')).toBe(false);
    });

    it('starts with the next scheduled date when the opening date has passed this month', () => {
        const rule = new RecurrenceRule(
            { frequency: 'MONTHLY', dayOfMonth: 10 },
            '2026-10-15',
        );
        expect(rule.dateInMonth('2026-10')).toBeNull();
        expect(rule.firstOnOrAfter('2026-10-15')).toBe('2026-11-10');
    });
});
