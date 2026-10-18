import { describe, expect, it, vi } from 'vitest';
import { PersonId } from '../../modules/spaces/domain/person/person-id.js';
import { SpaceId } from '../../modules/spaces/domain/space/space-id.js';
import { SpacesDomainError } from '../../modules/spaces/domain/errors/spaces-domain.error.js';
import { FinanceTodayUnavailableError } from '../../modules/finances/application/ports/public/finance-today-query.port.js';
import { RoutineAttentionUnavailableError } from '../../modules/routine/application/ports/public/routine-attention-query.port.js';
import { ShoppingAttentionUnavailableError } from '../../modules/shopping/application/ports/public/shopping-attention-query.port.js';
import { TodayQuery } from './today.query.js';
import { todayReferenceDate } from './today.clock.js';

const actor = PersonId.create(),
    space = SpaceId.create(),
    member = SpaceId.create().value,
    instant = new Date('2026-10-11T02:59:59.999Z'),
    referenceDate = '2026-10-10';
const empty = () => ({ items: [], totalCount: 0 });
function fixture(type: 'SHARED' | 'PERSONAL' = 'SHARED') {
    const context = {
            spaceId: space.value,
            type,
            status: 'ACTIVE' as const,
            actorMemberId: type === 'PERSONAL' ? null : member,
        },
        access = {
            assertCanRead: vi.fn().mockResolvedValue(context),
            assertCanWrite: vi.fn(),
        },
        clock = { now: vi.fn().mockReturnValue(instant) },
        settlements =
            type === 'PERSONAL'
                ? null
                : {
                      actorMemberId: member,
                      members: [],
                      nextCycle: null,
                      overdueCycles: empty(),
                  },
        financeData = {
            spaceId: space.value,
            actorMemberId: context.actorMemberId,
            referenceDate,
            legacy: { upcomingCommitments: empty(), settlements },
            overdue: empty(),
            today: empty(),
            upcoming: empty(),
            proposals: empty(),
        },
        legacy = {
            referenceDate,
            referenceInstant: instant.toISOString(),
            items: [],
            counts: { totalCount: 0, overdue: 0, today: 0, urgent: 0 },
            hasMore: false,
        },
        routineData = {
            spaceId: space.value,
            actorMemberId: context.actorMemberId,
            referenceDate,
            referenceInstant: instant.toISOString(),
            legacy,
            attention: empty(),
            today: empty(),
            tasks: empty(),
        },
        shoppingData = {
            spaceId: space.value,
            actorMemberId: context.actorMemberId,
            referenceDate,
            referenceInstant: instant.toISOString(),
            items: [],
            totalCount: 0,
            activeListCount: 0,
        },
        finance = { read: vi.fn().mockResolvedValue(financeData) },
        routine = { read: vi.fn().mockResolvedValue(routineData) },
        shopping = { read: vi.fn().mockResolvedValue(shoppingData) };
    return {
        context,
        access,
        clock,
        finance,
        routine,
        shopping,
        financeData,
        routineData,
        shoppingData,
        query: new TodayQuery(access, finance, clock, routine, shopping),
    };
}
const findBlock = (
    result: Awaited<ReturnType<TodayQuery['execute']>>,
    kind: string,
) => result.blocks.find((block) => block.kind === kind)!;
const financialItem = (id: number) => ({
    commitmentId: `commitment-${id}`,
    occurrenceId: null,
    modality: 'ONE_TIME' as const,
    kind: 'EXPENSE' as const,
    description: `Compromisso ${id}`,
    expectedDate: referenceDate,
    amountInCents: 100,
    expectedAmountInCents: 100,
    valuePending: false,
    fulfilledAmountInCents: 0,
    remainingAmountInCents: 100,
});
const taskItem = (id: number) => ({
    id: `task-${id}`,
    kind: 'ONE_OFF' as const,
    description: `Tarefa ${id}`,
    deadline: { date: referenceDate, time: null },
    urgency: 'URGENT',
    status: 'PENDING',
});

