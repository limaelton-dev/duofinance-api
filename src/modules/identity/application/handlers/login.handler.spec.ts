import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';

import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type { PersonalContext } from '../../../spaces/application/models/personal-context.js';
import type { GetPersonalContext } from '../../../spaces/application/ports/public/get-personal-context.js';

import { LoginHandler } from './login.handler.js';
import { InvalidCredentialsError } from '../errors/invalid-credentials.error.js';
import type { AuthCredential } from '../models/auth-credential.js';
import type { CredentialRepository } from '../ports/private/credential.repository.js';
import type { SessionRepository } from '../ports/private/session.repository.js';
import type { PasswordHasher } from '../ports/private/password-hasher.js';
import type { SessionTokenGenerator } from '../ports/private/session-token-generator.js';

function createTestContext() {
    const input = {
        email: '  ELTON@EXAMPLE.COM  ',
        password: 'correct-horse-battery-staple',
    };

    const credential: AuthCredential = {
        personId: PersonId.create(),
        email: 'elton@example.com',
        passwordHash: 'stored-password-hash',
        createdAt: new Date('2026-09-01T12:00:00.000Z'),
        updatedAt: new Date('2026-09-01T12:00:00.000Z'),
    };

    const personalContext: PersonalContext = {
        person: {
            id: credential.personId,
            displayName: 'Elton',
        },
        personalSpace: {
            id: SpaceId.create(),
            type: 'PERSONAL',
            label: 'Meu espaço',
        },
    };

    const generatedToken = {
        token: 'generated-session-token',
        tokenHash: Buffer.alloc(32, 1),
    };

    const sessionTtlSeconds = 3600;

    const credentialRepository = {
        save: vi.fn<CredentialRepository['save']>(),
        findByEmail: vi
            .fn<CredentialRepository['findByEmail']>()
            .mockResolvedValue(credential),
        findByPersonId: vi.fn<CredentialRepository['findByPersonId']>(),
    } satisfies CredentialRepository;

    const passwordHasher = {
        hash: vi.fn<PasswordHasher['hash']>(),
        verify: vi.fn<PasswordHasher['verify']>().mockResolvedValue(true),
    } satisfies PasswordHasher;

    const getPersonalContext = {
        get: vi
            .fn<GetPersonalContext['get']>()
            .mockResolvedValue(personalContext),
    } satisfies GetPersonalContext;

    const sessionRepository = {
        save: vi.fn<SessionRepository['save']>().mockResolvedValue(undefined),
        findByTokenHash: vi.fn<SessionRepository['findByTokenHash']>(),
        deleteById: vi.fn<SessionRepository['deleteById']>(),
    } satisfies SessionRepository;

    const sessionTokenGenerator = {
        generate: vi
            .fn<SessionTokenGenerator['generate']>()
            .mockReturnValue(generatedToken),
        hash: vi.fn<SessionTokenGenerator['hash']>(),
    } satisfies SessionTokenGenerator;

    const configService = new ConfigService({
        SESSION_TTL_SECONDS: sessionTtlSeconds,
    });

    const handler = new LoginHandler(
        credentialRepository,
        passwordHasher,
        getPersonalContext,
        sessionRepository,
        sessionTokenGenerator,
        configService,
    );

    return {
        handler,
        input,
        credential,
        personalContext,
        generatedToken,
        sessionTtlSeconds,
        credentialRepository,
        passwordHasher,
        getPersonalContext,
        sessionRepository,
        sessionTokenGenerator,
    };
}

