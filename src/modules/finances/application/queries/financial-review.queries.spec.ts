import { describe, expect, it, vi } from 'vitest';
import {
    financialMonth,
    decodeReviewCursor,
    encodeReviewCursor,
    FinancialReviewQueries,
} from './financial-review.queries.js';
import {
    realizedIncomeDeltas,
    reviewMetrics,
} from '../../infrastructure/typeorm/queries/typeorm-financial-review-reader.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type { FinancialReviewKey } from '../models/financial-review.js';
const a = '11111111-1111-4111-8111-111111111111',
    b = '22222222-2222-4222-8222-222222222222';
describe('financial review semantics', () => {
    it.each(['2026-01', '2026-12', '2024-02', '2026-02'])(
        'calendar boundaries %s',
        (month) => {
            const result = financialMonth(month);
            expect(result.start).toBe(`${month}-01`);
            expect(result.end).toBe(
                {
                    '2026-01': '2026-02-01',
                    '2026-12': '2027-01-01',
                    '2024-02': '2024-03-01',
                    '2026-02': '2026-03-01',
                }[month],
            );
        },
    );
    it.each(['2026-13', '2026-00', '26-01', '2026-1', '0000-01', '2026-02-01'])(
        'rejects invalid month %s',
        (month) => expect(() => financialMonth(month)).toThrow(),
    );
    it('binds cursor to scope and preserves microseconds and tie breakers', () => {
        const key: FinancialReviewKey = {
            id: a,
            type: 'RECEIPT',
            relevantDate: '2024-02-29',
            registeredAt: '2026-10-15T02:30:00.123456Z',
        };
        const cursor = encodeReviewCursor(
            'space:person:month:member:view',
            key,
        );
        expect(
            decodeReviewCursor(cursor, 'space:person:month:member:view'),
        ).toEqual(key);
        expect(() => decodeReviewCursor(cursor, 'another')).toThrow();
        expect(() => decodeReviewCursor('invalid', 'scope')).toThrow();
        expect(() =>
            decodeReviewCursor(
                encodeReviewCursor('scope', {
                    ...key,
                    relevantDate: '2026-02-29',
                }),
                'scope',
            ),
        ).toThrow();
    });
    it.each(['PERCENTAGES', 'AMOUNTS'] as const)(
        'uses accumulated realization deltas for %s and exact 3-cent distribution',
        (mode) => {
            const splitInput =
                mode === 'PERCENTAGES'
                    ? {
                          mode,
                          shares: [
                              { memberId: a, basisPoints: 5000 },
                              { memberId: b, basisPoints: 5000 },
                          ],
                      }
                    : {
                          mode,
                          shares: [
                              { memberId: a, amountInCents: 2 },
                              { memberId: b, amountInCents: 1 },
                          ],
                      };
            const slices = [0, 1, 2].map((before) =>
                realizedIncomeDeltas([
                    {
                        amount: '3',
                        before: String(before),
                        after: String(before + 1),
                        splitInput,
                    },
                ]),
            );
            expect(
                slices.reduce((sum, m) => sum + m.get(a)! + m.get(b)!, 0n),
            ).toBe(3n);
            expect(slices.reduce((sum, m) => sum + m.get(a)!, 0n)).toBe(2n);
            expect(slices.reduce((sum, m) => sum + m.get(b)!, 0n)).toBe(1n);
            expect(slices.map((m) => m.get(a)! + m.get(b)!)).toEqual([
                1n,
                1n,
                1n,
            ]);
        },
    );
    it('retains 60/40 economic shares across months independently of recipient', () => {
        const splitInput = {
            mode: 'PERCENTAGES' as const,
            shares: [
                { memberId: a, basisPoints: 6000 },
                { memberId: b, basisPoints: 4000 },
            ],
        };
        expect(
            Object.fromEntries(
                realizedIncomeDeltas([
                    {
                        amount: '100000',
                        before: '0',
                        after: '40000',
                        splitInput,
                    },
                ]),
            ),
        ).toEqual({ [a]: 24000n, [b]: 16000n });
        expect(
            Object.fromEntries(
                realizedIncomeDeltas([
                    {
                        amount: '100000',
                        before: '40000',
                        after: '100000',
                        splitInput,
                    },
                ]),
            ),
        ).toEqual({ [a]: 36000n, [b]: 24000n });
    });
    it('keeps exact totals beyond safe integer, negative result and independent support', () => {
        expect(
            reviewMetrics({
                expenseAmountInCents: '18014398509481982',
                paidAmountInCents: '50000',
                assumedAmountInCents: '20000',
                externalSettledAmountInCents: '6000',
                internalTransfersSentAmountInCents: '999',
            }),
        ).toMatchObject({
            economicResultInCents: '-18014398509481982',
            disbursedAmountInCents: '56000',
            supportedAmountInCents: '70000',
        });
        const splitInput = {
            mode: 'AMOUNTS' as const,
            shares: [
                { memberId: a, amountInCents: 9007199254740990 },
                { memberId: b, amountInCents: 1 },
            ],
        };
        expect(
            realizedIncomeDeltas([
                {
                    amount: '9007199254740991',
                    before: '0',
                    after: '9007199254740991',
                    splitInput,
                },
            ]).get(a),
        ).toBe(9007199254740990n);
    });
    it('distinguishes recorded transfers from reversed and valid effects without changing support', () => {
        expect(
            reviewMetrics({
                expenseAmountInCents: '10000',
                paidAmountInCents: '10000',
                internalTransfersSentAmountInCents: '18014398509481982',
                internalTransfersSentReversedAmountInCents: '9007199254740991',
                internalTransfersReceivedAmountInCents: '18014398509481982',
                internalTransfersReceivedReversedAmountInCents:
                    '9007199254740991',
            }),
        ).toMatchObject({
            internalTransfersSentEffectiveAmountInCents: '9007199254740991',
            internalTransfersReceivedEffectiveAmountInCents: '9007199254740991',
            economicResultInCents: '-10000',
            supportedAmountInCents: '10000',
            disbursedAmountInCents: '10000',
        });
    });
});
describe('financial review application authorization', () => {
    function fixture(personal = false) {
        const access = {
            assertCanRead: vi.fn().mockResolvedValue({
                type: personal ? 'PERSONAL' : 'SHARED',
                status: 'ACTIVE',
            }),
        };
        const context = {
            read: vi.fn().mockResolvedValue({
                members: [
                    { memberId: a, personId: a, displayName: 'A' },
                    { memberId: b, personId: b, displayName: 'B' },
                ],
            }),
        };
        const reader = {
            timeline: vi.fn().mockResolvedValue([]),
            forecast: vi.fn().mockResolvedValue({ items: [], totals: {} }),
            overview: vi.fn().mockResolvedValue({}),
        };
        const query = new FinancialReviewQueries(
            access as never,
            context as never,
            reader as never,
            {
                today: () => '2026-10-14',
                now: () => new Date('2026-10-15T02:30:00Z'),
            },
        );
        return {
            access,
            context,
            reader,
            run: (memberId?: string) =>
                query.execute(
                    PersonId.from(a),
                    SpaceId.from(b),
                    'timeline',
                    '2026-10',
                    memberId,
                ),
        };
    }
    it('accepts another authorized member, revalidates read and uses São Paulo clock', async () => {
        const f = fixture();
        expect(await f.run(b)).toMatchObject({
            referenceDate: '2026-10-14',
            memberId: b,
        });
        expect(f.access.assertCanRead).toHaveBeenCalledTimes(2);
        expect(f.context.read).toHaveBeenCalledTimes(2);
        expect(f.reader.timeline.mock.calls[0][0]).toMatchObject({
            start: '2026-10-01',
            end: '2026-11-01',
            memberId: b,
        });
    });
    it('does not query invalid personal or foreign member', async () => {
        for (const f of [fixture(true), fixture()]) {
            await expect(
                f.run('33333333-3333-4333-8333-333333333333'),
            ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
            expect(f.reader.timeline).not.toHaveBeenCalled();
        }
    });
    it('rejects access lost during read and propagates unavailable database', async () => {
        const f = fixture();
        f.access.assertCanRead.mockRejectedValueOnce(new Error('forbidden'));
        await expect(f.run()).rejects.toThrow('forbidden');
        const g = fixture();
        g.access.assertCanRead
            .mockResolvedValueOnce({ type: 'SHARED', status: 'ACTIVE' })
            .mockRejectedValueOnce(new Error('lost'));
        await expect(g.run()).rejects.toThrow('lost');
        const h = fixture();
        h.reader.timeline.mockRejectedValue(new Error('database'));
        await expect(h.run()).rejects.toThrow('database');
    });
});
