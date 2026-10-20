import { describe, it, expect } from 'vitest';
import { SettlementRule } from './settlement-rule.js';
import { DefaultSettlementRule } from '../default-settlement-rule/default-settlement-rule.js';
describe('SettlementRule — civil calendar and snapshot', () => {
    it.each([1, 31])('accepts boundary %s', (dayOfMonth) =>
        expect(
            SettlementRule.from({ kind: 'MONTHLY_DAY', dayOfMonth }).dayOfMonth,
        ).toBe(dayOfMonth),
    );
    it.each([0, 32, 1.5, '10', null, undefined, NaN, Infinity])(
        'rejects day %s',
        (dayOfMonth) =>
            expect(() =>
                SettlementRule.from({
                    kind: 'MONTHLY_DAY',
                    dayOfMonth,
                } as never),
            ).toThrow(),
    );
    it('rejects an unknown kind and a null rule', () => {
        expect(() =>
            SettlementRule.from({ kind: 'WEEKLY', dayOfMonth: 10 } as never),
        ).toThrow();
        expect(() => SettlementRule.from(null as never)).toThrow();
    });
    it.each([
        [10, '2026-09-05', '2026-09-10'],
        [10, '2026-09-10', '2026-09-10'],
        [10, '2026-09-11', '2026-10-10'],
        [31, '2026-04-01', '2026-04-30'],
        [31, '2026-04-30', '2026-04-30'],
        [31, '2026-02-28', '2026-02-28'],
        [29, '2028-02-28', '2028-02-29'],
        [31, '2026-12-31', '2026-12-31'],
        [31, '2027-01-01', '2027-01-31'],
        [30, '2026-01-31', '2026-02-28'],
        [31, '2028-02-29', '2028-02-29'],
        [31, '1900-02-01', '1900-02-28'],
        [31, '2000-02-01', '2000-02-29'],
        [10, '2026-12-11', '2027-01-10'],
        [1, '0001-01-01', '0001-01-01'],
    ])('day %s in %s suggests %s', (dayOfMonth, reference, target) =>
        expect(
            SettlementRule.from({
                kind: 'MONTHLY_DAY',
                dayOfMonth,
            }).suggestTargetDate(reference),
        ).toBe(target),
    );
    it.each([
        '2026-02-29',
        '1900-02-29',
        '2026-04-31',
        '2026-00-10',
        '2026-13-10',
        '2026-01-00',
        '2026-1-10',
        '2026-01-10T00:00:00Z',
        '0000-01-01',
        'nope',
        '9999-12-31',
    ])('rejects date %s', (date) =>
        expect(() =>
            SettlementRule.from({
                kind: 'MONTHLY_DAY',
                dayOfMonth: 10,
            }).suggestTargetDate(date),
        ).toThrow(),
    );
    it('preserves the snapshot value after changing only the default rule', () => {
        const original = SettlementRule.from({
            kind: 'MONTHLY_DAY',
            dayOfMonth: 10,
        });
        const snapshot = original.snapshot;
        const aggregate = DefaultSettlementRule.create(
            'space',
            original,
            new Date('2026-01-01Z'),
        );
        expect(
            aggregate.configure(
                SettlementRule.from({ kind: 'MONTHLY_DAY', dayOfMonth: 20 }),
                1,
                new Date('2026-02-01Z'),
            ),
        ).toBe(true);
        expect(snapshot.dayOfMonth).toBe(10);
        expect(original.suggestTargetDate('2026-03-01')).toBe('2026-03-10');
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(original)).toBe(true);
        expect(aggregate.version).toBe(2);
    });
    it('keeps version and time unchanged for a no-op and rejects a stale version even with the same day', () => {
        const aggregate = DefaultSettlementRule.create(
            'space',
            SettlementRule.from({ kind: 'MONTHLY_DAY', dayOfMonth: 10 }),
            new Date('2026-01-01Z'),
        );
        expect(
            aggregate.configure(aggregate.rule, 1, new Date('2026-02-01Z')),
        ).toBe(false);
        expect(aggregate.version).toBe(1);
        expect(aggregate.updatedAt.toISOString()).toBe(
            '2026-01-01T00:00:00.000Z',
        );
        expect(() =>
            aggregate.configure(aggregate.rule, 0, new Date()),
        ).toThrow();
    });
});
