import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work.js';
import { SpacesDomainError } from '../../domain/errors/spaces-domain.error.js';
import { InvitationId } from '../../domain/invitation/invitation-id.js';
import { MemberId } from '../../domain/member/member-id.js';
import { Member } from '../../domain/member/member.js';
import { PersonId } from '../../domain/person/person-id.js';
import { SpaceId } from '../../domain/space/space-id.js';
import { Space, SpaceType } from '../../domain/space/space.js';
import { ConcurrentModificationError } from '../errors/concurrent-modification.error.js';
import { IdempotencyKeyReusedError } from '../errors/idempotency-key-reused.error.js';
import { SpaceCommandReceiptConflictError } from '../errors/space-command-receipt-conflict.error.js';
import type { SpaceInvitationView } from '../models/space-views.js';
import type { InvitationTokenGenerator } from '../ports/private/invitation-token-generator.js';
import type {
    SpaceCommand,
    SpaceCommandReceipts,
} from '../ports/private/space-command-receipts.js';
import type { SpaceReadQueries } from '../ports/private/space-read-queries.js';
import type { SpaceRepository } from '../ports/private/space.repository.js';
import { SpaceInvitationCommandService } from './space-invitation-command.service.js';
import type { SpaceAccessPort } from '../ports/public/space-access.port.js';

const now = new Date('2026-09-28T12:00:00.000Z');

function fixture(issuedAt = now) {
    const actorId = PersonId.create();
    const invitationId = InvitationId.create();
    const space = Space.createShared({
        id: SpaceId.create(),
        name: 'Casa',
        createdByPersonId: actorId,
        creatorMemberId: MemberId.create(),
        invitationId,
        now: issuedAt,
    });

    const repository = {
        save: vi.fn<SpaceRepository['save']>(),
        findPersonalByOwnerPersonId:
            vi.fn<SpaceRepository['findPersonalByOwnerPersonId']>(),
        findById: vi.fn<SpaceRepository['findById']>().mockResolvedValue(space),
        findByInvitationTokenHash:
            vi.fn<SpaceRepository['findByInvitationTokenHash']>(),
        createShared: vi.fn<SpaceRepository['createShared']>(),
        saveInvitationChange: vi.fn<SpaceRepository['saveInvitationChange']>(),
        saveInvitationResponse:
            vi.fn<SpaceRepository['saveInvitationResponse']>(),
    };

    const receipts = {
        find: vi.fn<SpaceCommandReceipts['find']>().mockResolvedValue(null),
        save: vi.fn<SpaceCommandReceipts['save']>(),
    };

    const readQueries = {
        findInvitationPreview:
            vi.fn<SpaceReadQueries['findInvitationPreview']>(),
        findInvitationResponseResult:
            vi.fn<SpaceReadQueries['findInvitationResponseResult']>(),
        listAccessible: vi.fn<SpaceReadQueries['listAccessible']>(),
        findDetails: vi.fn<SpaceReadQueries['findDetails']>(),
        findInvitationResult: vi.fn<SpaceReadQueries['findInvitationResult']>(),
    };

    const tokens = {
        hash: vi.fn<InvitationTokenGenerator['hash']>(),
        generate: vi
            .fn<InvitationTokenGenerator['generate']>()
            .mockReturnValue({
                token: 'a'.repeat(43),
                tokenHash: new Uint8Array(32),
            }),
    };

    const uow: UnitOfWork = {
        execute: async (work) => work(),
    };

    const transaction = vi.spyOn(uow, 'execute');
    const access = {
        assertCanRead: vi.fn<SpaceAccessPort['assertCanRead']>(),
        assertCanWrite: vi.fn<SpaceAccessPort['assertCanWrite']>(),
    };

    const service = new SpaceInvitationCommandService(
        uow,
        repository,
        receipts,
        tokens,
        readQueries,
        new ConfigService({ WEB_ORIGIN: 'https://app.example.com' }),
        access,
    );

    const command: Extract<SpaceCommand, { operation: 'REPLACE_INVITATION' }> =
        {
            operation: 'REPLACE_INVITATION',
            actorId,
            key: randomUUID(),
            spaceId: space.id,
            invitationId,
            expectedVersion: 1,
        };

    const receipt = {
        resultSpaceId: space.id,
        resultInvitationId: invitationId,
        createdAt: issuedAt,
    };

    const replayView: SpaceInvitationView = {
        space: {
            id: space.id.value,
            type: 'SHARED',
            status: 'ACTIVE',
            label: 'Casa',
            version: 2,
        },
        actorMembership: {
            id: space.members[0].id.value,
            personId: actorId.value,
            status: 'ACTIVE',
        },
        invitation: {
            id: invitationId.value,
            status: 'CANCELLED',
            expiresAt: space.invitations[0].expiresAt.toISOString(),
        },
    };

    return {
        actorId,
        space,
        invitationId,
        repository,
        receipts,
        readQueries,
        tokens,
        transaction,
        access,
        service,
        command,
        receipt,
        replayView,
    };
}

