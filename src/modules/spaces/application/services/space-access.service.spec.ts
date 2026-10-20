import { describe, expect, it, vi } from 'vitest';
import { PersonId } from '../../domain/person/person-id.js';
import { SpaceId } from '../../domain/space/space-id.js';
import type { SpaceAccessContext } from '../models/space-access-context.js';
import type { SpaceAccessQueries } from '../ports/private/space-access-queries.js';
import { SpaceAccessService } from './space-access.service.js';

function fixture() {
    const actorId = PersonId.create();
    const spaceId = SpaceId.create();
    const queries = {
        findAccessible: vi.fn<SpaceAccessQueries['findAccessible']>(),
    };
    return {
        actorId,
        spaceId,
        queries,
        service: new SpaceAccessService(queries),
    };
}

describe('SpaceAccessService', () => {
    it.each(['PERSONAL', 'SHARED'] as const)(
        'allows reads and active writes: %s',
        async (type) => {
            const f = fixture();
            const context: SpaceAccessContext = {
                spaceId: f.spaceId.value,
                type,
                status: 'ACTIVE',
                actorMemberId: type === 'PERSONAL' ? null : 'member-id',
            };
            f.queries.findAccessible.mockResolvedValue(context);
            expect(await f.service.assertCanRead(f.actorId, f.spaceId)).toEqual(
                context,
            );
            expect(
                await f.service.assertCanWrite(f.actorId, f.spaceId),
            ).toEqual(context);
            expect(f.queries.findAccessible).toHaveBeenCalledWith(
                f.actorId,
                f.spaceId,
            );
        },
    );

    it.each(['CLOSING', 'CLOSED'] as const)(
        'preserves reads and denies new writes: %s',
        async (status) => {
            const f = fixture();
            f.queries.findAccessible.mockResolvedValue({
                spaceId: f.spaceId.value,
                type: 'SHARED',
                status,
                actorMemberId: 'member-id',
            });
            expect(
                (await f.service.assertCanRead(f.actorId, f.spaceId)).status,
            ).toBe(status);
            await expect(
                f.service.assertCanWrite(f.actorId, f.spaceId),
            ).rejects.toMatchObject({ code: 'SPACE_NOT_ACTIVE' });
        },
    );

    it.each(['assertCanRead', 'assertCanWrite'] as const)(
        'uses the same denial without access and checks again on every call: %s',
        async (operation) => {
            const f = fixture();
            f.queries.findAccessible
                .mockResolvedValueOnce({
                    spaceId: f.spaceId.value,
                    type: 'SHARED',
                    status: 'ACTIVE',
                    actorMemberId: 'member-id',
                })
                .mockResolvedValueOnce(null);
            await f.service[operation](f.actorId, f.spaceId);
            await expect(
                f.service[operation](f.actorId, f.spaceId),
            ).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
            expect(f.queries.findAccessible).toHaveBeenCalledTimes(2);
        },
    );

    it('propagates technical failure without authorizing access', async () => {
        const f = fixture();
        const failure = new Error('Database unavailable');
        f.queries.findAccessible.mockRejectedValue(failure);
        await expect(
            f.service.assertCanWrite(f.actorId, f.spaceId),
        ).rejects.toBe(failure);
    });
});
