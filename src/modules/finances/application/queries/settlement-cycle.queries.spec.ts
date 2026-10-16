import { describe, expect, it, vi } from 'vitest';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { SpacesDomainError } from '../../../spaces/domain/errors/spaces-domain.error.js';
import type { SettlementCycleRead } from '../ports/private/settlement-cycle-reader.js';
import type { SettlementCycleQueryPort } from '../ports/public/settlement-cycle-query.port.js';
import { settlementCycleTotals } from './settlement-cycle.calculations.js';
import { encodePositionCursor } from './inter-member-position.query.js';
import {
    GetSettlementCycleQuery,
    GetSettlementCyclesQuery,
    encodeSettlementListCursor,
    decodeSettlementListCursor,
    encodeSettlementDetailCursor,
    decodeSettlementDetailCursor,
    settlementCycleSummary,
} from './settlement-cycle.queries.js';
const actor = PersonId.create(),
    space = SpaceId.create(),
    cycleId = SpaceId.create().value,
    memberId = SpaceId.create().value;
const referenceDate = '2026-10-10',
    registeredAt = '2026-10-10T15:00:00.123456Z';
const key = { id: SpaceId.create().value, registeredAt };
function cycle(
    original = '43000',
    remaining = '43000',
    targetDate = '2026-10-09',
): SettlementCycleRead {
    return {
        id: cycleId,
        version: 1,
        status: 'OPEN',
        targetDate,
        finalizedAt: null,
        obligationCount: 2,
        openObligationCount: remaining === '0' ? 0 : 2,
        totals: settlementCycleTotals(original, remaining),
        payableAmountInCents: remaining === '0' ? '0' : '35000',
        receivableAmountInCents: remaining === '0' ? '0' : '8000',
    };
}
describe('settlement cycle exact calculated read values', () => {
    it.each([
        ['43000', '43000', '0'],
        ['50000', '25000', '25000'],
        ['50000', '0', '50000'],
        ['0', '0', '0'],
        ['18014398509481982', '9007199254740992', '9007199254740990'],
    ])(
        'preserves original=%s remaining=%s resolved=%s',
        (original, remaining, resolved) => {
            const totals = settlementCycleTotals(original, remaining);
            expect(totals).toEqual({
                originalAmountInCents: original,
                recognizedAmountInCents: original,
                remainingAmountInCents: remaining,
                transferredAmountInCents: '0',
                compensatedAmountInCents: '0',
                resolvedAmountInCents: resolved,
            });
            expect(BigInt(totals.originalAmountInCents)).toBe(
                BigInt(totals.resolvedAmountInCents) +
                    BigInt(totals.remainingAmountInCents),
            );
        },
    );
    it.each([
        ['10000', '20000', '16000', '4000'],
        ['20000', '5000', '0', '5000'],
        ['20000', '0', '0', '0'],
        [
            '18014398509481982',
            '18014398509481984',
            '9007199254740993',
            '9007199254740991',
        ],
    ])(
        'separates original %s from recognized %s after reconciliation',
        (original, recognized, remaining, transferred) => {
            expect(
                settlementCycleTotals(
                    original,
                    remaining,
                    transferred,
                    recognized,
                ),
            ).toEqual({
                originalAmountInCents: original,
                recognizedAmountInCents: recognized,
                remainingAmountInCents: remaining,
                transferredAmountInCents: transferred,
                compensatedAmountInCents: '0',
                resolvedAmountInCents: transferred,
            });
        },
    );
    it.each([
        ['OPEN', '2026-10-09', '1', true],
        ['OPEN', '2026-10-10', '1', false],
        ['OPEN', '2026-10-11', '1', false],
        ['OPEN', '2027-01-01', '1', false],
        ['OPEN', '2026-10-09', '0', false],
        ['FINALIZED', '2026-10-09', '1', false],
    ] as const)(
        'calculates overdue %s %s remaining %s',
        (status, targetDate, remaining, isOverdue) => {
            expect(
                settlementCycleSummary(
                    { ...cycle('50000', remaining, targetDate), status },
                    referenceDate,
                ).isOverdue,
            ).toBe(isOverdue);
        },
    );
    it('keeps balanced positive obligations overdue without settling either direction', () => {
        const result = settlementCycleSummary(
            {
                ...cycle('16000', '16000'),
                payableAmountInCents: '8000',
                receivableAmountInCents: '8000',
            },
            referenceDate,
        );
        expect(result).toMatchObject({
            isOverdue: true,
            obligationCount: 2,
            openObligationCount: 2,
            totals: {
                originalAmountInCents: '16000',
                resolvedAmountInCents: '0',
                remainingAmountInCents: '16000',
            },
            position: { net: { direction: 'BALANCED', amountInCents: '0' } },
        });
    });
    it('preserves finalized instant and exact totals above safe integer', () => {
        const result = settlementCycleSummary(
            {
                ...cycle('18014398509481982', '18014398509481982'),
                status: 'FINALIZED',
                finalizedAt: registeredAt,
                payableAmountInCents: '18014398509481982',
                receivableAmountInCents: '1',
            },
            referenceDate,
        );
        expect(result).toMatchObject({
            isOverdue: false,
            finalizedAt: registeredAt,
            position: {
                net: {
                    direction: 'PAYABLE',
                    amountInCents: '18014398509481981',
                },
            },
        });
    });
});
describe('settlement list and detail canonical context bound cursors', () => {
    const listKey = { targetDate: '2026-10-11', id: key.id };
    const list = encodeSettlementListCursor(
        space.value,
        actor.value,
        'OPEN',
        referenceDate,
        listKey,
    );
    const upcoming = encodeSettlementListCursor(
        space.value,
        actor.value,
        'UPCOMING',
        referenceDate,
        listKey,
    );
    const detail = encodeSettlementDetailCursor(
        space.value,
        actor.value,
        cycleId,
        'ALL',
        key,
    );
    const readList = (value: string | undefined) =>
        decodeSettlementListCursor(
            value,
            space.value,
            actor.value,
            'OPEN',
            referenceDate,
        );
    const readDetail = (value: string | undefined) =>
        decodeSettlementDetailCursor(
            value,
            space.value,
            actor.value,
            cycleId,
            'ALL',
        );
    it('roundtrips keys while preserving UTC microseconds', () => {
        expect(readList(list)).toEqual(listKey);
        expect(readDetail(detail)).toEqual(key);
        expect(readList(undefined)).toBeNull();
        expect(readDetail(undefined)).toBeNull();
        expect(list.length).toBeLessThanOrEqual(512);
        expect(detail.length).toBeLessThanOrEqual(512);
    });
    it.each([
        '',
        'x',
        'a'.repeat(513),
        list + '=',
        detail + '=',
        encodePositionCursor(space.value, actor.value, 'ALL', key),
        Buffer.from('[1]').toString('base64url'),
    ])('rejects invalid or foreign query cursor %s', (value) => {
        expect(() => readList(value)).toThrow(
            expect.objectContaining({
                code: 'VALIDATION_ERROR',
                fields: ['cursor'],
            }),
        );
        expect(() => readDetail(value)).toThrow(
            expect.objectContaining({
                code: 'VALIDATION_ERROR',
                fields: ['cursor'],
            }),
        );
    });
    it('rejects another query kind', () => {
        expect(() => readList(detail)).toThrow();
        expect(() => readDetail(list)).toThrow();
    });
    it.each(['actor', 'space', 'view'])(
        'rejects list context mismatch %s',
        (context) => {
            expect(() =>
                decodeSettlementListCursor(
                    list,
                    context === 'space' ? key.id : space.value,
                    context === 'actor' ? key.id : actor.value,
                    context === 'view' ? 'UPCOMING' : 'OPEN',
                    referenceDate,
                ),
            ).toThrow();
        },
    );
    it.each(['actor', 'space', 'cycle', 'direction'])(
        'rejects detail context mismatch %s',
        (context) => {
            expect(() =>
                decodeSettlementDetailCursor(
                    detail,
                    context === 'space' ? key.id : space.value,
                    context === 'actor' ? key.id : actor.value,
                    context === 'cycle' ? key.id : cycleId,
                    context === 'direction' ? 'PAYABLE' : 'ALL',
                ),
            ).toThrow();
        },
    );
    it('expires UPCOMING when civil reference day changes while OPEN stays usable', () => {
        expect(
            decodeSettlementListCursor(
                upcoming,
                space.value,
                actor.value,
                'UPCOMING',
                referenceDate,
            ),
        ).toEqual(listKey);
        expect(() =>
            decodeSettlementListCursor(
                upcoming,
                space.value,
                actor.value,
                'UPCOMING',
                '2026-10-11',
            ),
        ).toThrow(expect.objectContaining({ fields: ['cursor'] }));
        expect(
            decodeSettlementListCursor(
                list,
                space.value,
                actor.value,
                'OPEN',
                '2026-10-11',
            ),
        ).toEqual(listKey);
    });
    it.each(['2026-02-30', '0000-01-01', '2026-13-01', '2026-10-10T00:00:00Z'])(
        'rejects invalid list date %s',
        (targetDate) => {
            expect(() =>
                readList(
                    encodeSettlementListCursor(
                        space.value,
                        actor.value,
                        'OPEN',
                        referenceDate,
                        { ...listKey, targetDate },
                    ),
                ),
            ).toThrow();
        },
    );
    it.each([
        '2026-02-30T15:00:00.123456Z',
        '2026-10-10T24:00:00.123456Z',
        '2026-10-10T15:00:60.123456Z',
        '2026-10-10T15:00:00.123Z',
        '2026-10-10T15:00:00.123456-03:00',
    ])('rejects invalid detail timestamp %s', (registeredAt) => {
        expect(() =>
            readDetail(
                encodeSettlementDetailCursor(
                    space.value,
                    actor.value,
                    cycleId,
                    'ALL',
                    { ...key, registeredAt },
                ),
            ),
        ).toThrow();
    });
    it.each([list, detail])(
        'rejects noncanonical JSON or cursor version',
        (value) => {
            const data = JSON.parse(
                Buffer.from(value, 'base64url').toString('utf8'),
            );
            const spaced = Buffer.from(JSON.stringify(data, null, 1)).toString(
                'base64url',
            );
            data[0] = 2;
            const version = Buffer.from(JSON.stringify(data)).toString(
                'base64url',
            );
            for (const invalid of [spaced, version]) {
                expect(() => readList(invalid)).toThrow();
                expect(() => readDetail(invalid)).toThrow();
            }
        },
    );
});
describe('settlement cycle application authorization and public contract', () => {
    function fixture() {
        const context = {
            spaceId: space.value,
            type: 'SHARED' as const,
            status: 'ACTIVE' as const,
            version: 1,
            actorMemberId: memberId,
            members: [],
        };
        const access = {
            read: vi.fn().mockResolvedValue(context),
            lockForWrite: vi.fn(),
            lockForSettlement: vi.fn(),
            lockForFulfillment: vi.fn(),
        };
        const reader = {
            today: vi.fn(),
            list: vi.fn().mockResolvedValue([cycle()]),
            detail: vi.fn().mockResolvedValue({ cycle: cycle(), items: [] }),
            summary: vi.fn(),
        };
        const clock = {
            now: vi.fn(),
            today: vi.fn().mockReturnValue(referenceDate),
        };
        return {
            access,
            reader,
            clock,
            list: new GetSettlementCyclesQuery(access, reader, clock),
            detail: new GetSettlementCycleQuery(access, reader, clock),
        };
    }
    it.each(['list', 'detail'] as const)(
        'authorizes %s before SQL and before response and captures date once',
        async (which) => {
            const f = fixture();
            const result =
                which === 'list'
                    ? await f.list.execute(actor, space)
                    : await f.detail.execute(actor, space, cycleId);
            expect(f.access.read).toHaveBeenCalledTimes(2);
            expect(f.clock.today).toHaveBeenCalledTimes(1);
            expect(f.clock.now).not.toHaveBeenCalled();
            expect(f.access.lockForWrite).not.toHaveBeenCalled();
            expect(result).toMatchObject({
                spaceId: space.value,
                actorMemberId: memberId,
                referenceDate,
                spaceStatus: 'ACTIVE',
            });
            if (which === 'list')
                expect(f.reader.list).toHaveBeenCalledWith(
                    space.value,
                    memberId,
                    'OPEN',
                    referenceDate,
                    null,
                );
            else
                expect(f.reader.detail).toHaveBeenCalledWith(
                    space.value,
                    memberId,
                    cycleId,
                    'ALL',
                    null,
                );
        },
    );
    it('public upcoming operation is identical to application UPCOMING including cursor and authorization', async () => {
        const f = fixture();
        const cursor = encodeSettlementListCursor(
            space.value,
            actor.value,
            'UPCOMING',
            referenceDate,
            { targetDate: '2026-10-11', id: key.id },
        );
        const port: SettlementCycleQueryPort = f.list;
        expect(await port.upcoming(actor, space, cursor)).toEqual(
            await f.list.execute(actor, space, 'UPCOMING', cursor),
        );
        expect(f.access.read).toHaveBeenCalledTimes(4);
        expect(f.reader.list).toHaveBeenCalledWith(
            space.value,
            memberId,
            'UPCOMING',
            referenceDate,
            { targetDate: '2026-10-11', id: key.id },
        );
    });
    it.each(['list', 'detail'] as const)(
        'blocks unauthorized %s before reader',
        async (which) => {
            const f = fixture();
            f.access.read.mockRejectedValue(
                new SpacesDomainError('SPACE_NOT_FOUND'),
            );
            await expect(
                which === 'list'
                    ? f.list.execute(actor, space)
                    : f.detail.execute(actor, space, cycleId),
            ).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
            expect(f.reader.list).not.toHaveBeenCalled();
            expect(f.reader.detail).not.toHaveBeenCalled();
        },
    );
    it.each(['list', 'detail'] as const)(
        'suppresses %s result after access is lost',
        async (which) => {
            const f = fixture();
            f.access.read
                .mockResolvedValueOnce({ actorMemberId: memberId })
                .mockRejectedValueOnce(
                    new SpacesDomainError('SPACE_NOT_FOUND'),
                );
            await expect(
                which === 'list'
                    ? f.list.execute(actor, space)
                    : f.detail.execute(actor, space, cycleId),
            ).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
        },
    );
    it.each(['CLOSING', 'CLOSED'] as const)(
        'allows shared %s authorized read',
        async (status) => {
            const f = fixture();
            f.access.read.mockResolvedValue({
                actorMemberId: memberId,
                status,
                members: [],
            });
            expect((await f.list.execute(actor, space)).spaceStatus).toBe(
                status,
            );
            expect(
                (await f.detail.execute(actor, space, cycleId)).spaceStatus,
            ).toBe(status);
        },
    );
    it('reauthorizes missing detail before reporting generic not found', async () => {
        const f = fixture();
        f.reader.detail.mockResolvedValue(null);
        await expect(
            f.detail.execute(actor, space, cycleId),
        ).rejects.toMatchObject({
            code: 'SETTLEMENT_CYCLE_NOT_FOUND',
            message: 'Acerto não encontrado.',
        });
        expect(f.access.read).toHaveBeenCalledTimes(2);
    });
    it('accepts finalized read fixture without changing stored status or date', async () => {
        const f = fixture();
        f.reader.detail.mockResolvedValue({
            cycle: {
                ...cycle('50000', '0'),
                status: 'FINALIZED',
                finalizedAt: registeredAt,
            },
            items: [],
        });
        expect(
            (await f.detail.execute(actor, space, cycleId)).cycle,
        ).toMatchObject({
            status: 'FINALIZED',
            finalizedAt: registeredAt,
            isOverdue: false,
            totals: {
                originalAmountInCents: '50000',
                resolvedAmountInCents: '50000',
                remainingAmountInCents: '0',
            },
        });
    });
    it('empty list is valid without creating anything', async () => {
        const f = fixture();
        f.reader.list.mockResolvedValue([]);
        expect(await f.list.execute(actor, space)).toMatchObject({
            items: [],
            page: { view: 'OPEN', pageSize: 20, nextCursor: null },
        });
    });
    it('empty cycle and empty direction retain full totals and OPEN state', async () => {
        const f = fixture();
        f.reader.detail.mockResolvedValue({
            cycle: cycle('50000', '0'),
            items: [],
        });
        expect(
            await f.detail.execute(actor, space, cycleId, 'RECEIVABLE'),
        ).toMatchObject({
            cycle: {
                status: 'OPEN',
                isOverdue: false,
                totals: {
                    originalAmountInCents: '50000',
                    resolvedAmountInCents: '50000',
                    remainingAmountInCents: '0',
                },
            },
            items: [],
            page: { direction: 'RECEIVABLE', nextCursor: null },
        });
    });
    it('slices 21 cycles into fixed page and derives next cursor from twentieth identity', async () => {
        const f = fixture();
        const rows = Array.from({ length: 21 }, (_, index) => ({
            ...cycle(),
            id: SpaceId.create().value,
            targetDate: `2026-11-${String(index + 1).padStart(2, '0')}`,
        }));
        f.reader.list.mockResolvedValue(rows);
        const result = await f.list.execute(actor, space, 'UPCOMING');
        expect(result.items).toHaveLength(20);
        expect(result.items[0]).not.toHaveProperty('finalizedAt');
        expect(
            decodeSettlementListCursor(
                result.page.nextCursor!,
                space.value,
                actor.value,
                'UPCOMING',
                referenceDate,
            ),
        ).toEqual({ id: rows[19].id, targetDate: rows[19].targetDate });
    });
    it('slices detail pages without recalculating full cycle totals', async () => {
        const f = fixture();
        const items = Array.from({ length: 21 }, () => ({
            ...key,
            id: SpaceId.create().value,
        }));
        f.reader.detail.mockResolvedValue({ cycle: cycle(), items });
        const result = await f.detail.execute(actor, space, cycleId, 'PAYABLE');
        expect(result.items).toHaveLength(20);
        expect(result.cycle.totals.remainingAmountInCents).toBe('43000');
        expect(
            decodeSettlementDetailCursor(
                result.page.nextCursor!,
                space.value,
                actor.value,
                cycleId,
                'PAYABLE',
            ),
        ).toEqual(items[19]);
    });
    it('rejects invalid arguments before financial reader', async () => {
        const f = fixture();
        await expect(
            f.list.execute(actor, space, 'OPEN', ''),
        ).rejects.toMatchObject({
            code: 'VALIDATION_ERROR',
            fields: ['cursor'],
        });
        await expect(
            f.detail.execute(actor, space, cycleId, 'ALL', ''),
        ).rejects.toMatchObject({
            code: 'VALIDATION_ERROR',
            fields: ['cursor'],
        });
        await expect(
            f.detail.execute(actor, space, 'invalid'),
        ).rejects.toMatchObject({
            code: 'VALIDATION_ERROR',
            fields: ['cycleId'],
        });
        expect(f.reader.list).not.toHaveBeenCalled();
        expect(f.reader.detail).not.toHaveBeenCalled();
    });
    it('uses captured civil day consistently even if clock changes while SQL is running', async () => {
        const f = fixture();
        f.clock.today
            .mockReturnValueOnce('2026-10-09')
            .mockReturnValue('2026-10-10');
        expect(await f.list.execute(actor, space)).toMatchObject({
            referenceDate: '2026-10-09',
            items: [{ isOverdue: false }],
        });
        expect(f.clock.today).toHaveBeenCalledTimes(1);
        expect(await f.list.execute(actor, space)).toMatchObject({
            referenceDate: '2026-10-10',
            items: [{ isOverdue: true }],
        });
    });
});
