import { describe, expect, it, vi } from 'vitest';
import { SpacesDomainError } from '../../domain/errors/spaces-domain.error.js';
import { PersonId } from '../../domain/person/person-id.js';
import { SpaceId } from '../../domain/space/space-id.js';
import type { SpaceReadQueries } from '../ports/private/space-read-queries.js';
import type { SpaceAccessPort } from '../ports/public/space-access.port.js';
import { GetSpaceDetailsQuery } from './get-space-details.query.js';

function fixture() {
    const actorId = PersonId.create();
    const spaceId = SpaceId.create();
    const reads = { findDetails: vi.fn<SpaceReadQueries['findDetails']>() };
    const access = {
        assertCanRead: vi.fn<SpaceAccessPort['assertCanRead']>(),
        assertCanWrite: vi.fn<SpaceAccessPort['assertCanWrite']>(),
    };
    const query = new GetSpaceDetailsQuery(
        reads as unknown as SpaceReadQueries,
        access,
    );
    return { actorId, spaceId, reads, access, query };
}

describe('GetSpaceDetailsQuery', () => {
    it('checks the access port and preserves the actor filter in the final query', async () => {
        const f = fixture();
        const details = {
            space: {
                id: f.spaceId.value,
                type: 'PERSONAL' as const,
                status: 'ACTIVE' as const,
                label: 'Meu espaço' as const,
                version: 1,
            },
            actorMembership: null,
            activeMemberCount: 0 as const,
            invitation: null,
        };
        f.reads.findDetails.mockResolvedValue(details);
        expect(await f.query.execute(f.actorId, f.spaceId)).toBe(details);
        expect(f.access.assertCanRead).toHaveBeenCalledWith(
            f.actorId,
            f.spaceId,
        );
        expect(f.reads.findDetails).toHaveBeenCalledWith(
            f.actorId,
            f.spaceId,
            expect.any(Date),
        );
        expect(f.access.assertCanRead.mock.invocationCallOrder[0]).toBeLessThan(
            f.reads.findDetails.mock.invocationCallOrder[0],
        );
    });

    it('denies access when it is lost between validation and reading', async () => {
        const f = fixture();
        f.reads.findDetails.mockResolvedValue(null);
        await expect(
            f.query.execute(f.actorId, f.spaceId),
        ).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
    });

    it('does not query data after the access port denies authorization', async () => {
        const f = fixture();
        f.access.assertCanRead.mockRejectedValue(
            new SpacesDomainError('SPACE_NOT_FOUND'),
        );
        await expect(
            f.query.execute(f.actorId, f.spaceId),
        ).rejects.toMatchObject({ code: 'SPACE_NOT_FOUND' });
        expect(f.reads.findDetails).not.toHaveBeenCalled();
    });
});
