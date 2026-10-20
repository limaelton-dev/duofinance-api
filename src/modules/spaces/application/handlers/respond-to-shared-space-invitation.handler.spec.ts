import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work.js';
import { InvitationId } from '../../domain/invitation/invitation-id.js';
import { MemberId } from '../../domain/member/member-id.js';
import { PersonId } from '../../domain/person/person-id.js';
import { SpaceId } from '../../domain/space/space-id.js';
import { Space } from '../../domain/space/space.js';
import { ConcurrentModificationError } from '../errors/concurrent-modification.error.js';
import { IdempotencyKeyReusedError } from '../errors/idempotency-key-reused.error.js';
import { SpaceCommandReceiptConflictError } from '../errors/space-command-receipt-conflict.error.js';
import type { InvitationResponseView } from '../models/space-views.js';
import type { SpaceCommandReceipts } from '../ports/private/space-command-receipts.js';
import type { SpaceReadQueries } from '../ports/private/space-read-queries.js';
import type { SpaceRepository } from '../ports/private/space.repository.js';
import { NodeInvitationTokenGenerator } from '../../infrastructure/security/node-invitation-token-generator.js';
import { RespondToSharedSpaceInvitationHandler } from './respond-to-shared-space-invitation.handler.js';

const now = new Date('2026-10-09T12:00:00.000Z');

function fixture(decision: 'ACCEPT' | 'REJECT' = 'ACCEPT') {
    const creator = PersonId.create();
    const actorId = PersonId.create();
    const invitationId = InvitationId.create();
    const space = Space.createShared({
        id: SpaceId.create(),
        name: 'Casa',
        createdByPersonId: creator,
        creatorMemberId: MemberId.create(),
        invitationId,
        now,
    });
    const repository = {
        save: vi.fn<SpaceRepository['save']>(),
        findPersonalByOwnerPersonId:
            vi.fn<SpaceRepository['findPersonalByOwnerPersonId']>(),
        findById: vi.fn<SpaceRepository['findById']>(),
        findByInvitationTokenHash: vi
            .fn<SpaceRepository['findByInvitationTokenHash']>()
            .mockResolvedValue({ space, invitationId }),
        createShared: vi.fn<SpaceRepository['createShared']>(),
        saveInvitationChange: vi.fn<SpaceRepository['saveInvitationChange']>(),
        saveInvitationResponse:
            vi.fn<SpaceRepository['saveInvitationResponse']>(),
    };
    const receipts = {
        find: vi.fn<SpaceCommandReceipts['find']>().mockResolvedValue(null),
        save: vi.fn<SpaceCommandReceipts['save']>(),
    };
    const reads = {
        findInvitationPreview:
            vi.fn<SpaceReadQueries['findInvitationPreview']>(),
        findInvitationResponseResult:
            vi.fn<SpaceReadQueries['findInvitationResponseResult']>(),
        listAccessible: vi.fn<SpaceReadQueries['listAccessible']>(),
        findDetails: vi.fn<SpaceReadQueries['findDetails']>(),
        findInvitationResult: vi.fn<SpaceReadQueries['findInvitationResult']>(),
    };
    const uow: UnitOfWork = { execute: async (work) => work() };
    const transaction = vi.spyOn(uow, 'execute');
    const handler = new RespondToSharedSpaceInvitationHandler(
        uow,
        repository,
        receipts,
        new NodeInvitationTokenGenerator(),
        reads,
    );
    const input = {
        actorId,
        key: randomUUID(),
        token: 'a'.repeat(43),
        decision,
        expectedVersion: 1,
    };
    const receipt = {
        resultSpaceId: space.id,
        resultInvitationId: invitationId,
        createdAt: now,
    };
    const view: InvitationResponseView =
        decision === 'ACCEPT'
            ? {
                  decision,
                  invitation: {
                      id: invitationId.value,
                      status: 'ACCEPTED',
                      resolvedAt: now.toISOString(),
                  },
                  spaceId: space.id.value,
                  actorMembership: {
                      id: 'member-id',
                      personId: actorId.value,
                      status: 'ACTIVE',
                  },
              }
            : {
                  decision,
                  invitation: {
                      id: invitationId.value,
                      status: 'REJECTED',
                      resolvedAt: now.toISOString(),
                  },
                  spaceId: space.id.value,
                  actorMembership: null,
              };
    return {
        creator,
        actorId,
        space,
        invitationId,
        input,
        receipt,
        view,
        repository,
        receipts,
        reads,
        transaction,
        handler,
    };
}

