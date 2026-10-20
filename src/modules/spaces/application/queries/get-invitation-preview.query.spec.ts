import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonId } from '../../domain/person/person-id.js';
import type { InvitationPreviewData } from '../models/space-views.js';
import type { SpaceReadQueries } from '../ports/private/space-read-queries.js';
import { NodeInvitationTokenGenerator } from '../../infrastructure/security/node-invitation-token-generator.js';
import { GetInvitationPreviewQuery } from './get-invitation-preview.query.js';

const now = new Date('2026-10-09T12:00:00.000Z');

function fixture() {
    const data: InvitationPreviewData = {
        invitation: {
            id: 'invitation-1',
            status: 'PENDING',
            expiresAt: '2026-10-12T12:00:00.000Z',
        },
        space: {
            id: 'space-1',
            type: 'SHARED',
            status: 'ACTIVE',
            label: 'Casa',
            version: 1,
        },
        invitedBy: { displayName: 'Convidante' },
        activeMemberCount: 1,
        actorIsCreator: false,
        actorIsMember: false,
    };
    const reads = {
        findInvitationPreview: vi
            .fn<SpaceReadQueries['findInvitationPreview']>()
            .mockResolvedValue(data),
        findInvitationResponseResult:
            vi.fn<SpaceReadQueries['findInvitationResponseResult']>(),
        listAccessible: vi.fn<SpaceReadQueries['listAccessible']>(),
        findDetails: vi.fn<SpaceReadQueries['findDetails']>(),
        findInvitationResult: vi.fn<SpaceReadQueries['findInvitationResult']>(),
    };
    const tokens = new NodeInvitationTokenGenerator();
    const hash = vi.spyOn(tokens, 'hash');
    return {
        data,
        reads,
        hash,
        query: new GetInvitationPreviewQuery(reads, tokens),
        actor: PersonId.create(),
    };
}

describe('GetInvitationPreviewQuery', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns only minimal identification for the exact hash', async () => {
        const f = fixture();
        const result = await f.query.execute(f.actor, 'a'.repeat(43));
        expect(f.hash).toHaveBeenCalledWith('a'.repeat(43));
        expect(result).toEqual({
            invitation: f.data.invitation,
            space: { id: 'space-1', label: 'Casa', version: 1 },
            invitedBy: { displayName: 'Convidante' },
            canRespond: true,
        });
        expect(result).not.toHaveProperty('actorIsMember');
        expect(f.reads.findInvitationResponseResult).not.toHaveBeenCalled();
    });

    it.each(['actorIsCreator', 'actorIsMember'] as const)(
        'offers no response for %s',
        async (field) => {
            const f = fixture();
            f.data[field] = true;
            expect(
                (await f.query.execute(f.actor, 'a'.repeat(43))).canRespond,
            ).toBe(false);
        },
    );

    it('rejects an unknown hash', async () => {
        const f = fixture();
        f.reads.findInvitationPreview.mockResolvedValue(null);
        await expect(
            f.query.execute(f.actor, 'a'.repeat(43)),
        ).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
    });

    it.each(['ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED'] as const)(
        'does not disclose identification for a %s invitation',
        async (status) => {
            const f = fixture();
            f.data.invitation.status = status;
            await expect(
                f.query.execute(f.actor, 'a'.repeat(43)),
            ).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
        },
    );

    it.each([-1, 0, 1])(
        'respects the expiration boundary: %i',
        async (offset) => {
            const f = fixture();
            vi.setSystemTime(
                new Date(Date.parse(f.data.invitation.expiresAt) + offset),
            );
            if (offset < 0)
                expect(
                    (await f.query.execute(f.actor, 'a'.repeat(43))).canRespond,
                ).toBe(true);
            else
                await expect(
                    f.query.execute(f.actor, 'a'.repeat(43)),
                ).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
        },
    );

    it.each(['CLOSING', 'CLOSED'] as const)(
        'blocks a %s space',
        async (status) => {
            const f = fixture();
            f.data.space.status = status;
            await expect(
                f.query.execute(f.actor, 'a'.repeat(43)),
            ).rejects.toMatchObject({ code: 'SPACE_NOT_ACTIVE' });
        },
    );

    it('does not reserve a slot in a full space', async () => {
        const f = fixture();
        f.data.activeMemberCount = 2;
        await expect(
            f.query.execute(f.actor, 'a'.repeat(43)),
        ).rejects.toMatchObject({ code: 'SPACE_MEMBER_LIMIT_REACHED' });
    });
});
