import { describe, expect, it } from 'vitest';
import { SpacesDomainError } from '../errors/spaces-domain.error.js';
import { PersonId } from '../person/person-id.js';
import { InvitationId } from './invitation-id.js';
import { Invitation, InvitationStatus } from './invitation.js';

const issuedAt = new Date('2026-10-19T12:00:00.000Z');
const cancelledAt = new Date('2026-10-19T13:00:00.000Z');

function pending() {
    return Invitation.issue(
        InvitationId.from('invitation-1'),
        PersonId.from('person-1'),
        issuedAt,
    );
}

describe('Invitation cancellation for space closure', () => {
    it('cancels without replacement and remains idempotent and unusable', () => {
        const original = pending();
        const now = new Date(cancelledAt);
        const cancelled = original.cancelForClosure('process-1', now);
        now.setUTCFullYear(2000);
        cancelled.resolvedAt?.setUTCFullYear(2001);

        expect(cancelled).toMatchObject({
            status: InvitationStatus.CANCELLED,
            cancellationReason: 'SPACE_CLOSURE',
            closureProcessId: 'process-1',
            replacedByInvitationId: null,
        });
        expect(cancelled.resolvedAt).toEqual(cancelledAt);
        expect(
            cancelled.cancelForClosure(
                'process-2',
                new Date('2026-10-20T12:00:00.000Z'),
            ),
        ).toBe(cancelled);
        expect(() => cancelled.accept(cancelledAt)).toThrow(
            new SpacesDomainError('INVITATION_UNAVAILABLE'),
        );
        expect(original.status).toBe(InvitationStatus.PENDING);
        expect(original.closureProcessId).toBeNull();
    });

    it('preserves expiration at the boundary without attributing its history to closure', () => {
        const original = pending();
        const expired = original.cancelForClosure(
            'process-1',
            original.expiresAt,
        );
        expect(expired.status).toBe(InvitationStatus.EXPIRED);
        expect(expired.resolvedAt).toEqual(original.expiresAt);
        expect(expired.cancellationReason).toBeNull();
        expect(expired.closureProcessId).toBeNull();
        expect(expired.cancelForClosure('process-2', expired.expiresAt)).toBe(
            expired,
        );
        expect(original.status).toBe(InvitationStatus.PENDING);
    });

    it('preserves completed replacements and responses', () => {
        const original = pending();
        const replacementId = InvitationId.from('invitation-2');
        const replaced = original.replaceWith(replacementId, cancelledAt);
        expect(replaced.cancelForClosure('process-1', cancelledAt)).toBe(
            replaced,
        );
        expect(replaced.cancellationReason).toBe('REPLACED');
        expect(replaced.replacedByInvitationId).toBe(replacementId);
        expect(replaced.closureProcessId).toBeNull();
        for (const resolved of [
            original.accept(cancelledAt),
            original.reject(cancelledAt),
        ]) {
            expect(resolved.cancelForClosure('process-1', cancelledAt)).toBe(
                resolved,
            );
        }
    });

    it('does not cancel an invitation with a missing process or an invalid time or a time before issuance', () => {
        const original = pending();
        expect(() => original.cancelForClosure('', cancelledAt)).toThrow(
            'Invalid invitation closure cancellation',
        );
        expect(() =>
            original.cancelForClosure(
                'process-1',
                new Date(issuedAt.getTime() - 1),
            ),
        ).toThrow('Invalid invitation closure cancellation');
        expect(() =>
            original.cancelForClosure('process-1', new Date(Number.NaN)),
        ).toThrow('Invalid evaluation time');
        expect(original.status).toBe(InvitationStatus.PENDING);
    });
});
