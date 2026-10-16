import { describe, expect, it } from 'vitest';
import { SettlementCycle } from './settlement-cycle.js';

describe('Settlement cycle finalization', () => {
    const now = '2026-10-16T15:00:00.000Z';
    const cycle = () =>
        new SettlementCycle('cycle', 'space', '2026-10-10', 'OPEN', 3);
    it('freezes a resolved cycle explicitly while preserving its target date', () => {
        const open = cycle();
        const finalized = open.finalize(false, 3, now);
        expect(finalized).toMatchObject({
            id: 'cycle',
            spaceId: 'space',
            targetDate: '2026-10-10',
            status: 'FINALIZED',
            version: 4,
            finalizedAt: now,
        });
        expect(open.status).toBe('OPEN');
        expect(Object.isFrozen(finalized)).toBe(true);
        expect(() => finalized.assertOpen()).toThrowError(
            expect.objectContaining({ code: 'SETTLEMENT_CYCLE_FINALIZED' }),
        );
    });
    it('rejects any open obligation, even when reciprocal debts have net zero', () => {
        expect(() => cycle().finalize(true, 3, now)).toThrowError(
            expect.objectContaining({
                code: 'SETTLEMENT_CYCLE_HAS_OPEN_OBLIGATIONS',
            }),
        );
    });
    it('refuses an outdated confirmation and repeated finalization without a receipt', () => {
        expect(() => cycle().finalize(false, 2, now)).toThrowError(
            expect.objectContaining({ code: 'CONCURRENT_MODIFICATION' }),
        );
        expect(() =>
            cycle().finalize(false, 3, now).finalize(false, 4, now),
        ).toThrowError(
            expect.objectContaining({ code: 'SETTLEMENT_CYCLE_FINALIZED' }),
        );
    });
    it('requires a valid finalization instant', () => {
        expect(() => cycle().finalize(false, 3, 'invalid')).toThrowError(
            expect.objectContaining({ code: 'VALIDATION_ERROR' }),
        );
    });
});