describe('SpaceInvitationCommandService', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('creates the aggregate and receipt and returns the link only on issuance', async () => {
        const f = fixture();
        const result = await f.service.execute({
            operation: 'CREATE_SPACE',
            actorId: f.actorId,
            key: randomUUID(),
            name: '  Casa  ',
        });

        expect(result.space.label).toBe('Casa');
        expect(result.space.version).toBe(1);
        expect(result.inviteUrl).toBe(
            `https://app.example.com/invitations#token=${'a'.repeat(43)}`,
        );
        expect(result.replayed).toBe(false);
        expect(result).not.toHaveProperty('tokenHash');
        expect(f.repository.createShared).toHaveBeenCalledTimes(1);
        expect(f.access.assertCanWrite).not.toHaveBeenCalled();
        expect(f.receipts.save).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                resultSpaceId: expect.objectContaining({
                    value: result.space.id,
                }),
                resultInvitationId: expect.objectContaining({
                    value: result.invitation.id,
                }),
            }),
        );
    });

    it('rejects an invalid name before generating a token or persisting', async () => {
        const f = fixture();

        await expect(
            f.service.execute({
                operation: 'CREATE_SPACE',
                actorId: f.actorId,
                key: randomUUID(),
                name: ' ',
            }),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

        expect(f.tokens.generate).not.toHaveBeenCalled();
        expect(f.repository.createShared).not.toHaveBeenCalled();
        expect(f.receipts.save).not.toHaveBeenCalled();
    });

    it('issues an invitation after expiration using the current time', async () => {
        const f = fixture(new Date(now.getTime() - 72 * 60 * 60 * 1000));

        const result = await f.service.execute({
            operation: 'ISSUE_INVITATION',
            actorId: f.actorId,
            key: randomUUID(),
            spaceId: f.space.id,
            expectedVersion: 1,
        });

        expect(result.space.version).toBe(2);
        expect(f.space.invitations[0].status).toBe('EXPIRED');
        expect(result.invitation.expiresAt).toBe('2026-10-01T12:00:00.000Z');
        expect(f.repository.saveInvitationChange).toHaveBeenCalledTimes(1);
        expect(f.access.assertCanWrite).toHaveBeenCalledWith(
            f.actorId,
            f.space.id,
        );
    });

    it('replaces through the root and saves the new invitation receipt', async () => {
        const f = fixture();
        const result = await f.service.execute(f.command);

        expect(f.space.invitations[0].status).toBe('CANCELLED');
        expect(result.invitation.id).not.toBe(f.invitationId.value);
        expect(result.space.version).toBe(2);
        expect(f.repository.saveInvitationChange).toHaveBeenCalledWith(
            f.space,
            1,
            expect.objectContaining({
                invitationId: expect.objectContaining({
                    value: result.invitation.id,
                }),
            }),
        );
    });

    it('checks replay before rejecting a stale version', async () => {
        const f = fixture();
        f.receipts.find.mockResolvedValue(f.receipt);
        f.readQueries.findInvitationResult.mockResolvedValue(f.replayView);

        const result = await f.service.execute({
            ...f.command,
            expectedVersion: 99,
        });

        expect(result.replayed).toBe(true);
        expect(result.inviteUrl).toBeNull();
        expect(result.invitation.id).toBe(f.invitationId.value);
        expect(result.invitation.status).toBe('CANCELLED');
        expect(f.tokens.generate).not.toHaveBeenCalled();
        expect(f.repository.saveInvitationChange).not.toHaveBeenCalled();
        expect(f.receipts.save).not.toHaveBeenCalled();
        expect(f.access.assertCanWrite).not.toHaveBeenCalled();
    });

    it.each(['missing', 'outsider', 'member'] as const)(
        'checks access before the receipt: %s',
        async (scenario) => {
            const f = fixture();
            const actor = PersonId.create();

            if (scenario === 'missing') {
                f.repository.findById.mockResolvedValue(null);
            }

            if (scenario === 'member') {
                const props = f.space.snapshot();

                if (props.type !== SpaceType.SHARED) {
                    throw new Error('Expected shared fixture');
                }

                f.repository.findById.mockResolvedValue(
                    Space.restore({
                        ...props,
                        members: [
                            ...props.members,
                            Member.create(MemberId.create(), actor, now),
                        ],
                    }),
                );
            }

            await expect(
                f.service.execute({ ...f.command, actorId: actor }),
            ).rejects.toMatchObject({
                code:
                    scenario === 'member'
                        ? 'INVITATION_ISSUER_REQUIRED'
                        : 'SPACE_NOT_FOUND',
            });

            expect(f.receipts.find).not.toHaveBeenCalled();
            expect(f.tokens.generate).not.toHaveBeenCalled();
        },
    );

    it('revalidates access to the result of a creation replay', async () => {
        const f = fixture();
        f.receipts.find.mockResolvedValue(f.receipt);
        f.readQueries.findInvitationResult.mockResolvedValue(null);

        await expect(
            f.service.execute({
                operation: 'CREATE_SPACE',
                actorId: f.actorId,
                key: randomUUID(),
                name: 'Casa',
            }),
        ).rejects.toThrow(new SpacesDomainError('SPACE_NOT_FOUND'));

        expect(f.repository.createShared).not.toHaveBeenCalled();
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
        'recovers the winning receipt without repeating the write: $label',
        async ({ error }) => {
            const f = fixture();

            f.receipts.find
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(f.receipt);
            f.repository.saveInvitationChange.mockRejectedValueOnce(error);
            f.readQueries.findInvitationResult.mockResolvedValue(f.replayView);

            const result = await f.service.execute(f.command);

            expect(result.replayed).toBe(true);
            expect(result.inviteUrl).toBeNull();
            expect(f.transaction).toHaveBeenCalledTimes(2);
            expect(f.tokens.generate).toHaveBeenCalledTimes(1);
            expect(f.repository.saveInvitationChange).toHaveBeenCalledTimes(1);
        },
    );

    it('preserves the conflict when there is no receipt to recover', async () => {
        const f = fixture();

        await expect(
            f.service.execute({ ...f.command, expectedVersion: 2 }),
        ).rejects.toBeInstanceOf(ConcurrentModificationError);

        expect(f.tokens.generate).not.toHaveBeenCalled();
        expect(f.repository.saveInvitationChange).not.toHaveBeenCalled();
    });

    it('preserves the error for a key reused with different input', async () => {
        const f = fixture();
        f.receipts.find.mockRejectedValue(new IdempotencyKeyReusedError());

        await expect(f.service.execute(f.command)).rejects.toBeInstanceOf(
            IdempotencyKeyReusedError,
        );

        expect(f.transaction).toHaveBeenCalledTimes(1);
        expect(f.tokens.generate).not.toHaveBeenCalled();
    });

    it('does not turn technical failure into retry or replay', async () => {
        const f = fixture();
        const failure = new Error('Database unavailable');
        f.repository.saveInvitationChange.mockRejectedValue(failure);

        await expect(f.service.execute(f.command)).rejects.toBe(failure);

        expect(f.transaction).toHaveBeenCalledTimes(1);
        expect(f.repository.saveInvitationChange).toHaveBeenCalledTimes(1);
        expect(f.receipts.save).not.toHaveBeenCalled();
    });

    it('denies new side effects through the access port inside the transaction before generating a secret or persisting', async () => {
        const f = fixture();
        let inTransaction = false;
        f.transaction.mockImplementation(async (work) => {
            inTransaction = true;
            try {
                return await work();
            } finally {
                inTransaction = false;
            }
        });
        f.access.assertCanWrite.mockImplementation(async () => {
            expect(inTransaction).toBe(true);
            throw new SpacesDomainError('SPACE_NOT_ACTIVE');
        });
        await expect(f.service.execute(f.command)).rejects.toMatchObject({
            code: 'SPACE_NOT_ACTIVE',
        });
        expect(f.tokens.generate).not.toHaveBeenCalled();
        expect(f.repository.saveInvitationChange).not.toHaveBeenCalled();
        expect(f.receipts.save).not.toHaveBeenCalled();
    });

    it('keeps the compare-and-swap check before the write access check', async () => {
        const f = fixture();
        f.access.assertCanWrite.mockRejectedValue(
            new SpacesDomainError('SPACE_NOT_ACTIVE'),
        );
        await expect(
            f.service.execute({ ...f.command, expectedVersion: 99 }),
        ).rejects.toBeInstanceOf(ConcurrentModificationError);
        expect(f.access.assertCanWrite).not.toHaveBeenCalled();
    });
});
