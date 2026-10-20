import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { UnauthenticatedError } from '../errors/unauthenticated.error.js';
import type { AuthSession } from '../models/auth-session.js';
import type { SessionRepository } from '../ports/private/session.repository.js';
import type { SessionTokenGenerator } from '../ports/private/session-token-generator.js';
import { SessionService } from './session.service.js';

const now = new Date('2026-09-22T12:00:00.000Z').getTime();

function createTestContext() {
    const token = 'AbC-session-token_123';
    const tokenHash = Buffer.alloc(32, 1);

    const session: AuthSession = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        personId: PersonId.create(),
        tokenHash,
        createdAt: new Date(now - 60_000),
        expiresAt: new Date(now + 60_000),
    };

    const sessionRepository = {
        save: vi.fn<SessionRepository['save']>(),
        findByTokenHash: vi
            .fn<SessionRepository['findByTokenHash']>()
            .mockResolvedValue(session),
        deleteById: vi.fn<SessionRepository['deleteById']>(),
    } satisfies SessionRepository;

    const sessionTokenGenerator = {
        generate: vi.fn<SessionTokenGenerator['generate']>(),
        hash: vi.fn<SessionTokenGenerator['hash']>().mockReturnValue(tokenHash),
    } satisfies SessionTokenGenerator;

    const service = new SessionService(
        sessionRepository,
        sessionTokenGenerator,
    );

    return {
        service,
        token,
        tokenHash,
        session,
        sessionRepository,
        sessionTokenGenerator,
    };
}

describe('SessionService', () => {
    beforeEach(() => {
        vi.spyOn(Date, 'now').mockReturnValue(now);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('authenticates a valid session without extending its expiration', async () => {
        const context = createTestContext();
        const expiresAt = context.session.expiresAt.getTime();

        const result = await context.service.authenticate(context.token);

        expect(result).toEqual({
            personId: context.session.personId,
            sessionId: context.session.id,
        });

        expect(context.sessionTokenGenerator.hash).toHaveBeenCalledWith(
            context.token,
        );

        expect(context.sessionRepository.findByTokenHash).toHaveBeenCalledWith(
            context.tokenHash,
        );

        expect(context.session.expiresAt.getTime()).toBe(expiresAt);
        expect(context.sessionRepository.save).not.toHaveBeenCalled();
        expect(context.sessionTokenGenerator.generate).not.toHaveBeenCalled();
    });

    it.each([
        { label: 'missing', token: undefined },
        { label: 'null', token: null },
        { label: 'empty', token: '' },
        { label: 'numeric', token: 123 },
        { label: 'object', token: {} },
        { label: 'array', token: [] },
    ])(
        'rejects $label tokens before querying the repository',
        async ({ token }) => {
            const context = createTestContext();

            await expect(
                context.service.authenticate(token),
            ).rejects.toBeInstanceOf(UnauthenticatedError);

            expect(context.sessionTokenGenerator.hash).not.toHaveBeenCalled();
            expect(
                context.sessionRepository.findByTokenHash,
            ).not.toHaveBeenCalled();
        },
    );

    it('preserves the token exactly as received', async () => {
        const context = createTestContext();
        const token = '  AbC-session-token_123  ';

        await context.service.authenticate(token);

        expect(context.sessionTokenGenerator.hash).toHaveBeenCalledWith(token);
    });

    it('rejects a token with no matching session', async () => {
        const context = createTestContext();
        context.sessionRepository.findByTokenHash.mockResolvedValue(null);

        const execution = context.service.authenticate(context.token);

        await expect(execution).rejects.toBeInstanceOf(UnauthenticatedError);
        await expect(execution).rejects.toMatchObject({
            code: 'UNAUTHENTICATED',
            message: 'Sua sessão não é válida ou expirou.',
        });
    });

    it.each([
        { label: 'before the current instant', offset: -1 },
        { label: 'exactly at the current instant', offset: 0 },
    ])('rejects a session that expires $label', async ({ offset }) => {
        const context = createTestContext();
        context.session.expiresAt = new Date(now + offset);

        await expect(
            context.service.authenticate(context.token),
        ).rejects.toBeInstanceOf(UnauthenticatedError);
    });

    it('propagates hashing failures without querying the repository', async () => {
        const context = createTestContext();
        const error = new Error('Hash calculation failed');

        context.sessionTokenGenerator.hash.mockImplementation(() => {
            throw error;
        });

        await expect(context.service.authenticate(context.token)).rejects.toBe(
            error,
        );

        expect(
            context.sessionRepository.findByTokenHash,
        ).not.toHaveBeenCalled();
    });

    it('propagates repository failures without treating them as an invalid session', async () => {
        const context = createTestContext();
        const error = new Error('Session lookup failed');

        context.sessionRepository.findByTokenHash.mockRejectedValue(error);

        await expect(context.service.authenticate(context.token)).rejects.toBe(
            error,
        );
    });
});
