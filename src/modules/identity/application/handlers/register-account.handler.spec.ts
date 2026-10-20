import { describe, expect, it, vi } from 'vitest';
import { AuthCredential } from '../models/auth-credential.js';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { type CredentialRepository } from '../ports/private/credential.repository.js';
import { SessionRepository } from '../ports/private/session.repository.js';
import { PasswordHasher } from '../ports/private/password-hasher.js';
import { SessionTokenGenerator } from '../ports/private/session-token-generator.js';
import { ProvisionPersonalContext } from '../../../spaces/application/ports/public/provision-personal-context.js';
import { UnitOfWork } from '../../../../shared/application/unit-of-work.js';
import { ConfigService } from '@nestjs/config';
import { RegisterAccountHandler } from './register-account.handler.js';
import { EmailAlreadyInUseError } from '../errors/email-already-in-use.error.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';

describe('RegisterAccountHandler', () => {
    it('rejects an existing email without starting registration', async () => {
        const existingCredential: AuthCredential = {
            personId: PersonId.create(),
            email: 'elton@example.com',
            passwordHash: 'existing-password-hash',
            createdAt: new Date('2026-09-01T12:00:00.000Z'),
            updatedAt: new Date('2026-09-01T12:00:00.000Z'),
        };

        const credentialRepository = {
            save: vi.fn<CredentialRepository['save']>(),
            findByEmail: vi
                .fn<CredentialRepository['findByEmail']>()
                .mockResolvedValue(existingCredential),
            findByPersonId: vi.fn<CredentialRepository['findByPersonId']>(),
        } satisfies CredentialRepository;

        const sessionRepository = {
            save: vi.fn<SessionRepository['save']>(),
            findByTokenHash: vi.fn<SessionRepository['findByTokenHash']>(),
            deleteById: vi.fn<SessionRepository['deleteById']>(),
        } satisfies SessionRepository;

        const passwordHasher = {
            hash: vi.fn<PasswordHasher['hash']>(),
            verify: vi.fn<PasswordHasher['verify']>(),
        } satisfies PasswordHasher;

        const sessionTokenGenerator = {
            generate: vi.fn<SessionTokenGenerator['generate']>(),
            hash: vi.fn<SessionTokenGenerator['hash']>(),
        } satisfies SessionTokenGenerator;

        const provisionPersonalContext = {
            provision: vi.fn<ProvisionPersonalContext['provision']>(),
        } satisfies ProvisionPersonalContext;

        const unitOfWork: UnitOfWork = {
            async execute<T>(work: () => Promise<T>): Promise<T> {
                return work();
            },
        };

        const executeTransaction = vi.spyOn(unitOfWork, 'execute');

        const configService = new ConfigService({
            SESSION_TTL_SECONDS: 604800,
        });

        const handler = new RegisterAccountHandler(
            unitOfWork,
            provisionPersonalContext,
            credentialRepository,
            sessionRepository,
            passwordHasher,
            sessionTokenGenerator,
            configService,
        );

        await expect(
            handler.execute({
                displayName: 'Elton',
                email: '  ELTON@EXAMPLE.COM  ',
                password: 'correct-horse-battery-staple',
            }),
        ).rejects.toBeInstanceOf(EmailAlreadyInUseError);

        expect(credentialRepository.findByEmail).toHaveBeenCalledWith(
            'elton@example.com',
        );

        expect(executeTransaction).not.toHaveBeenCalled();
        expect(provisionPersonalContext.provision).not.toHaveBeenCalled();
        expect(credentialRepository.save).not.toHaveBeenCalled();
        expect(sessionRepository.save).not.toHaveBeenCalled();
        expect(passwordHasher.hash).not.toHaveBeenCalled();
        expect(sessionTokenGenerator.generate).not.toHaveBeenCalled();
    });

    it('creates the context and saves the credential and session within the unit of work', async () => {
        const password = 'correct-horse-battery-staple';
        const passwordHash = 'generated-password-hash';
        const sessionToken = 'generated-session-token';
        const tokenHash = Buffer.alloc(32, 1);
        const sessionTtlSeconds = 3600;

        let transactionActive = false;

        const unitOfWork: UnitOfWork = {
            async execute<T>(work: () => Promise<T>): Promise<T> {
                transactionActive = true;

                try {
                    return await work();
                } finally {
                    transactionActive = false;
                }
            },
        };

        const executeTransaction = vi.spyOn(unitOfWork, 'execute');

        const provisionPersonalContext = {
            provision: vi
                .fn<ProvisionPersonalContext['provision']>()
                .mockImplementation(async (input) => {
                    expect(transactionActive).toBe(true);

                    return {
                        person: {
                            id: input.personId,
                            displayName: input.displayName,
                        },
                        personalSpace: {
                            id: input.spaceId,
                            type: 'PERSONAL',
                            label: 'Meu espaço',
                        },
                    };
                }),
        } satisfies ProvisionPersonalContext;

        const credentialRepository = {
            save: vi
                .fn<CredentialRepository['save']>()
                .mockImplementation(async () => {
                    expect(transactionActive).toBe(true);
                }),
            findByEmail: vi
                .fn<CredentialRepository['findByEmail']>()
                .mockResolvedValue(null),
            findByPersonId: vi.fn<CredentialRepository['findByPersonId']>(),
        } satisfies CredentialRepository;

        const sessionRepository = {
            save: vi
                .fn<SessionRepository['save']>()
                .mockImplementation(async () => {
                    expect(transactionActive).toBe(true);
                }),
            findByTokenHash: vi.fn<SessionRepository['findByTokenHash']>(),
            deleteById: vi.fn<SessionRepository['deleteById']>(),
        } satisfies SessionRepository;

        const passwordHasher = {
            hash: vi
                .fn<PasswordHasher['hash']>()
                .mockImplementation(async () => {
                    expect(transactionActive).toBe(false);
                    return passwordHash;
                }),
            verify: vi.fn<PasswordHasher['verify']>(),
        } satisfies PasswordHasher;

        const sessionTokenGenerator = {
            generate: vi
                .fn<SessionTokenGenerator['generate']>()
                .mockReturnValue({
                    token: sessionToken,
                    tokenHash,
                }),
            hash: vi.fn<SessionTokenGenerator['hash']>(),
        } satisfies SessionTokenGenerator;

        const configService = new ConfigService({
            SESSION_TTL_SECONDS: sessionTtlSeconds,
        });

        const handler = new RegisterAccountHandler(
            unitOfWork,
            provisionPersonalContext,
            credentialRepository,
            sessionRepository,
            passwordHasher,
            sessionTokenGenerator,
            configService,
        );

        const result = await handler.execute({
            displayName: 'Elton',
            email: '  ELTON@EXAMPLE.COM  ', // Intentionally unnormalized to test normalization.
            password,
        });

        expect(executeTransaction).toHaveBeenCalledTimes(1);
        expect(provisionPersonalContext.provision).toHaveBeenCalledTimes(1);
        expect(credentialRepository.save).toHaveBeenCalledTimes(1);
        expect(sessionRepository.save).toHaveBeenCalledTimes(1);

        expect(credentialRepository.findByEmail).toHaveBeenCalledWith(
            'elton@example.com',
        ); // Expect the normalized email.

        expect(passwordHasher.hash).toHaveBeenCalledWith(password);

        const provisionInput =
            provisionPersonalContext.provision.mock.calls[0][0];

        const savedCredential = credentialRepository.save.mock.calls[0][0];
        const savedSession = sessionRepository.save.mock.calls[0][0];

        expect(provisionInput.personId).toBeInstanceOf(PersonId);
        expect(provisionInput.spaceId).toBeInstanceOf(SpaceId);
        expect(provisionInput.displayName).toBe('Elton');

        expect(savedCredential).toEqual({
            personId: provisionInput.personId,
            email: 'elton@example.com',
            passwordHash,
            createdAt: expect.any(Date),
            updatedAt: expect.any(Date),
        });

        expect(savedSession).toEqual({
            id: expect.any(String),
            personId: provisionInput.personId,
            tokenHash,
            createdAt: expect.any(Date),
            expiresAt: new Date(
                savedSession.createdAt.getTime() + sessionTtlSeconds * 1000,
            ),
        });

        expect(result).toEqual({
            sessionToken,
            context: {
                person: {
                    id: provisionInput.personId.value,
                    displayName: 'Elton',
                    email: 'elton@example.com',
                },
                personalSpace: {
                    id: provisionInput.spaceId.value,
                    type: 'PERSONAL',
                    label: 'Meu espaço',
                },
            },
        });

        expect(transactionActive).toBe(false);
    });

    it('propagates provisioning failures and rolls back partial creation', async () => {
        const provisionError = new Error('Personal space provisioning failed');

        const provisionedPersonIds: PersonId[] = [];

        const unitOfWork: UnitOfWork = {
            async execute<T>(work: () => Promise<T>): Promise<T> {
                const previousPersonIds = [...provisionedPersonIds];

                try {
                    return await work();
                } catch (error: unknown) {
                    provisionedPersonIds.splice(
                        0,
                        provisionedPersonIds.length,
                        ...previousPersonIds,
                    );

                    throw error;
                }
            },
        };

        const executeTransaction = vi.spyOn(unitOfWork, 'execute');

        const provisionPersonalContext = {
            provision: vi
                .fn<ProvisionPersonalContext['provision']>()
                .mockImplementation(async (input) => {
                    provisionedPersonIds.push(input.personId);

                    throw provisionError;
                }),
        } satisfies ProvisionPersonalContext;

        const credentialRepository = {
            save: vi.fn<CredentialRepository['save']>(),
            findByEmail: vi
                .fn<CredentialRepository['findByEmail']>()
                .mockResolvedValue(null),
            findByPersonId: vi.fn<CredentialRepository['findByPersonId']>(),
        } satisfies CredentialRepository;

        const sessionRepository = {
            save: vi.fn<SessionRepository['save']>(),
            findByTokenHash: vi.fn<SessionRepository['findByTokenHash']>(),
            deleteById: vi.fn<SessionRepository['deleteById']>(),
        } satisfies SessionRepository;

        const passwordHasher = {
            hash: vi
                .fn<PasswordHasher['hash']>()
                .mockResolvedValue('generated-password-hash'),
            verify: vi.fn<PasswordHasher['verify']>(),
        } satisfies PasswordHasher;

        const sessionTokenGenerator = {
            generate: vi
                .fn<SessionTokenGenerator['generate']>()
                .mockReturnValue({
                    token: 'generated-session-token',
                    tokenHash: Buffer.alloc(32, 1),
                }),
            hash: vi.fn<SessionTokenGenerator['hash']>(),
        } satisfies SessionTokenGenerator;

        const configService = new ConfigService({
            SESSION_TTL_SECONDS: 604800,
        });

        const handler = new RegisterAccountHandler(
            unitOfWork,
            provisionPersonalContext,
            credentialRepository,
            sessionRepository,
            passwordHasher,
            sessionTokenGenerator,
            configService,
        );

        await expect(
            handler.execute({
                displayName: 'Elton',
                email: 'elton@example.com',
                password: 'correct-horse-battery-staple',
            }),
        ).rejects.toBe(provisionError);

        expect(executeTransaction).toHaveBeenCalledTimes(1);
        expect(provisionPersonalContext.provision).toHaveBeenCalledTimes(1);

        expect(provisionedPersonIds).toEqual([]);
        expect(credentialRepository.save).not.toHaveBeenCalled();
        expect(sessionRepository.save).not.toHaveBeenCalled();
    });
});