describe('RespondToSharedSpaceInvitationHandler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it.each(['ACCEPT', 'REJECT'] as const)(
        'orchestrates %s and its receipt in the same transaction',
        async (decision) => {
            const f = fixture(decision);
            const result = await f.handler.execute(f.input);
            expect(result).toMatchObject({
                decision,
                spaceId: f.space.id.value,
                replayed: false,
                invitation: {
                    id: f.invitationId.value,
                    resolvedAt: now.toISOString(),
                },
            });
            expect(f.space.members).toHaveLength(decision === 'ACCEPT' ? 2 : 1);
            expect(f.space.version).toBe(2);
            expect(result.actorMembership === null).toBe(decision === 'REJECT');
            expect(f.repository.saveInvitationResponse).toHaveBeenCalledWith(
                f.space,
                1,
                {
                    invitationId: f.invitationId,
                    memberId:
                        decision === 'ACCEPT' ? expect.any(MemberId) : null,
                },
            );
            expect(f.receipts.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    operation: 'RESPOND_INVITATION',
                    decision,
                    expectedVersion: 1,
                    actorId: f.actorId,
                }),
                f.receipt,
            );
            expect(f.receipts.save.mock.calls[0][0]).not.toHaveProperty(
                'token',
            );
            expect(f.transaction).toHaveBeenCalledTimes(1);
        },
    );

    it.each(['ACCEPT', 'REJECT'] as const)(
        'replays %s before checking expiration and version',
        async (decision) => {
            const f = fixture(decision);
            f.receipts.find.mockResolvedValue(f.receipt);
            f.reads.findInvitationResponseResult.mockResolvedValue(f.view);
            vi.setSystemTime(new Date(now.getTime() + 73 * 60 * 60 * 1000));
            expect(
                await f.handler.execute({ ...f.input, expectedVersion: 99 }),
            ).toEqual({ ...f.view, replayed: true });
            expect(
                f.repository.findByInvitationTokenHash,
            ).not.toHaveBeenCalled();
            expect(f.repository.saveInvitationResponse).not.toHaveBeenCalled();
            expect(f.receipts.save).not.toHaveBeenCalled();
        },
    );

    it('blocks the creator without consuming the invitation', async () => {
        const f = fixture();
        await expect(
            f.handler.execute({ ...f.input, actorId: f.creator }),
        ).rejects.toMatchObject({ code: 'INVITATION_RESPONSE_NOT_ALLOWED' });
        expect(f.space.version).toBe(1);
        expect(f.repository.saveInvitationResponse).not.toHaveBeenCalled();
    });

    it('rejects a stale version without repeating the decision', async () => {
        const f = fixture();
        await expect(
            f.handler.execute({ ...f.input, expectedVersion: 99 }),
        ).rejects.toBeInstanceOf(ConcurrentModificationError);
        expect(f.space.version).toBe(1);
        expect(f.repository.saveInvitationResponse).not.toHaveBeenCalled();
        expect(f.transaction).toHaveBeenCalledTimes(2);
    });

    it('revalidates time inside the transaction after the read', async () => {
        const f = fixture();
        f.repository.findByInvitationTokenHash.mockImplementation(async () => {
            vi.setSystemTime(f.space.invitations[0].expiresAt);
            return { space: f.space, invitationId: f.invitationId };
        });
        await expect(f.handler.execute(f.input)).rejects.toMatchObject({
            code: 'INVITATION_UNAVAILABLE',
        });
        expect(f.repository.saveInvitationResponse).not.toHaveBeenCalled();
    });

    it('does not disclose data for an unknown invitation', async () => {
        const f = fixture();
        f.repository.findByInvitationTokenHash.mockResolvedValue(null);
        await expect(f.handler.execute(f.input)).rejects.toMatchObject({
            code: 'INVITATION_UNAVAILABLE',
        });
        expect(f.receipts.save).not.toHaveBeenCalled();
    });

    it.each([
        {
            label: 'ConcurrentModificationError',
            error: new ConcurrentModificationError(),
        },
        {
            label: 'SpaceCommandReceiptConflictError',
            error: new SpaceCommandReceiptConflictError(),
        },
    ])(
        'recovers the receipt in a new transaction after $label',
        async ({ error }) => {
            const f = fixture();
            f.receipts.find
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(f.receipt);
            f.repository.saveInvitationResponse.mockRejectedValueOnce(error);
            f.reads.findInvitationResponseResult.mockResolvedValue(f.view);
            expect(await f.handler.execute(f.input)).toEqual({
                ...f.view,
                replayed: true,
            });
            expect(f.transaction).toHaveBeenCalledTimes(2);
            expect(f.repository.saveInvitationResponse).toHaveBeenCalledTimes(
                1,
            );
            expect(f.receipts.save).not.toHaveBeenCalled();
        },
    );

    it('recovers a receipt committed between the two reads', async () => {
        const f = fixture('REJECT');
        f.space.rejectInvitation(f.actorId, f.invitationId, now);
        f.receipts.find
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(f.receipt);
        f.reads.findInvitationResponseResult.mockResolvedValue(f.view);
        expect(await f.handler.execute(f.input)).toEqual({
            ...f.view,
            replayed: true,
        });
        expect(f.repository.saveInvitationResponse).not.toHaveBeenCalled();
    });

    it('does not use the private creator results for replay', async () => {
        const f = fixture('REJECT');
        f.receipts.find.mockResolvedValue(f.receipt);
        f.reads.findInvitationResponseResult.mockResolvedValue(null);
        await expect(f.handler.execute(f.input)).rejects.toMatchObject({
            code: 'INVITATION_UNAVAILABLE',
        });
        expect(f.reads.findInvitationResult).not.toHaveBeenCalled();
        expect(f.repository.findById).not.toHaveBeenCalled();
    });

    it('does not write when a key is reused with different input', async () => {
        const f = fixture();
        f.receipts.find.mockRejectedValue(new IdempotencyKeyReusedError());
        await expect(f.handler.execute(f.input)).rejects.toBeInstanceOf(
            IdempotencyKeyReusedError,
        );
        expect(f.repository.saveInvitationResponse).not.toHaveBeenCalled();
        expect(f.transaction).toHaveBeenCalledTimes(1);
    });

    it('does not report success or retry automatically after receipt failure', async () => {
        const f = fixture();
        f.receipts.save.mockRejectedValue(new Error('Injected failure'));
        await expect(f.handler.execute(f.input)).rejects.toThrow(
            'Injected failure',
        );
        expect(f.repository.saveInvitationResponse).toHaveBeenCalledTimes(1);
        expect(f.transaction).toHaveBeenCalledTimes(1);
    });
});
