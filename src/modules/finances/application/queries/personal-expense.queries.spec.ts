import { describe, it, expect, vi } from 'vitest';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import { SpacesDomainError } from '../../../spaces/domain/errors/spaces-domain.error.js';
import {
    GetPersonalExpenseOptionsQuery,
    ListPersonalExpensesQuery,
} from './personal-expense.queries.js';
import {
    GetFinancialCommitmentQuery,
    encodeExpenseCursor,
} from './shared-cash-expense.queries.js';
import type {
    PersonalExpenseView,
    PersonalExpenseSummary,
} from '../models/personal-expense.js';
import type { SpaceAccessContext } from '../../../spaces/application/ports/public/space-access.port.js';
const actor = PersonId.create(),
    space = SpaceId.create();
function fixture() {
    const context: SpaceAccessContext = {
        spaceId: space.value,
        type: 'PERSONAL',
        status: 'ACTIVE',
        actorMemberId: null,
    };
    const access = {
        assertCanRead: vi.fn(async () => context),
        assertCanWrite: vi.fn(),
    };
    const reader = {
        detail: vi.fn<() => Promise<PersonalExpenseView | null>>(
            async () => null,
        ),
        list: vi.fn<() => Promise<PersonalExpenseSummary[]>>(async () => []),
    };
    const shared = {
            read: vi.fn(),
            lockForWrite: vi.fn(),
            lockForSettlement: vi.fn(),
            lockForFulfillment: vi.fn(),
        },
        commitments = { save: vi.fn(), detail: vi.fn() };
    return {
        access,
        reader,
        context,
        shared,
        commitments,
        list: new ListPersonalExpensesQuery(access, reader),
        options: new GetPersonalExpenseOptionsQuery(access, {
            today: () => '2026-10-14',
            now: () => new Date('2026-10-15T02:30:00Z'),
        }),
        detail: new GetFinancialCommitmentQuery(
            access,
            reader,
            shared,
            commitments,
        ),
    };
}
describe('Personal expense authorized queries', () => {
    it('provides the server date and methods without shared context', async () => {
        const f = fixture();
        expect(await f.options.execute(actor, space)).toEqual({
            spaceId: space.value,
            referenceDate: '2026-10-14',
            disbursementMethods: ['PIX', 'DEBIT', 'CASH'],
        });
        expect(f.reader.list).not.toHaveBeenCalled();
        expect(f.shared.read).not.toHaveBeenCalled();
        expect(f.access.assertCanWrite).not.toHaveBeenCalled();
    });
    it('authorizes before empty history and revalidates after reading', async () => {
        const f = fixture();
        expect(await f.list.execute(actor, space)).toEqual({
            spaceId: space.value,
            items: [],
            nextCursor: null,
        });
        expect(f.access.assertCanRead).toHaveBeenCalledTimes(2);
        expect(f.access.assertCanWrite).not.toHaveBeenCalled();
        expect(f.reader.list).toHaveBeenCalledWith(space.value, null);
    });
    it('pages exactly 20 rows with a canonical space-bound cursor', async () => {
        const f = fixture(),
            items = Array.from({ length: 21 }, () => ({
                id: SpaceId.create().value,
                description: 'Consulta',
                amountInCents: 1,
                factDate: '2026-10-14',
                disbursement: { amountInCents: 1, method: 'PIX' as const },
            }));
        f.reader.list.mockResolvedValue(items);
        const r = await f.list.execute(actor, space);
        expect(r.items).toEqual(items.slice(0, 20));
        expect(r.nextCursor).toBe(
            encodeExpenseCursor(space.value, items[19].factDate, items[19].id),
        );
        await f.list.execute(actor, space, r.nextCursor!);
        expect(f.reader.list).toHaveBeenLastCalledWith(space.value, {
            factDate: items[19].factDate,
            id: items[19].id,
        });
    });
    it('rejects another authorized space cursor and malformed canonical encodings before reading', async () => {
        const f = fixture();
        for (const cursor of [
            encodeExpenseCursor(
                SpaceId.create().value,
                '2026-10-14',
                SpaceId.create().value,
            ),
            Buffer.from(
                JSON.stringify([
                    space.value,
                    '2026-02-30',
                    SpaceId.create().value,
                ]),
            ).toString('base64url'),
            encodeExpenseCursor(
                space.value,
                '2026-10-14',
                SpaceId.create().value,
            ) + '=',
        ])
            await expect(
                f.list.execute(actor, space, cursor),
            ).rejects.toMatchObject({
                code: 'VALIDATION_ERROR',
                fields: ['cursor'],
            });
        expect(f.reader.list).not.toHaveBeenCalled();
    });
    it('rejects SHARED for both personal query surfaces', async () => {
        const f = fixture();
        f.context.type = 'SHARED';
        await expect(f.options.execute(actor, space)).rejects.toMatchObject({
            code: 'PERSONAL_SPACE_REQUIRED',
        });
        await expect(f.list.execute(actor, space)).rejects.toMatchObject({
            code: 'PERSONAL_SPACE_REQUIRED',
        });
        expect(f.reader.list).not.toHaveBeenCalled();
    });
    it('does not reveal data when authorization changes during a read', async () => {
        const f = fixture();
        f.access.assertCanRead
            .mockResolvedValueOnce(f.context)
            .mockRejectedValueOnce(new SpacesDomainError('SPACE_NOT_FOUND'));
        await expect(f.list.execute(actor, space)).rejects.toMatchObject({
            code: 'SPACE_NOT_FOUND',
        });
    });
    it('does not downgrade repository errors to empty history', async () => {
        const f = fixture();
        f.reader.list.mockRejectedValue(new Error('Read unavailable'));
        await expect(f.list.execute(actor, space)).rejects.toThrow(
            'Read unavailable',
        );
    });
    it('routes personal detail through its reader and revalidates without shared concepts', async () => {
        const f = fixture(),
            view = {
                spaceId: space.value,
                spaceType: 'PERSONAL',
                commitment: { id: 'commitment' },
                disbursement: { id: 'disbursement' },
            } as PersonalExpenseView;
        f.reader.detail.mockResolvedValue(view);
        expect(await f.detail.execute(actor, space, 'commitment')).toBe(view);
        expect(f.reader.detail).toHaveBeenCalledWith(space.value, 'commitment');
        expect(f.access.assertCanRead).toHaveBeenCalledTimes(2);
        expect(f.shared.read).not.toHaveBeenCalled();
        expect(f.commitments.detail).not.toHaveBeenCalled();
    });
    it('returns not found for an unknown or foreign personal origin', async () => {
        const f = fixture();
        await expect(
            f.detail.execute(actor, space, 'missing'),
        ).rejects.toMatchObject({ code: 'FINANCIAL_COMMITMENT_NOT_FOUND' });
    });
    it('revalidates access before delivering personal detail', async () => {
        const f = fixture();
        f.reader.detail.mockResolvedValue({
            spaceType: 'PERSONAL',
        } as PersonalExpenseView);
        f.access.assertCanRead
            .mockResolvedValueOnce(f.context)
            .mockRejectedValueOnce(new SpacesDomainError('SPACE_NOT_FOUND'));
        await expect(
            f.detail.execute(actor, space, 'commitment'),
        ).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
    });
    it('preserves the existing shared detail and member labels', async () => {
        const f = fixture();
        f.context.type = 'SHARED';
        const members = [
            { memberId: 'member', personId: actor.value, displayName: 'A' },
        ];
        f.shared.read.mockResolvedValue({ members });
        f.commitments.detail.mockResolvedValue({
            spaceId: space.value,
            obligation: null,
        });
        expect(await f.detail.execute(actor, space, 'commitment')).toEqual({
            spaceId: space.value,
            obligation: null,
            members,
        });
        expect(f.reader.detail).not.toHaveBeenCalled();
        expect(f.shared.read).toHaveBeenCalledTimes(2);
    });
});
