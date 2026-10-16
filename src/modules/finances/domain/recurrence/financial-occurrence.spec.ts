import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FinancesError } from '../errors/finances.error.js';
import { FinancialOccurrence } from './financial-occurrence.js';

describe('financial occurrence value', () => {
    it('keeps a cancelled variable occurrence closed to later value definition', () => {
        const occurrence = new FinancialOccurrence(
            randomUUID(),
            randomUUID(),
            randomUUID(),
            '2026-10-14',
            1,
            1,
            null,
            [],
            '2026-10-14T15:00:00Z',
            'CANCELLED',
            [],
            [],
            { actorId: randomUUID(), registeredAt: '2026-10-14T15:00:00Z' },
        );
        expect(() =>
            occurrence.defineValue(
                12000,
                1,
                randomUUID(),
                '2026-10-14T15:00:00Z',
            ),
        ).toThrowError(FinancesError);
        try {
            occurrence.defineValue(
                12000,
                1,
                randomUUID(),
                '2026-10-14T15:00:00Z',
            );
        } catch (error) {
            expect((error as FinancesError).code).toBe(
                'OCCURRENCE_ALREADY_RESOLVED',
            );
        }
    });
});
