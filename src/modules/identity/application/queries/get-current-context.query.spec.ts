import { describe, expect, it, vi } from 'vitest';
import { PersonId } from '../../../spaces/domain/person/person-id.js';
import { SpaceId } from '../../../spaces/domain/space/space-id.js';
import type { PersonalContext } from '../../../spaces/application/models/personal-context.js';
import type { GetPersonalContext } from '../../../spaces/application/ports/public/get-personal-context.js';
import { GetCurrentContextQuery } from './get-current-context.query.js';
import type { AuthCredential } from '../models/auth-credential.js';
import type { CredentialRepository } from '../ports/private/credential.repository.js';

function createTestContext() {
    const personId = PersonId.create();

    const credential: AuthCredential = {
        personId,
        email: 'elton@example.com',
        passwordHash: 'hash-that-must-not-be-returned',
        createdAt: new Date('2026-09-01T12:00:00.000Z'),
        updatedAt: new Date('2026-09-01T12:00:00.000Z'),
    };

    const personalContext: PersonalContext = {
        person: {
            id: personId,
            displayName: 'Elton',
        },
        personalSpace: {
            id: SpaceId.create(),
            type: 'PERSONAL',
            label: 'Meu espaço',
        },
    };

    const credentialRepository = {
        save: vi.fn<CredentialRepository['save']>(),
        findByEmail: vi.fn<CredentialRepository['findByEmail']>(),
        findByPersonId: vi
            .fn<CredentialRepository['findByPersonId']>()
            .mockResolvedValue(credential),
    } satisfies CredentialRepository;

    const getPersonalContext = {
        get: vi
            .fn<GetPersonalContext['get']>()
            .mockResolvedValue(personalContext),
    } satisfies GetPersonalContext;

    const query = new GetCurrentContextQuery(
        credentialRepository,
        getPersonalContext,
    );

    return {
        query,
        personId,
        personalContext,
        credentialRepository,
        getPersonalContext,
    };
}

describe('GetCurrentContextQuery', () => {
    it('returns the authenticated context without exposing the password hash', async () => {
        const context = createTestContext();

        await expect(context.query.execute(context.personId)).resolves.toEqual({
            person: {
                id: context.personId.value,
                displayName: 'Elton',
                email: 'elton@example.com',
            },
            personalSpace: {
                id: context.personalContext.personalSpace.id.value,
                type: 'PERSONAL',
                label: 'Meu espaço',
            },
        });

        expect(
            context.credentialRepository.findByPersonId,
        ).toHaveBeenCalledExactlyOnceWith(context.personId);

        expect(context.getPersonalContext.get).toHaveBeenCalledExactlyOnceWith(
            context.personId,
        );
    });

    it('rejects when the person has no credential', async () => {
        const context = createTestContext();

        context.credentialRepository.findByPersonId.mockResolvedValue(null);

        await expect(
            context.query.execute(context.personId),
        ).rejects.toMatchObject({
            message: 'Authenticated person has no credential',
        });

        expect(context.getPersonalContext.get).not.toHaveBeenCalled();
    });

    it('rejects when the personal context does not exist', async () => {
        const context = createTestContext();

        context.getPersonalContext.get.mockResolvedValue(null);

        await expect(
            context.query.execute(context.personId),
        ).rejects.toMatchObject({
            message: 'Authenticated person has no personal context',
        });
    });

    it('propagates credential lookup failures', async () => {
        const context = createTestContext();
        const error = new Error('Credential lookup failed');

        context.credentialRepository.findByPersonId.mockRejectedValue(error);

        await expect(context.query.execute(context.personId)).rejects.toBe(
            error,
        );

        expect(context.getPersonalContext.get).not.toHaveBeenCalled();
    });

    it('propagates personal context lookup failures', async () => {
        const context = createTestContext();
        const error = new Error('Personal context lookup failed');

        context.getPersonalContext.get.mockRejectedValue(error);

        await expect(context.query.execute(context.personId)).rejects.toBe(
            error,
        );
    });
});
