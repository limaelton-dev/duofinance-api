import { describe, expect, it, vi } from 'vitest';
import { PersonId } from '../../modules/spaces/domain/person/person-id.js';
import { SpaceId } from '../../modules/spaces/domain/space/space-id.js';
import { SpacesDomainError } from '../../modules/spaces/domain/errors/spaces-domain.error.js';
import { FinanceTodayUnavailableError } from '../../modules/finances/application/ports/public/finance-today-query.port.js';
import { TodayQuery } from './today.query.js';
import { todayReferenceDate } from './today.clock.js';

const actor = PersonId.create();
const space = SpaceId.create();
const member = SpaceId.create().value;

function fixture(type: 'SHARED' | 'PERSONAL' = 'SHARED') {
    const context = {
        spaceId: space.value,
        type,
        status: 'ACTIVE' as const,
        actorMemberId: type === 'PERSONAL' ? null : member,
    };
    const access = {
        assertCanRead: vi.fn().mockResolvedValue(context),
        assertCanWrite: vi.fn(),
    };
    const finance = {
        read: vi.fn().mockResolvedValue({
            spaceId: space.value,
            spaceStatus: 'ACTIVE',
            actorMemberId: member,
            members: [],
            referenceDate: '2026-10-10',
            nextCycle: null,
            overdueCycles: { items: [], totalCount: 0 },
        }),
    };
    const clock = {
        now: vi.fn().mockReturnValue(new Date('2026-10-11T02:59:59.999Z')),
    };
    const incomes = {
        readUpcoming: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
    };
    return {
        context,
        access,
        finance,
        clock,
        incomes,
        query: new TodayQuery(access, finance, clock, incomes),
    };
}

describe('today authorized composition', () => {
    it('captures civil date once and composes only the authorized public finance contract', async () => {
        const f = fixture();
        expect(await f.query.execute(actor, space)).toEqual({
            spaceId: space.value,
            spaceType: 'SHARED',
            spaceStatus: 'ACTIVE',
            referenceDate: '2026-10-10',
            finance: {
                status: 'AVAILABLE',
                data: {
                    upcomingCommitments: { items: [], totalCount: 0 },
                    settlements: {
                        actorMemberId: member,
                        members: [],
                        nextCycle: null,
                        overdueCycles: { items: [], totalCount: 0 },
                    },
                },
            },
        });
        expect(f.clock.now).toHaveBeenCalledTimes(1);
        expect(f.finance.read).toHaveBeenCalledExactlyOnceWith(
            actor,
            space,
            '2026-10-10',
        );
        expect(f.access.assertCanRead).toHaveBeenCalledTimes(2);
        expect(f.access.assertCanWrite).not.toHaveBeenCalled();
    });

    it('personal reads never call the exclusive shared financial port', async () => {
        const f = fixture('PERSONAL');
        f.finance.read.mockRejectedValue(
            new SpacesDomainError('SHARED_SPACE_REQUIRED'),
        );
        expect(await f.query.execute(actor, space)).toMatchObject({
            spaceType: 'PERSONAL',
            finance: {
                status: 'AVAILABLE',
                data: {
                    upcomingCommitments: { items: [], totalCount: 0 },
                    settlements: null,
                },
            },
        });
        expect(f.finance.read).not.toHaveBeenCalled();
        expect(f.access.assertCanRead).toHaveBeenCalledTimes(2);
    });

    it.each(['CLOSING', 'CLOSED'] as const)(
        'returns confirmed %s lifecycle for authorized read',
        async (status) => {
            const f = fixture();
            f.access.assertCanRead.mockResolvedValue({ ...f.context, status });
            f.finance.read.mockResolvedValue({
                ...(await f.finance.read()),
                spaceStatus: status,
            });
            expect((await f.query.execute(actor, space)).spaceStatus).toBe(
                status,
            );
        },
    );

    it('preserves authorized shell with safe technical unavailable error', async () => {
        const f = fixture();
        f.finance.read.mockRejectedValue(new FinanceTodayUnavailableError());
        expect(await f.query.execute(actor, space)).toMatchObject({
            spaceId: space.value,
            finance: {
                status: 'UNAVAILABLE',
                error: {
                    code: 'FINANCE_TODAY_UNAVAILABLE',
                    message:
                        'Não foi possível carregar as finanças. Tente novamente.',
                },
            },
        });
        expect(f.access.assertCanRead).toHaveBeenCalledTimes(2);
    });

    it.each([
        new SpacesDomainError('SPACE_NOT_FOUND'),
        new SpacesDomainError('SHARED_SPACE_REQUIRED'),
        new Error('Invalid persisted amount'),
    ])(
        'never reduces access or inconsistency errors to partial availability',
        async (error) => {
            const f = fixture();
            f.finance.read.mockRejectedValue(error);
            await expect(f.query.execute(actor, space)).rejects.toBe(error);
        },
    );

    it('blocks access before any financial read', async () => {
        const f = fixture();
        f.access.assertCanRead.mockRejectedValue(
            new SpacesDomainError('SPACE_NOT_FOUND'),
        );
        await expect(f.query.execute(actor, space)).rejects.toMatchObject({
            code: 'SPACE_NOT_FOUND',
        });
        expect(f.finance.read).not.toHaveBeenCalled();
    });

    it.each(['success', 'unavailable', 'personal'])(
        'suppresses %s when access is lost before publication',
        async (kind) => {
            const f = fixture(kind === 'personal' ? 'PERSONAL' : 'SHARED');
            if (kind === 'unavailable')
                f.finance.read.mockRejectedValue(
                    new FinanceTodayUnavailableError(),
                );
            f.access.assertCanRead
                .mockResolvedValueOnce(f.context)
                .mockRejectedValueOnce(
                    new SpacesDomainError('SPACE_NOT_FOUND'),
                );
            await expect(f.query.execute(actor, space)).rejects.toMatchObject({
                code: 'SPACE_NOT_FOUND',
            });
        },
    );

    it('rejects a changed membership even if a valid financial response preceded it', async () => {
        const f = fixture();
        f.access.assertCanRead
            .mockResolvedValueOnce(f.context)
            .mockResolvedValueOnce({
                ...f.context,
                actorMemberId: SpaceId.create().value,
            });
        await expect(f.query.execute(actor, space)).rejects.toMatchObject({
            code: 'SPACE_NOT_FOUND',
        });
    });

    it('rejects a financial reference or context mismatch without publishing stale data', async () => {
        const f = fixture();
        f.finance.read.mockResolvedValue({
            ...(await f.finance.read()),
            referenceDate: '2026-10-11',
        });
        await expect(f.query.execute(actor, space)).rejects.toMatchObject({
            code: 'SPACE_NOT_FOUND',
        });
    });
});

describe('today civil reference date in Sao Paulo', () => {
    it.each([
        ['2026-10-11T02:59:59.999Z', '2026-10-10'],
        ['2026-10-11T03:00:00.000Z', '2026-10-11'],
        ['2027-01-01T02:59:59.999Z', '2026-12-31'],
        ['2027-01-01T03:00:00.000Z', '2027-01-01'],
    ])('uses server instant %s for %s', (instant, date) => {
        expect(todayReferenceDate(new Date(instant))).toBe(date);
    });
});