describe('today authorized composition', () => {
    it('captures one civil reference, preserves legacy data and returns the six ordered blocks', async () => {
        const f = fixture(),
            result = await f.query.execute(actor, space);
        expect(result).toMatchObject({
            spaceId: space.value,
            spaceType: 'SHARED',
            spaceStatus: 'ACTIVE',
            referenceDate,
            finance: { status: 'AVAILABLE', data: f.financeData.legacy },
            routine: { status: 'AVAILABLE', data: f.routineData.legacy },
            shopping: { status: 'AVAILABLE', data: f.shoppingData },
            capabilities: { spaceClosureAttention: 'NOT_SUPPORTED' },
        });
        expect(result.blocks.map((block) => block.kind)).toEqual([
            'ATTENTION',
            'TODAY',
            'NEXT_SETTLEMENT',
            'UPCOMING',
            'TASKS',
            'SHOPPING',
        ]);
        expect(
            result.blocks.every(
                (block) =>
                    block.status === 'AVAILABLE' &&
                    block.totalCount === 0 &&
                    block.knownTotalCount === 0 &&
                    block.hasMore === false,
            ),
        ).toBe(true);
        expect(f.clock.now).toHaveBeenCalledTimes(1);
        expect(f.finance.read).toHaveBeenCalledExactlyOnceWith(
            actor,
            space,
            referenceDate,
        );
        expect(f.routine.read).toHaveBeenCalledExactlyOnceWith(
            actor,
            space,
            instant,
        );
        expect(f.shopping.read).toHaveBeenCalledExactlyOnceWith(
            actor,
            space,
            instant,
        );
        expect(f.access.assertCanRead).toHaveBeenCalledTimes(2);
        expect(f.access.assertCanWrite).not.toHaveBeenCalled();
    });

    it('keeps personal settlement explicitly not applicable even when finance is unavailable', async () => {
        const f = fixture('PERSONAL');
        expect(
            findBlock(await f.query.execute(actor, space), 'NEXT_SETTLEMENT'),
        ).toMatchObject({
            status: 'NOT_APPLICABLE',
            items: [],
            totalCount: 0,
            knownTotalCount: 0,
            hasMore: false,
        });
        f.finance.read.mockRejectedValueOnce(
            new FinanceTodayUnavailableError(),
        );
        expect(
            findBlock(await f.query.execute(actor, space), 'NEXT_SETTLEMENT')
                .status,
        ).toBe('NOT_APPLICABLE');
    });

    it.each(['CLOSING', 'CLOSED'] as const)(
        'uses confirmed %s lifecycle for authorized reads',
        async (status) => {
            const f = fixture();
            f.access.assertCanRead.mockResolvedValue({ ...f.context, status });
            expect((await f.query.execute(actor, space)).spaceStatus).toBe(
                status,
            );
        },
    );

    it('limits previews while retaining full known totals and typed navigation references', async () => {
        const f = fixture(),
            financial = Array.from({ length: 4 }, (_, id) => financialItem(id)),
            tasks = Array.from({ length: 4 }, (_, id) => taskItem(id));
        f.finance.read.mockResolvedValue({
            ...f.financeData,
            overdue: { items: financial, totalCount: 6 },
            today: { items: financial, totalCount: 7 },
            upcoming: { items: financial, totalCount: 8 },
        });
        f.routine.read.mockResolvedValue({
            ...f.routineData,
            attention: { items: tasks, totalCount: 5 },
            today: { items: tasks, totalCount: 6 },
            tasks: { items: tasks, totalCount: 9 },
        });
        f.shopping.read.mockResolvedValue({
            ...f.shoppingData,
            activeListCount: 10,
            totalCount: 10,
            items: Array.from({ length: 4 }, (_, id) => ({
                id: `list-${id}`,
                name: `Lista ${id}`,
                status: 'ACTIVE',
                summary: {
                    activeItemCount: 1,
                    actionableItemCount: 1,
                    isComplete: false,
                },
                pendingItems: { items: [], totalCount: 1, hasMore: true },
            })),
        });
        const result = await f.query.execute(actor, space);
        for (const [kind, total, limit] of [
            ['ATTENTION', 11, 3],
            ['TODAY', 13, 4],
            ['UPCOMING', 8, 4],
            ['TASKS', 9, 4],
            ['SHOPPING', 10, 4],
        ] as const) {
            const block = findBlock(result, kind);
            expect(block).toMatchObject({
                status: 'AVAILABLE',
                totalCount: total,
                knownTotalCount: total,
                hasMore: true,
            });
            expect(block.items).toHaveLength(limit);
            expect(
                block.items.every(
                    (item) =>
                        item.reference.type === item.type &&
                        typeof item.label === 'string',
                ),
            ).toBe(true);
        }
        expect(findBlock(result, 'TASKS').items[0].reference).toMatchObject({
            type: 'TASK',
            taskId: 'task-0',
            kind: 'ONE_OFF',
            recurrenceId: null,
            scheduledDate: null,
        });
        expect(findBlock(result, 'SHOPPING').items[0].reference).toMatchObject({
            type: 'SHOPPING_LIST',
            listId: 'list-0',
        });
        expect(findBlock(result, 'UPCOMING').items[0].reference).toMatchObject({
            type: 'FINANCIAL_COMMITMENT',
            commitmentId: 'commitment-0',
            modality: 'ONE_TIME',
            occurrenceId: null,
            expectedDate: referenceDate,
        });
    });

    it('keeps known contributions when one source fails without claiming complete totals', async () => {
        const f = fixture();
        f.finance.read.mockRejectedValueOnce(
            new FinanceTodayUnavailableError(),
        );
        f.routine.read.mockResolvedValue({
            ...f.routineData,
            attention: { items: [taskItem(1)], totalCount: 5 },
            today: { items: [taskItem(2)], totalCount: 6 },
        });
        const result = await f.query.execute(actor, space);
        expect(result.finance).toMatchObject({
            status: 'UNAVAILABLE',
            error: { code: 'FINANCE_TODAY_UNAVAILABLE' },
        });
        expect(findBlock(result, 'ATTENTION')).toMatchObject({
            status: 'PARTIAL',
            totalCount: null,
            knownTotalCount: 5,
            hasMore: null,
        });
        expect(findBlock(result, 'TODAY')).toMatchObject({
            status: 'PARTIAL',
            totalCount: null,
            knownTotalCount: 6,
            hasMore: null,
        });
        expect(findBlock(result, 'ATTENTION').items).toHaveLength(1);
        expect(findBlock(result, 'UPCOMING').status).toBe('UNAVAILABLE');
        expect(findBlock(result, 'TASKS').status).toBe('AVAILABLE');
        expect(findBlock(result, 'SHOPPING').status).toBe('AVAILABLE');
    });

    it('isolates a shopping failure from healthy finance and routine blocks', async () => {
        const f = fixture();
        f.shopping.read.mockRejectedValue(
            new ShoppingAttentionUnavailableError(),
        );
        const result = await f.query.execute(actor, space);
        expect(result.shopping).toMatchObject({ status: 'UNAVAILABLE' });
        expect(findBlock(result, 'SHOPPING')).toMatchObject({
            status: 'UNAVAILABLE',
            items: [],
            totalCount: null,
            knownTotalCount: 0,
            hasMore: null,
        });
        expect(
            result.blocks
                .filter((block) => block.kind !== 'SHOPPING')
                .every((block) => block.status === 'AVAILABLE'),
        ).toBe(true);
    });

    it('marks every affected block unavailable when all sources fail simultaneously', async () => {
        const f = fixture();
        f.finance.read.mockRejectedValue(new FinanceTodayUnavailableError());
        f.routine.read.mockRejectedValue(
            new RoutineAttentionUnavailableError(),
        );
        f.shopping.read.mockRejectedValue(
            new ShoppingAttentionUnavailableError(),
        );
        const result = await f.query.execute(actor, space);
        expect(
            result.blocks.every(
                (block) =>
                    block.status === 'UNAVAILABLE' &&
                    block.totalCount === null &&
                    block.knownTotalCount === 0 &&
                    block.hasMore === null,
            ),
        ).toBe(true);
        expect(result.spaceId).toBe(space.value);
        expect(f.access.assertCanRead).toHaveBeenCalledTimes(2);
    });

    it.each(['finance', 'routine', 'shopping'] as const)(
        'does not hide %s authorization or consistency errors as partial availability',
        async (source) => {
            const f = fixture(),
                error = new SpacesDomainError('SPACE_NOT_FOUND');
            f[source].read.mockRejectedValue(error);
            await expect(f.query.execute(actor, space)).rejects.toBe(error);
        },
    );

    it('blocks access before invoking any source', async () => {
        const f = fixture();
        f.access.assertCanRead.mockRejectedValue(
            new SpacesDomainError('SPACE_NOT_FOUND'),
        );
        await expect(f.query.execute(actor, space)).rejects.toMatchObject({
            code: 'SPACE_NOT_FOUND',
        });
        expect(f.finance.read).not.toHaveBeenCalled();
        expect(f.routine.read).not.toHaveBeenCalled();
        expect(f.shopping.read).not.toHaveBeenCalled();
    });

    it.each(['available', 'all-unavailable'])(
        'suppresses %s output if access is revoked before publication',
        async (kind) => {
            const f = fixture();
            if (kind === 'all-unavailable') {
                f.finance.read.mockRejectedValue(
                    new FinanceTodayUnavailableError(),
                );
                f.routine.read.mockRejectedValue(
                    new RoutineAttentionUnavailableError(),
                );
                f.shopping.read.mockRejectedValue(
                    new ShoppingAttentionUnavailableError(),
                );
            }
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

    it('rejects membership changes before publication', async () => {
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

    it.each(['finance', 'routine', 'shopping'] as const)(
        'rejects %s data from another member or reference',
        async (source) => {
            const f = fixture(),
                data =
                    source === 'finance'
                        ? f.financeData
                        : source === 'routine'
                          ? f.routineData
                          : f.shoppingData;
            f[source].read.mockResolvedValue({
                ...data,
                actorMemberId: SpaceId.create().value,
            });
            await expect(f.query.execute(actor, space)).rejects.toMatchObject({
                code: 'SPACE_NOT_FOUND',
            });
        },
    );
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