describe('LoginHandler', () => {
    it('rejects an unknown email without creating a session', async () => {
        const context = createTestContext();

        context.credentialRepository.findByEmail.mockResolvedValue(null);

        const execution = context.handler.execute(context.input);

        await expect(execution).rejects.toBeInstanceOf(InvalidCredentialsError);

        await expect(execution).rejects.toMatchObject({
            code: 'INVALID_CREDENTIALS',
            message: 'E-mail ou senha inválidos.',
        });

        expect(context.credentialRepository.findByEmail).toHaveBeenCalledWith(
            'elton@example.com',
        );

        expect(context.passwordHasher.verify).not.toHaveBeenCalled();
        expect(context.getPersonalContext.get).not.toHaveBeenCalled();
        expect(context.sessionTokenGenerator.generate).not.toHaveBeenCalled();
        expect(context.sessionRepository.save).not.toHaveBeenCalled();
    });

    it('rejects an incorrect password with the same credentials error', async () => {
        const context = createTestContext();

        context.passwordHasher.verify.mockResolvedValue(false);

        const execution = context.handler.execute(context.input);

        await expect(execution).rejects.toBeInstanceOf(InvalidCredentialsError);

        await expect(execution).rejects.toMatchObject({
            code: 'INVALID_CREDENTIALS',
            message: 'E-mail ou senha inválidos.',
        });

        expect(context.passwordHasher.verify).toHaveBeenCalledWith(
            context.input.password,
            context.credential.passwordHash,
        );

        expect(context.getPersonalContext.get).not.toHaveBeenCalled();
        expect(context.sessionTokenGenerator.generate).not.toHaveBeenCalled();
        expect(context.sessionRepository.save).not.toHaveBeenCalled();
    });

    it('creates a session and returns the context for valid credentials', async () => {
        const context = createTestContext();

        const result = await context.handler.execute(context.input);

        expect(context.credentialRepository.findByEmail).toHaveBeenCalledWith(
            'elton@example.com',
        );

        expect(context.passwordHasher.verify).toHaveBeenCalledWith(
            context.input.password,
            context.credential.passwordHash,
        );

        expect(context.getPersonalContext.get).toHaveBeenCalledWith(
            context.credential.personId,
        );

        expect(context.sessionTokenGenerator.generate).toHaveBeenCalledTimes(1);

        expect(context.sessionRepository.save).toHaveBeenCalledTimes(1);

        const savedSession = context.sessionRepository.save.mock.calls[0][0];

        expect(savedSession).toEqual({
            id: expect.any(String),
            personId: context.credential.personId,
            tokenHash: context.generatedToken.tokenHash,
            createdAt: expect.any(Date),
            expiresAt: new Date(
                savedSession.createdAt.getTime() +
                    context.sessionTtlSeconds * 1000,
            ),
        });

        expect(result).toEqual({
            sessionToken: context.generatedToken.token,
            context: {
                person: {
                    id: context.credential.personId.value,
                    displayName: 'Elton',
                    email: 'elton@example.com',
                },
                personalSpace: {
                    id: context.personalContext.personalSpace.id.value,
                    type: 'PERSONAL',
                    label: 'Meu espaço',
                },
            },
        });

        expect(context.passwordHasher.hash).not.toHaveBeenCalled();
        expect(context.credentialRepository.save).not.toHaveBeenCalled();
        expect(context.sessionRepository.deleteById).not.toHaveBeenCalled();
    });

    it('does not create a session when the personal context is missing', async () => {
        const context = createTestContext();

        context.getPersonalContext.get.mockResolvedValue(null);

        await expect(context.handler.execute(context.input)).rejects.toThrow(
            'Authenticated person has no personal context',
        );

        expect(context.sessionTokenGenerator.generate).not.toHaveBeenCalled();
        expect(context.sessionRepository.save).not.toHaveBeenCalled();
    });

    it('propagates credential lookup failures without creating a session', async () => {
        const context = createTestContext();
        const error = new Error('Credential lookup failed');

        context.credentialRepository.findByEmail.mockRejectedValue(error);

        await expect(context.handler.execute(context.input)).rejects.toBe(
            error,
        );

        expect(context.passwordHasher.verify).not.toHaveBeenCalled();
        expect(context.getPersonalContext.get).not.toHaveBeenCalled();
        expect(context.sessionTokenGenerator.generate).not.toHaveBeenCalled();
        expect(context.sessionRepository.save).not.toHaveBeenCalled();
    });

    it('propagates password verification failures without creating a session', async () => {
        const context = createTestContext();
        const error = new Error('Password verification failed');

        context.passwordHasher.verify.mockRejectedValue(error);

        await expect(context.handler.execute(context.input)).rejects.toBe(
            error,
        );

        expect(context.getPersonalContext.get).not.toHaveBeenCalled();
        expect(context.sessionTokenGenerator.generate).not.toHaveBeenCalled();
        expect(context.sessionRepository.save).not.toHaveBeenCalled();
    });

    it('propagates context lookup failures without creating a session', async () => {
        const context = createTestContext();
        const error = new Error('Personal context lookup failed');

        context.getPersonalContext.get.mockRejectedValue(error);

        await expect(context.handler.execute(context.input)).rejects.toBe(
            error,
        );

        expect(context.sessionTokenGenerator.generate).not.toHaveBeenCalled();
        expect(context.sessionRepository.save).not.toHaveBeenCalled();
    });

    it('does not return success when saving the session fails', async () => {
        const context = createTestContext();
        const error = new Error('Session save failed');

        context.sessionRepository.save.mockRejectedValue(error);

        await expect(context.handler.execute(context.input)).rejects.toBe(
            error,
        );

        expect(context.sessionRepository.save).toHaveBeenCalledTimes(1);
    });
});
