import { describe, expect, it, vi } from 'vitest';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { SpacesDomainError } from '../../../spaces/domain/errors/spaces-domain.error.js';
import { FinanceTodayUnavailableError } from '../ports/public/finance-today-query.port.js';
import { GetFinanceTodayQuery } from './finance-today.query.js';
import type { SettlementCycleRead } from '../ports/private/settlement-cycle-reader.js';

const actor = PersonId.create();
const space = SpaceId.create();
const member = SpaceId.create().value;
const referenceDate = '2026-10-10';

function cycle(targetDate: string, remaining = '8000'): SettlementCycleRead {
    return {
        id: SpaceId.create().value,
        version: 1,
        targetDate,
        status: 'OPEN',
        finalizedAt: null,
        obligationCount: 2,
        openObligationCount: remaining === '0' ? 0 : 2,
        totals: {
            originalAmountInCents: remaining,
            recognizedAmountInCents: remaining,
            remainingAmountInCents: remaining,
            resolvedAmountInCents: '0',
            transferredAmountInCents: '0',
        },
        payableAmountInCents: (BigInt(remaining) / 2n).toString(),
        receivableAmountInCents: (BigInt(remaining) / 2n).toString(),
    };
}

function fixture() {
    const context = {
        spaceId: space.value,
        type: 'SHARED' as const,
        status: 'ACTIVE' as const,
        version: 2,
        actorMemberId: member,
        members: [
            { memberId: member, personId: actor.value, displayName: 'A' },
        ],
    };
    const access = {
        read: vi.fn().mockResolvedValue(context),
        lockForWrite: vi.fn(),
        lockForSettlement: vi.fn(),
        lockForFulfillment: vi.fn(),
    };
    const reader = {
        today: vi.fn().mockResolvedValue({
            nextCycle: cycle(referenceDate, '0'),
            overdueCycles: { items: [cycle('2026-10-09')], totalCount: 7 },
        }),
        list: vi.fn(),
        detail: vi.fn(),
    };
    return {
        context,
        access,
        reader,
        query: new GetFinanceTodayQuery(access, reader),
    };
}

describe('finance today public query', () => {
    it('reads one civil reference through the financial reader and preserves full counts and balanced gross debt', async () => {
        const f = fixture();
        const result = await f.query.read(actor, space, referenceDate);
        expect(f.reader.today).toHaveBeenCalledExactlyOnceWith(
            space.value,
            member,
            referenceDate,
        );
        expect(f.access.read).toHaveBeenCalledTimes(2);
        expect(f.access.lockForWrite).not.toHaveBeenCalled();
        expect(f.access.lockForSettlement).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            spaceId: space.value,
            referenceDate,
            actorMemberId: member,
            nextCycle: {
                status: 'OPEN',
                isOverdue: false,
                totals: { remainingAmountInCents: '0' },
            },
            overdueCycles: {
                totalCount: 7,
                items: [
                    {
                        isOverdue: true,
                        position: {
                            net: { direction: 'BALANCED', amountInCents: '0' },
                        },
                    },
                ],
            },
        });
        expect(result.nextCycle).not.toHaveProperty('finalizedAt');
        expect(result.overdueCycles.items[0]).not.toHaveProperty('finalizedAt');
    });

    it('preserves absence of any existing cycle without creating data', async () => {
        const f = fixture();
        f.reader.today.mockResolvedValue({
            nextCycle: null,
            overdueCycles: { items: [], totalCount: 0 },
        });
        expect(await f.query.read(actor, space, referenceDate)).toMatchObject({
            nextCycle: null,
            overdueCycles: { items: [], totalCount: 0 },
        });
    });

    it.each(['CLOSING', 'CLOSED'] as const)(
        'preserves authorized %s reads',
        async (status) => {
            const f = fixture();
            f.access.read.mockResolvedValue({ ...f.context, status });
            expect(
                (await f.query.read(actor, space, referenceDate)).spaceStatus,
            ).toBe(status);
        },
    );

    it('rejects invalid reference dates before querying financial data', async () => {
        const f = fixture();
        await expect(
            f.query.read(actor, space, '2026-02-30'),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        expect(f.reader.today).not.toHaveBeenCalled();
    });

    it('blocks unauthorized access before financial SQL', async () => {
        const f = fixture();
        f.access.read.mockRejectedValue(
            new SpacesDomainError('SPACE_NOT_FOUND'),
        );
        await expect(
            f.query.read(actor, space, referenceDate),
        ).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
        expect(f.reader.today).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        'reauthorizes before publishing reader success or technical failure %s',
        async (failure) => {
            const f = fixture();
            if (failure)
                f.reader.today.mockRejectedValue(
                    new FinanceTodayUnavailableError(),
                );
            f.access.read
                .mockResolvedValueOnce(f.context)
                .mockRejectedValueOnce(
                    new SpacesDomainError('SPACE_NOT_FOUND'),
                );
            await expect(
                f.query.read(actor, space, referenceDate),
            ).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
        },
    );

    it('rejects a changed actor membership rather than publishing another financial perspective', async () => {
        const f = fixture();
        f.access.read.mockResolvedValueOnce(f.context).mockResolvedValueOnce({
            ...f.context,
            actorMemberId: SpaceId.create().value,
        });
        await expect(
            f.query.read(actor, space, referenceDate),
        ).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
    });

    it('preserves exact aggregate centavos above the safe integer limit', async () => {
        const f = fixture();
        f.reader.today.mockResolvedValue({
            nextCycle: cycle(referenceDate, '18014398509481982'),
            overdueCycles: { items: [], totalCount: 0 },
        });
        expect(
            (await f.query.read(actor, space, referenceDate)).nextCycle,
        ).toMatchObject({
            totals: { remainingAmountInCents: '18014398509481982' },
            position: {
                payableAmountInCents: '9007199254740991',
                receivableAmountInCents: '9007199254740991',
            },
        });
    });
});
