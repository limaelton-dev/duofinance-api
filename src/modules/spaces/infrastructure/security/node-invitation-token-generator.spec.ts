import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NodeInvitationTokenGenerator } from './node-invitation-token-generator.js';

describe('NodeInvitationTokenGenerator', () => {
    it('generates 32 bytes encoded as base64url and the token hash', () => {
        const generator = new NodeInvitationTokenGenerator();
        const result = generator.generate();

        expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(Buffer.from(result.token, 'base64url')).toHaveLength(32);
        expect(result.tokenHash).toHaveLength(32);
        expect(result.tokenHash).toEqual(
            createHash('sha256').update(result.token, 'utf8').digest(),
        );
    });

    it('generates independent values', () => {
        const generator = new NodeInvitationTokenGenerator();
        const first = generator.generate();
        const second = generator.generate();

        expect(first.token).not.toBe(second.token);
        expect(first.tokenHash).not.toEqual(second.tokenHash);
    });

    it('finds issued tokens using the same UTF-8 byte hash', () => {
        const generator = new NodeInvitationTokenGenerator();
        const generated = generator.generate();

        expect(generator.hash(generated.token)).toEqual(generated.tokenHash);
        expect(generator.hash(` ${generated.token}`)).not.toEqual(
            generated.tokenHash,
        );
        expect(generator.hash(`${generated.token} `)).not.toEqual(
            generated.tokenHash,
        );
        expect(generator.hash('a'.repeat(43))).not.toEqual(
            generator.hash('A'.repeat(43)),
        );
        expect(generator.hash('a'.repeat(43))).toEqual(
            createHash('sha256').update('a'.repeat(43), 'utf8').digest(),
        );
    });
});
